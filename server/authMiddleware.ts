import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { AuthUser, UserRole } from '../src/types/index.ts';
import type { AppDatabase, DbExecutor } from './db.ts';
import type { StorageService } from './storage.ts';
import { hashToken, isAdminRole, isModeratorOrAbove, isUuid } from './security.ts';

export interface AuthenticatedRequest extends Request {
  user?: AuthUser | null;
  db?: AppDatabase;
  storage?: StorageService;
}

export async function getAuthUserFromDb(db: DbExecutor, userId: string): Promise<AuthUser | null> {
  if (!isUuid(userId)) return null;

  const row = await db.queryOne<Record<string, unknown>>(
    `SELECT u.*, uc.email, p.name AS program_name, s.name AS semester_name
     FROM profiles u
     JOIN user_credentials uc ON uc.user_id = u.id
     LEFT JOIN programs p ON p.id = u.program_id
     LEFT JOIN semesters s ON s.id = u.semester_id
     WHERE u.id = $1`,
    [userId]
  );

  if (!row) return null;

  const modRows = await db.query<{ community_id: string }>(
    'SELECT community_id FROM community_moderators WHERE user_id = $1',
    [userId]
  );

  return {
    id: String(row.id),
    email: String(row.email),
    username: String(row.username),
    display_name: String(row.display_name),
    avatar_url: row.avatar_url ? String(row.avatar_url) : null,
    bio: String(row.bio || ''),
    role: row.role as UserRole,
    email_verified: Boolean(row.email_verified),
    university_email_verified: Boolean(row.university_email_verified),
    external_reason: (row.external_reason as AuthUser['external_reason']) || null,
    external_reason_detail: row.external_reason_detail ? String(row.external_reason_detail) : null,
    program_id: row.program_id ? String(row.program_id) : null,
    program_name: row.program_name ? String(row.program_name) : null,
    semester_id: row.semester_id ? String(row.semester_id) : null,
    semester_name: row.semester_name ? String(row.semester_name) : null,
    interests: Array.isArray(row.interests) ? (row.interests as string[]) : [],
    notification_prefs:
      (row.notification_prefs as AuthUser['notification_prefs']) || {
        replies: true,
        connections: true,
        resources: true,
        events: true,
        announcements: true,
      },
    privacy_settings:
      (row.privacy_settings as AuthUser['privacy_settings']) || {
        show_program: true,
        allow_connection_requests: true,
      },
    account_status: (row.account_status as AuthUser['account_status']) || 'active',
    moderated_community_ids: modRows.map((m) => String(m.community_id)),
    created_at: new Date(String(row.created_at)).toISOString(),
  };
}

export function attachSessionMiddleware(db: AppDatabase, storage: StorageService) {
  return async (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
    try {
      req.db = db;
      req.storage = storage;
      req.user = null;

      const authHeader = req.headers.authorization;
      const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : undefined;
      const rawToken = (req.cookies?.gh_session as string | undefined) || bearerToken;
      if (!rawToken) return next();

      const tokenHash = hashToken(rawToken);
      const session = await db.queryOne<{ user_id: string; expires_at: string | Date }>(
        'SELECT user_id, expires_at FROM sessions WHERE token_hash = $1',
        [tokenHash]
      );

      if (!session) return next();
      if (new Date(session.expires_at).getTime() < Date.now()) {
        await db.execute('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
        return next();
      }

      const user = await getAuthUserFromDb(db, String(session.user_id));
      if (user && user.account_status === 'active') {
        req.user = user;
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required. Please sign in.' });
  }
  if (req.user.account_status !== 'active') {
    return res.status(403).json({ error: 'Your account is currently suspended or restricted.' });
  }
  return next();
}

export function requireVerifiedUser(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  if (!req.user.email_verified) {
    return res.status(403).json({ error: 'Please verify your email address before continuing.' });
  }
  return next();
}

export function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  if (!isAdminRole(req.user.role)) {
    return res.status(403).json({ error: 'Administrator privileges required.' });
  }
  return next();
}

export function requireSuperAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  if (req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'Super Admin privileges required.' });
  }
  return next();
}

export function requireModerator(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  if (!isModeratorOrAbove(req.user.role)) {
    return res.status(403).json({ error: 'Moderator or administrator privileges required.' });
  }
  return next();
}

export async function checkRateLimit(
  db: DbExecutor,
  key: string,
  maxRequests: number,
  windowSeconds: number
): Promise<{ allowed: boolean; retryAfterSec: number }> {
  const now = Date.now();
  const row = await db.queryOne<{ count: number; window_expires_at: string | Date }>(
    'SELECT count, window_expires_at FROM rate_limits WHERE key = $1',
    [key]
  );

  if (!row || new Date(row.window_expires_at).getTime() <= now) {
    const expires = new Date(now + windowSeconds * 1000).toISOString();
    await db.execute(
      `INSERT INTO rate_limits (key, count, window_expires_at)
       VALUES ($1, 1, $2::timestamptz)
       ON CONFLICT (key) DO UPDATE SET count = 1, window_expires_at = EXCLUDED.window_expires_at`,
      [key, expires]
    );
    return { allowed: true, retryAfterSec: 0 };
  }

  if (Number(row.count) >= maxRequests) {
    const retryAfterSec = Math.max(
      1,
      Math.ceil((new Date(row.window_expires_at).getTime() - now) / 1000)
    );
    return { allowed: false, retryAfterSec };
  }

  await db.execute('UPDATE rate_limits SET count = count + 1 WHERE key = $1', [key]);
  return { allowed: true, retryAfterSec: 0 };
}

export function isHttpsRequest(req: Request): boolean {
  const proto = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  return req.secure || proto === 'https' || process.env.NODE_ENV === 'production';
}

export async function createSessionCookie(
  db: DbExecutor,
  req: Request,
  res: Response,
  userId: string,
  rawToken: string
): Promise<void> {
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  await db.execute(
    'INSERT INTO sessions (id, token_hash, user_id, expires_at, created_at) VALUES ($1, $2, $3, $4::timestamptz, NOW())',
    [crypto.randomUUID(), tokenHash, userId, expiresAt]
  );

  const isHttps = isHttpsRequest(req);
  res.cookie('gh_session', rawToken, {
    httpOnly: true,
    sameSite: isHttps ? 'none' : 'lax',
    secure: isHttps,
    path: '/',
    maxAge: 7 * 24 * 3600 * 1000,
  });
}

export function clearSessionCookie(req: Request, res: Response): void {
  const isHttps = isHttpsRequest(req);
  res.clearCookie('gh_session', {
    httpOnly: true,
    sameSite: isHttps ? 'none' : 'lax',
    secure: isHttps,
    path: '/',
  });
}
