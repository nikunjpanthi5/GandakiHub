import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import type { DatabaseSync } from 'node:sqlite';
import {
  type AuthenticatedRequest,
  checkRateLimit,
  clearSessionCookie,
  createSessionCookie,
  getAuthUserFromDb,
  requireAuth,
} from '../authMiddleware.ts';
import { indexSearchEntity, writeAuditLog } from '../db.ts';
import {
  generateSessionToken,
  generateSixDigitOtp,
  hashPassword,
  hashToken,
  isUniversityEmail,
  sanitizeFilename,
  verifyPassword,
} from '../security.ts';
import type { UserRole } from '../../src/types/index.ts';

const registerSchema = z.object({
  email: z.string().email().max(160),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128)
    .regex(/[A-Za-z]/, 'Password must include a letter')
    .regex(/[0-9]/, 'Password must include a number'),
  username: z
    .string()
    .min(3)
    .max(30)
    .regex(/^[a-zA-Z0-9_]+$/, 'Username may contain letters, numbers, and underscores only'),
  display_name: z.string().min(2).max(80),
  category: z.enum(['university_member', 'external']),
  member_type: z.enum(['student', 'teacher']).optional(),
  program_id: z.string().nullable().optional(),
  semester_id: z.string().nullable().optional(),
  external_reason: z
    .enum(['future_student', 'parent_guardian', 'university_visitor', 'researcher', 'alumni', 'platform_admin', 'other'])
    .nullable()
    .optional(),
  external_reason_detail: z.string().max(400).nullable().optional(),
  claim_super_admin: z.boolean().optional(),
});

const verifyOtpSchema = z.object({
  email: z.string().email(),
  code: z.string().length(6).regex(/^\d{6}$/),
  purpose: z.enum(['verify_email', 'reset_password']).default('verify_email'),
});

const loginSchema = z
  .object({
    identifier: z.string().min(1).max(160).optional(),
    email: z.string().min(1).max(160).optional(),
    password: z.string().min(1),
  })
  .refine((d) => Boolean((d.identifier || d.email || '').trim()), {
    message: 'Email or username is required.',
  });

const profileUpdateSchema = z.object({
  display_name: z.string().min(2).max(80).optional(),
  bio: z.string().max(500).optional(),
  program_id: z.string().nullable().optional(),
  semester_id: z.string().nullable().optional(),
  interests: z.array(z.string().max(40)).max(12).optional(),
  notification_prefs: z
    .object({
      replies: z.boolean(),
      connections: z.boolean(),
      resources: z.boolean(),
      events: z.boolean(),
      announcements: z.boolean(),
    })
    .optional(),
  privacy_settings: z
    .object({
      show_program: z.boolean(),
      allow_connection_requests: z.boolean(),
    })
    .optional(),
});

async function dispatchOtpEmail(email: string, code: string, purpose: string): Promise<{ deliveredVia: 'resend' | 'dev_console'; devCode?: string }> {
  const resendKey = process.env.RESEND_API_KEY;
  if (resendKey) {
    try {
      const resp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resendKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: process.env.EMAIL_FROM || 'GandakiHub <onboarding@resend.dev>',
          to: [email],
          subject: purpose === 'reset_password' ? 'GandakiHub Password Reset Code' : 'Verify your GandakiHub email address',
          text: `Your 6-digit GandakiHub verification code is: ${code}. It expires in 15 minutes.`,
        }),
      });
      if (resp.ok) {
        return { deliveredVia: 'resend' };
      }
    } catch {
      // Fallback safely to dev log in non-production demo mode
    }
  }
  console.info(`[GandakiHub OTP] ${purpose} for ${email}: ${code}`);
  return {
    deliveredVia: 'dev_console',
    devCode: process.env.NODE_ENV === 'production' ? undefined : code,
  };
}

