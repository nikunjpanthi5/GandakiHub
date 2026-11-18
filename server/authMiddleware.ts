import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import type { AuthUser, UserRole } from '../src/types/index.ts';
import { hashToken, isAdminRole, isModeratorOrAbove } from './security.ts';

export interface AuthenticatedRequest extends Request {
  user?: AuthUser | null;
  db?: DatabaseSync;
}

export function getAuthUserFromDb(db: DatabaseSync, userId: string): AuthUser | null {
  const row = db
    .prepare(
      `SELECT u.*, p.name as program_name, s.name as semester_name
       FROM users u
       LEFT JOIN programs p ON p.id = u.program_id
       LEFT JOIN semesters s ON s.id = u.semester_id
       WHERE u.id = ?`
    )
    .get(userId) as Record<string, unknown> | undefined;

  if (!row) return null;

  const modRows = db
    .prepare('SELECT community_id FROM community_moderators WHERE user_id = ?')
    .all(userId) as Array<{ community_id: string }>;

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
    interests: safeJsonParse(String(row.interests_json || '[]'), []),
    notification_prefs: safeJsonParse(String(row.notification_prefs_json || '{}'), {
      replies: true,
      connections: true,
      resources: true,
      events: true,
      announcements: true,
    }),
    privacy_settings: safeJsonParse(String(row.privacy_settings_json || '{}'), {
      show_program: true,
      allow_connection_requests: true,
    }),
    account_status: (row.account_status as AuthUser['account_status']) || 'active',
    moderated_community_ids: modRows.map((m) => m.community_id),
    created_at: String(row.created_at),
    is_demo: Boolean(row.is_demo),
  };
}

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function attachSessionMiddleware(db: DatabaseSync) {
  return (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
    req.db = db;
    req.user = null;
    const authHeader = req.headers.authorization;
    const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : undefined;
    const rawToken = (req.cookies?.gh_session as string | undefined) || bearerToken;
    if (!rawToken) return next();

    const tokenHash = hashToken(rawToken);
    const session = db
      .prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?')
      .get(tokenHash) as { user_id: string; expires_at: string } | undefined;

    if (!session) return next();
    if (new Date(session.expires_at).getTime() < Date.now()) {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
      return next();
    }

    const user = getAuthUserFromDb(db, session.user_id);
    if (user && user.account_status === 'active') {
      req.user = user;
    }
    return next();
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

export function checkRateLimit(
  db: DatabaseSync,
  key: string,
  maxRequests: number,
  windowSeconds: number
): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now();
  const row = db
    .prepare('SELECT count, window_expires_at FROM rate_limits WHERE key = ?')
    .get(key) as { count: number; window_expires_at: string } | undefined;

  if (!row || new Date(row.window_expires_at).getTime() <= now) {
    const expires = new Date(now + windowSeconds * 1000).toISOString();
    db.prepare(
      'INSERT OR REPLACE INTO rate_limits (key, count, window_expires_at) VALUES (?, 1, ?)'
    ).run(key, expires);
    return { allowed: true, retryAfterSec: 0 };
  }

  if (row.count >= maxRequests) {
    const retryAfterSec = Math.max(
      1,
      Math.ceil((new Date(row.window_expires_at).getTime() - now) / 1000)
    );
    return { allowed: false, retryAfterSec };
  }

  db.prepare('UPDATE rate_limits SET count = count + 1 WHERE key = ?').run(key);
  return { allowed: true, retryAfterSec: 0 };
}

export function isHttpsRequest(req: Request): boolean {
  const proto = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  return req.secure || proto === 'https' || process.env.NODE_ENV === 'production';
}

export function createSessionCookie(
  db: DatabaseSync,
  req: Request,
  res: Response,
  userId: string,
  rawToken: string
): void {
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  db.prepare(
    'INSERT INTO sessions (id, token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(crypto.randomUUID(), tokenHash, userId, expiresAt, new Date().toISOString());

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