export function createAuthRouter(db: DatabaseSync): Router {
  const router = Router();

  const avatarDir = path.resolve(process.cwd(), 'storage', 'avatars');
  fs.mkdirSync(avatarDir, { recursive: true });

  const avatarUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 2 * 1024 * 1024 },
  });

  router.get('/me', (req: AuthenticatedRequest, res) => {
    res.json({ user: req.user ?? null });
  });

  router.get('/bootstrap-status', (_req, res) => {
    const superCount = (
      db.prepare("SELECT COUNT(*) as cnt FROM users WHERE role = 'super_admin' AND email_verified = 1").get() as { cnt: number }
    ).cnt;
    res.json({
      needsSuperAdmin: superCount === 0,
      superAdminEmailConfigured: Boolean(process.env.SUPER_ADMIN_EMAIL),
    });
  });

  router.post('/register', async (req, res) => {
    const ipKey = `reg:${req.ip || 'local'}`;
    const rl = checkRateLimit(db, ipKey, 15, 900);
    if (!rl.allowed) {
      return res.status(429).json({ error: `Too many registration attempts. Retry in ${rl.retryAfterSec}s.` });
    }

    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid registration data.' });
    }

    const data = parsed.data;
    const normalizedEmail = data.email.trim().toLowerCase();
    const normalizedUsername = data.username.trim().toLowerCase();

    if (data.category === 'university_member' && !isUniversityEmail(normalizedEmail)) {
      return res.status(400).json({
        error: 'University members must register with a @gandakiuniversity.edu.np email address.',
      });
    }

    const superCountNow = (
      db.prepare("SELECT COUNT(*) as cnt FROM users WHERE role = 'super_admin' AND email_verified = 1").get() as { cnt: number }
    ).cnt;
    const envSuperEmailEarly = process.env.SUPER_ADMIN_EMAIL?.trim().toLowerCase();

    if (data.category === 'external') {
      if (!data.external_reason) {
        return res.status(400).json({ error: 'Please select your reason for joining GandakiHub.' });
      }
      if (data.external_reason === 'platform_admin') {
        if (superCountNow > 0) {
          return res.status(403).json({
            error: 'A Super Admin account already exists. Ask the Super Admin to assign administrator roles.',
          });
        }
        if (envSuperEmailEarly && envSuperEmailEarly !== normalizedEmail) {
          return res.status(403).json({
            error: 'Only the configured Super Admin email can register with Platform Admin setup.',
          });
        }
      }
      if (data.external_reason === 'other' && (!data.external_reason_detail || data.external_reason_detail.trim().length < 5)) {
        return res.status(400).json({ error: 'Please provide a brief explanation when selecting "Other".' });
      }
    }

    const existingByEmail = db
      .prepare('SELECT id, email_verified FROM users WHERE lower(email) = ?')
      .get(normalizedEmail) as { id: string; email_verified: number } | undefined;

    if (existingByEmail) {
      if (!existingByEmail.email_verified) {
        return res.status(409).json({
          error: 'An account with this email already exists and is awaiting verification. Sign in or verify your code.',
          requiresVerification: true,
          email: normalizedEmail,
        });
      }
      return res.status(409).json({
        error: 'An account with this email address already exists. One email can only have one account.',
      });
    }

    const existingByUsername = db
      .prepare('SELECT id FROM users WHERE lower(username) = ?')
      .get(normalizedUsername) as { id: string } | undefined;

    if (existingByUsername) {
      return res.status(409).json({ error: 'This username is already taken.' });
    }

    // Server-determined initial role: never trust client-provided admin roles!
    // Until OTP verification succeeds, email_verified = 0 and role starts safely as 'visitor'
    // or pending external role; full university role is granted ONLY upon OTP verification.
    let initialRole: UserRole = 'visitor';
    if (data.category === 'external') {
      if (data.external_reason === 'future_student') initialRole = 'future_student';
      else if (data.external_reason === 'alumni') initialRole = 'alumni';
      else initialRole = 'visitor';
    }

    const userId = crypto.randomUUID();
    const now = new Date().toISOString();
    const passHash = hashPassword(data.password);

    try {
      db.prepare(
        `INSERT INTO users (id, email, password_hash, username, display_name, bio, role, email_verified, university_email_verified, external_reason, external_reason_detail, program_id, semester_id, interests_json, account_status, is_demo, created_at)
         VALUES (?, ?, ?, ?, ?, '', ?, 0, 0, ?, ?, ?, ?, '[]', 'active', 0, ?)`
      ).run(
        userId,
        normalizedEmail,
        passHash,
        normalizedUsername,
        data.display_name.trim(),
        initialRole,
        data.category === 'external' ? data.external_reason ?? null : null,
        data.category === 'external' ? data.external_reason_detail?.trim() ?? null : null,
        data.category === 'university_member' ? data.program_id ?? null : null,
        data.category === 'university_member' ? data.semester_id ?? null : null,
        now
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('UNIQUE constraint')) {
        return res.status(409).json({
          error: 'An account with this email address or username already exists.',
        });
      }
      throw err;
    }

    // Store intended university member type in audit metadata until verified
    writeAuditLog(db, userId, 'user_registered', 'user', userId, {
      category: data.category,
      intended_member_type: data.member_type || 'student',
    });

    const otp = generateSixDigitOtp();
    const resendAfter = new Date(Date.now() + 60 * 1000).toISOString();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    db.prepare(
      'INSERT INTO otp_codes (id, email, purpose, code_hash, attempts, resend_after, expires_at, created_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)'
    ).run(crypto.randomUUID(), normalizedEmail, 'verify_email', hashToken(otp), resendAfter, expiresAt, now);

    // Store intended member/owner verification preference until OTP completes
    const envSuperEmail = process.env.SUPER_ADMIN_EMAIL?.trim().toLowerCase();
    const wantsSuperAdmin = Boolean(data.claim_super_admin) || data.external_reason === 'platform_admin';
    const canClaimSuperAdmin =
      superCountNow === 0 &&
      ((envSuperEmail && envSuperEmail === normalizedEmail) || (!envSuperEmail && wantsSuperAdmin));

    if (canClaimSuperAdmin) {
      db.prepare('UPDATE users SET external_reason_detail = ? WHERE id = ?').run('pending_super_admin_claim', userId);
    } else if (data.category === 'university_member' && data.member_type === 'teacher') {
      db.prepare('UPDATE users SET external_reason_detail = ? WHERE id = ?').run('pending_teacher_verification', userId);
    }

    const delivery = await dispatchOtpEmail(normalizedEmail, otp, 'verify_email');

    return res.status(201).json({
      message: 'Account created. Enter the 6-digit verification code sent to your email.',
      email: normalizedEmail,
      requiresVerification: true,
      resendCooldownSeconds: 60,
      devOtpPreview: delivery.devCode,
    });
  });

  router.post('/verify-otp', (req, res) => {
    const parsed = verifyOtpSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Please enter a valid email and 6-digit code.' });
    }
    const email = parsed.data.email.trim().toLowerCase();
    const { code, purpose } = parsed.data;

    const rl = checkRateLimit(db, `otp_verify:${email}`, 10, 900);
    if (!rl.allowed) {
      return res.status(429).json({ error: `Too many verification attempts. Try again in ${rl.retryAfterSec}s.` });
    }

    const otpRow = db
      .prepare(
        `SELECT * FROM otp_codes
         WHERE email = ? AND purpose = ? AND used_at IS NULL
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(email, purpose) as Record<string, unknown> | undefined;

    if (!otpRow) {
      return res.status(400).json({ error: 'No active verification code found. Please request a new code.' });
    }
    if (new Date(String(otpRow.expires_at)).getTime() < Date.now()) {
      return res.status(400).json({ error: 'Verification code has expired. Please request a new one.' });
    }
    if (Number(otpRow.attempts) >= 5) {
      return res.status(429).json({ error: 'Maximum code attempts exceeded. Request a fresh code.' });
    }

    if (hashToken(code) !== String(otpRow.code_hash)) {
      db.prepare('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?').run(String(otpRow.id));
      return res.status(400).json({ error: 'Incorrect 6-digit verification code.' });
    }

    db.prepare('UPDATE otp_codes SET used_at = ? WHERE id = ?').run(new Date().toISOString(), String(otpRow.id));

    const userRow = db
      .prepare('SELECT * FROM users WHERE lower(email) = ?')
      .get(email) as Record<string, unknown> | undefined;

    if (!userRow) {
      return res.status(404).json({ error: 'User account not found.' });
    }

    if (purpose === 'verify_email') {
      const isUni = isUniversityEmail(email);
      let assignedRole = String(userRow.role) as UserRole;
      let cleanDetail = userRow.external_reason_detail;

      const superCount = (
        db.prepare("SELECT COUNT(*) as cnt FROM users WHERE role = 'super_admin' AND email_verified = 1").get() as { cnt: number }
      ).cnt;
      const envSuperEmail = process.env.SUPER_ADMIN_EMAIL?.trim().toLowerCase();

      if (
        superCount === 0 &&
        ((envSuperEmail && envSuperEmail === email) ||
          (!envSuperEmail && userRow.external_reason_detail === 'pending_super_admin_claim'))
      ) {
        assignedRole = 'super_admin';
        cleanDetail = null;
      } else if (isUni) {
        assignedRole =
          userRow.external_reason_detail === 'pending_teacher_verification'
            ? 'verified_teacher'
            : 'verified_student';
        cleanDetail = null;
      }

      db.prepare(
        'UPDATE users SET email_verified = 1, university_email_verified = ?, role = ?, external_reason_detail = ? WHERE id = ?'
      ).run(isUni ? 1 : 0, assignedRole, cleanDetail ? String(cleanDetail) : null, String(userRow.id));

      if (assignedRole !== 'admin' && assignedRole !== 'super_admin') {
        indexSearchEntity(
          db,
          'user',
          String(userRow.id),
          String(userRow.display_name),
          `${userRow.username} ${userRow.bio || ''}`,
          assignedRole
        );
      }

      writeAuditLog(db, String(userRow.id), 'email_verified', 'user', String(userRow.id), {
        university_email_verified: isUni,
        assigned_role: assignedRole,
      });

      const token = generateSessionToken();
      createSessionCookie(db, req, res, String(userRow.id), token);
      return res.json({
        verified: true,
        user: getAuthUserFromDb(db, String(userRow.id)),
        sessionToken: token,
      });
    }

    return res.json({ verified: true, message: 'Code verified. You may now set a new password.' });
  });

  router.post('/resend-otp', async (req, res) => {
    const parsed = z.object({ email: z.string().email(), purpose: z.enum(['verify_email', 'reset_password']).default('verify_email') }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Valid email is required.' });

    const email = parsed.data.email.trim().toLowerCase();
    const userRow = db.prepare('SELECT id FROM users WHERE lower(email) = ?').get(email);
    if (!userRow) {
      return res.status(404).json({ error: 'No account found with that email address.' });
    }

    const latest = db
      .prepare('SELECT resend_after FROM otp_codes WHERE email = ? AND purpose = ? ORDER BY created_at DESC LIMIT 1')
      .get(email, parsed.data.purpose) as { resend_after: string } | undefined;

    if (latest && new Date(latest.resend_after).getTime() > Date.now()) {
      const waitSec = Math.ceil((new Date(latest.resend_after).getTime() - Date.now()) / 1000);
      return res.status(429).json({ error: `Please wait ${waitSec}s before requesting another code.`, retryAfterSec: waitSec });
    }

    const rl = checkRateLimit(db, `otp_send:${email}`, 5, 3600);
    if (!rl.allowed) {
      return res.status(429).json({ error: `Hourly OTP limit reached. Try again in ${rl.retryAfterSec}s.` });
    }

    const otp = generateSixDigitOtp();
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO otp_codes (id, email, purpose, code_hash, attempts, resend_after, expires_at, created_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)'
    ).run(
      crypto.randomUUID(),
      email,
      parsed.data.purpose,
      hashToken(otp),
      new Date(Date.now() + 60 * 1000).toISOString(),
      new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      now
    );

    const delivery = await dispatchOtpEmail(email, otp, parsed.data.purpose);
    return res.json({
      message: 'A fresh 6-digit verification code has been issued.',
      resendCooldownSeconds: 60,
      devOtpPreview: delivery.devCode,
    });
  });

  router.post('/request-password-reset', async (req, res) => {
    const parsed = z.object({ email: z.string().email() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Valid email is required.' });
    const email = parsed.data.email.trim().toLowerCase();

    const rl = checkRateLimit(db, `pwd_reset:${email}`, 5, 3600);
    if (!rl.allowed) {
      return res.status(429).json({ error: `Too many reset requests. Retry in ${rl.retryAfterSec}s.` });
    }

    const userRow = db.prepare('SELECT id FROM users WHERE lower(email) = ?').get(email);
    if (!userRow) {
      return res.json({ message: 'If an account matches that email, a 6-digit reset code has been sent.' });
    }

    const otp = generateSixDigitOtp();
    db.prepare(
      'INSERT INTO otp_codes (id, email, purpose, code_hash, attempts, resend_after, expires_at, created_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)'
    ).run(
      crypto.randomUUID(),
      email,
      'reset_password',
      hashToken(otp),
      new Date(Date.now() + 60 * 1000).toISOString(),
      new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      new Date().toISOString()
    );

    const delivery = await dispatchOtpEmail(email, otp, 'reset_password');
    return res.json({
      message: 'If an account matches that email, a 6-digit reset code has been sent.',
      devOtpPreview: delivery.devCode,
    });
  });

  router.post('/reset-password', (req, res) => {
    const parsed = z
      .object({
        email: z.string().email(),
        code: z.string().length(6).regex(/^\d{6}$/),
        new_password: z.string().min(8).max(128).regex(/[A-Za-z]/).regex(/[0-9]/),
      })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid reset fields.' });

    const email = parsed.data.email.trim().toLowerCase();
    const otpRow = db
      .prepare('SELECT * FROM otp_codes WHERE email = ? AND purpose = ? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1')
      .get(email, 'reset_password') as Record<string, unknown> | undefined;

    if (!otpRow || new Date(String(otpRow.expires_at)).getTime() < Date.now() || hashToken(parsed.data.code) !== String(otpRow.code_hash)) {
      return res.status(400).json({ error: 'Invalid or expired password reset code.' });
    }

    db.prepare('UPDATE otp_codes SET used_at = ? WHERE id = ?').run(new Date().toISOString(), String(otpRow.id));
    db.prepare('UPDATE users SET password_hash = ? WHERE lower(email) = ?').run(
      hashPassword(parsed.data.new_password),
      email
    );
    // Invalidate existing sessions for security
    const u = db.prepare('SELECT id FROM users WHERE lower(email) = ?').get(email) as { id: string } | undefined;
    if (u) {
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
      writeAuditLog(db, u.id, 'password_reset', 'user', u.id, {});
    }

    return res.json({ message: 'Password updated successfully. Please sign in with your new password.' });
  });

  router.post('/login', async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Email or username and password are required.' });

    const identifier = (parsed.data.identifier ?? parsed.data.email ?? '').trim().toLowerCase();
    const rl = checkRateLimit(db, `login:${identifier}`, 12, 900);
    if (!rl.allowed) {
      return res.status(429).json({ error: `Too many login attempts. Retry in ${rl.retryAfterSec}s.` });
    }

    const row = db
      .prepare('SELECT * FROM users WHERE lower(email) = ? OR lower(username) = ?')
      .get(identifier, identifier) as Record<string, unknown> | undefined;
    if (!row || !verifyPassword(parsed.data.password, String(row.password_hash))) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }
    if (row.account_status !== 'active') {
      return res.status(403).json({ error: 'Your account has been suspended. Contact campus moderation.' });
    }
    if (!row.email_verified) {
      const userEmail = String(row.email).toLowerCase();
      const otp = generateSixDigitOtp();
      const now = new Date().toISOString();
      db.prepare(
        'INSERT INTO otp_codes (id, email, purpose, code_hash, attempts, resend_after, expires_at, created_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)'
      ).run(
        crypto.randomUUID(),
        userEmail,
        'verify_email',
        hashToken(otp),
        new Date(Date.now() + 60 * 1000).toISOString(),
        new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        now
      );
      const delivery = await dispatchOtpEmail(userEmail, otp, 'verify_email');
      return res.status(403).json({
        error: 'Email verification pending. Enter the 6-digit verification code sent to your email.',
        requiresVerification: true,
        email: userEmail,
        devOtpPreview: delivery.devCode,
      });
    }

    const token = generateSessionToken();
    createSessionCookie(db, req, res, String(row.id), token);
    return res.json({
      user: getAuthUserFromDb(db, String(row.id)),
      sessionToken: token,
    });
  });

  router.post('/logout', (req: AuthenticatedRequest, res) => {
    const authHeader = req.headers.authorization;
    const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : undefined;
    const rawToken = (req.cookies?.gh_session as string | undefined) || bearerToken;
    if (rawToken) {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(rawToken));
    }
    clearSessionCookie(req, res);
    return res.json({ ok: true });
  });

  router.patch('/profile', requireAuth, (req: AuthenticatedRequest, res) => {
    const parsed = profileUpdateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid profile fields.' });

    const u = req.user!;
    const d = parsed.data;

    db.prepare(
      `UPDATE users SET
        display_name = COALESCE(?, display_name),
        bio = COALESCE(?, bio),
        program_id = ?,
        semester_id = ?,
        interests_json = COALESCE(?, interests_json),
        notification_prefs_json = COALESCE(?, notification_prefs_json),
        privacy_settings_json = COALESCE(?, privacy_settings_json)
       WHERE id = ?`
    ).run(
      d.display_name?.trim() ?? null,
      d.bio !== undefined ? d.bio.trim() : null,
      d.program_id !== undefined ? d.program_id : u.program_id,
      d.semester_id !== undefined ? d.semester_id : u.semester_id,
      d.interests ? JSON.stringify(d.interests) : null,
      d.notification_prefs ? JSON.stringify(d.notification_prefs) : null,
      d.privacy_settings ? JSON.stringify(d.privacy_settings) : null,
      u.id
    );

    const updated = getAuthUserFromDb(db, u.id)!;
    if (updated.role !== 'admin' && updated.role !== 'super_admin') {
      indexSearchEntity(db, 'user', updated.id, updated.display_name, `${updated.username} ${updated.bio}`, updated.role);
    }
    return res.json({ user: updated });
  });

  router.post('/profile/avatar', requireAuth, avatarUpload.single('avatar'), (req: AuthenticatedRequest, res) => {
    if (!req.file) return res.status(400).json({ error: 'Please select an image file (PNG or JPEG, max 2MB).' });
    const buf = req.file.buffer;
    const isPng = buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
    const isJpg = buf.subarray(0, 3).toString('hex') === 'ffd8ff';
    if (!isPng && !isJpg) {
      return res.status(400).json({ error: 'Only valid PNG or JPEG images are allowed for profile avatars.' });
    }

    const ext = isPng ? 'png' : 'jpg';
    const safeName = `${req.user!.id}_${Date.now()}_${sanitizeFilename(req.file.originalname).replace(/\.[^.]+$/, '')}.${ext}`;
    fs.writeFileSync(path.join(avatarDir, safeName), buf);
    const avatarUrl = `/api/auth/avatars/${safeName}`;
    db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run(avatarUrl, req.user!.id);
    return res.json({ avatar_url: avatarUrl, user: getAuthUserFromDb(db, req.user!.id) });
  });

  router.get('/avatars/:filename', (req, res) => {
    const safe = path.basename(req.params.filename);
    const full = path.join(avatarDir, safe);
    if (!fs.existsSync(full)) return res.status(404).end();
    return res.sendFile(full);
  });

  // Public profile lookup (respecting privacy: never exposes email or private connection list!)
  router.get('/users/:username', (req: AuthenticatedRequest, res) => {
    const row = db
      .prepare(
        `SELECT u.id, u.username, u.display_name, u.avatar_url, u.bio, u.role,
                u.university_email_verified, u.email_verified, u.program_id, u.semester_id,
                u.interests_json, u.privacy_settings_json, u.account_status, u.created_at, u.is_demo,
                p.name as program_name, s.name as semester_name
         FROM users u
         LEFT JOIN programs p ON p.id = u.program_id
         LEFT JOIN semesters s ON s.id = u.semester_id
         WHERE lower(u.username) = ?`
      )
      .get(req.params.username.toLowerCase()) as Record<string, unknown> | undefined;

    if (!row) return res.status(404).json({ error: 'User profile not found.' });

    const privacy = JSON.parse(String(row.privacy_settings_json || '{"show_program":true}'));
    const isSelf = req.user?.id === String(row.id);

    const posts = db
      .prepare(
        `SELECT p.id, p.title, p.created_at, p.upvote_count, p.comment_count, c.name as community_name, c.slug as community_slug
         FROM posts p JOIN communities c ON c.id = p.community_id
         WHERE p.author_id = ? AND p.is_hidden = 0
         ORDER BY p.created_at DESC LIMIT 20`
      )
      .all(String(row.id));

    const resources = db
      .prepare(
        `SELECT r.id, r.title, r.status, r.download_count, r.upvote_count, r.created_at, sub.name as subject_name, rc.name as category_name
         FROM resources r
         JOIN subjects sub ON sub.id = r.subject_id
         JOIN resource_categories rc ON rc.id = r.category_id
         WHERE r.uploader_id = ? ${isSelf ? '' : "AND r.status = 'approved'"}
         ORDER BY r.created_at DESC LIMIT 20`
      )
      .all(String(row.id));

    return res.json({
      profile: {
        id: row.id,
        username: row.username,
        display_name: row.display_name,
        avatar_url: row.avatar_url,
        bio: row.bio,
        role: row.role,
        university_email_verified: Boolean(row.university_email_verified),
        email_verified: Boolean(row.email_verified),
        program_id: privacy.show_program || isSelf ? row.program_id : null,
        program_name: privacy.show_program || isSelf ? row.program_name : null,
        semester_id: privacy.show_program || isSelf ? row.semester_id : null,
        semester_name: privacy.show_program || isSelf ? row.semester_name : null,
        interests: JSON.parse(String(row.interests_json || '[]')),
        account_status: row.account_status,
        created_at: row.created_at,
        is_demo: Boolean(row.is_demo),
      },
      posts,
      resources,
    });
  });

  return router;
}
