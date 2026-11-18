import crypto from 'node:crypto';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import {
  type AuthenticatedRequest,
  checkRateLimit,
  clearSessionCookie,
  createSessionCookie,
  getAuthUserFromDb,
  requireAuth,
} from '../authMiddleware.ts';
import { type AppDatabase, writeAuditLog } from '../db.ts';
import { dispatchOtpEmail } from '../email.ts';
import {
  generateSessionToken,
  generateSixDigitOtp,
  hashPassword,
  hashToken,
  isUniversityEmail,
  isUuid,
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

function getConfiguredSuperAdminEmail(): string | null {
  const val = process.env.SUPER_ADMIN_EMAIL?.trim().toLowerCase();
  return val && val.includes('@') ? val : null;
}

export function createAuthRouter(db: AppDatabase): Router {
  const router = Router();

  const avatarUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 2 * 1024 * 1024 },
  });

  router.get('/me', (req: AuthenticatedRequest, res) => {
    res.json({ user: req.user ?? null });
  });

  router.get('/bootstrap-status', async (_req, res, next) => {
    try {
      const superRow = await db.queryOne<{ cnt: string | number }>(
        "SELECT COUNT(*) AS cnt FROM profiles WHERE role = 'super_admin' AND email_verified = TRUE"
      );
      const initSetting = await db.queryOne<{ value: string }>(
        "SELECT value FROM platform_settings WHERE key = 'super_admin_initialized'"
      );
      const needsSuperAdmin =
        Number(superRow?.cnt || 0) === 0 && initSetting?.value !== 'true';
      const superAdminEmailConfigured = Boolean(getConfiguredSuperAdminEmail());
      res.json({
        needsSuperAdmin,
        superAdminEmailConfigured,
        configurationError:
          needsSuperAdmin && !superAdminEmailConfigured
            ? 'SUPER_ADMIN_EMAIL is not configured on the server. First-time Super Admin bootstrap requires SUPER_ADMIN_EMAIL to be set.'
            : null,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/register', async (req: AuthenticatedRequest, res, next) => {
    try {
      const ipKey = `reg:${req.ip || 'local'}`;
      const rl = await checkRateLimit(db, ipKey, 15, 900);
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
      const envSuperEmail = getConfiguredSuperAdminEmail();

      if (data.category === 'university_member' && !isUniversityEmail(normalizedEmail)) {
        return res.status(400).json({
          error: 'University members must register with a @gandakiuniversity.edu.np email address.',
        });
      }

      const superRow = await db.queryOne<{ cnt: string | number }>(
        "SELECT COUNT(*) AS cnt FROM profiles WHERE role = 'super_admin' AND email_verified = TRUE"
      );
      const initSetting = await db.queryOne<{ value: string }>(
        "SELECT value FROM platform_settings WHERE key = 'super_admin_initialized'"
      );
      const superAlreadyInitialized =
        Number(superRow?.cnt || 0) > 0 || initSetting?.value === 'true';

      const wantsSuperAdmin = Boolean(data.claim_super_admin) || data.external_reason === 'platform_admin';

      if (wantsSuperAdmin) {
        if (!envSuperEmail) {
          return res.status(503).json({
            error: 'SUPER_ADMIN_EMAIL is not configured on the server. Super Admin setup cannot proceed.',
          });
        }
        if (superAlreadyInitialized) {
          return res.status(403).json({
            error: 'A Super Admin account already exists. Ask the Super Admin to assign administrator roles.',
          });
        }
        if (envSuperEmail !== normalizedEmail) {
          return res.status(403).json({
            error: 'Only the configured SUPER_ADMIN_EMAIL address can complete initial Super Admin setup.',
          });
        }
      }

      if (data.category === 'external') {
        if (!data.external_reason) {
          return res.status(400).json({ error: 'Please select your reason for joining GandakiHub.' });
        }
        if (
          data.external_reason === 'other' &&
          (!data.external_reason_detail || data.external_reason_detail.trim().length < 5)
        ) {
          return res.status(400).json({ error: 'Please provide a brief explanation when selecting "Other".' });
        }
      }

      const cleanProgramId =
        data.category === 'university_member' && isUuid(data.program_id) ? data.program_id : null;
      const cleanSemesterId =
        data.category === 'university_member' && isUuid(data.semester_id) ? data.semester_id : null;

      const existingByEmail = await db.queryOne<{ user_id: string; email_verified: boolean }>(
        `SELECT uc.user_id, p.email_verified
         FROM user_credentials uc
         JOIN profiles p ON p.id = uc.user_id
         WHERE lower(uc.email) = $1`,
        [normalizedEmail]
      );

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

      const existingByUsername = await db.queryOne<{ id: string }>(
        'SELECT id FROM profiles WHERE lower(username) = $1',
        [normalizedUsername]
      );
      if (existingByUsername) {
        return res.status(409).json({ error: 'This username is already taken.' });
      }

      let initialRole: UserRole = 'visitor';
      if (data.category === 'external') {
        if (data.external_reason === 'future_student') initialRole = 'future_student';
        else if (data.external_reason === 'alumni') initialRole = 'alumni';
        else initialRole = 'visitor';
      }

      const userId = crypto.randomUUID();
      const passHash = hashPassword(data.password);
      const otp = generateSixDigitOtp();
      const resendAfter = new Date(Date.now() + 60 * 1000).toISOString();
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

      const canClaimSuperAdmin =
        !superAlreadyInitialized && Boolean(envSuperEmail && envSuperEmail === normalizedEmail);

      let pendingDetail: string | null =
        data.category === 'external' ? data.external_reason_detail?.trim() ?? null : null;
      if (canClaimSuperAdmin) {
        pendingDetail = 'pending_super_admin_claim';
      } else if (data.category === 'university_member' && data.member_type === 'teacher') {
        pendingDetail = 'pending_teacher_verification';
      }

      try {
        await db.transaction(
          async (tx) => {
            await tx.execute(
              `INSERT INTO profiles (id, username, display_name, bio, role, email_verified, university_email_verified, external_reason, external_reason_detail, program_id, semester_id, interests, account_status, created_at, updated_at)
               VALUES ($1, $2, $3, '', $4::user_role, FALSE, FALSE, $5, $6, $7, $8, '{}', 'active', NOW(), NOW())`,
              [
                userId,
                normalizedUsername,
                data.display_name.trim(),
                initialRole,
                data.category === 'external' ? data.external_reason ?? null : null,
                pendingDetail,
                cleanProgramId,
                cleanSemesterId,
              ]
            );

            await tx.execute(
              `INSERT INTO user_credentials (user_id, email, password_hash, created_at, updated_at)
               VALUES ($1, $2, $3, NOW(), NOW())`,
              [userId, normalizedEmail, passHash]
            );

            await tx.execute(
              `INSERT INTO user_roles (id, user_id, role, granted_by, reason, created_at)
               VALUES ($1, $2, $3::user_role, NULL, 'Initial registration (pending OTP verification)', NOW())`,
              [crypto.randomUUID(), userId, initialRole]
            );

            await tx.execute(
              `INSERT INTO otp_codes (id, email, purpose, code_hash, attempts, resend_after, expires_at, created_at)
               VALUES ($1, $2, 'verify_email', $3, 0, $4::timestamptz, $5::timestamptz, NOW())`,
              [crypto.randomUUID(), normalizedEmail, hashToken(otp), resendAfter, expiresAt]
            );

            await writeAuditLog(tx, userId, 'user_registered', 'user', userId, {
              category: data.category,
              intended_member_type: data.member_type || 'student',
            });
          },
          { trustedServer: true }
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : '';
        if (msg.toLowerCase().includes('unique')) {
          return res.status(409).json({
            error: 'An account with this email address or username already exists.',
          });
        }
        throw err;
      }

      const delivery = await dispatchOtpEmail(normalizedEmail, otp, 'verify_email');

      return res.status(201).json({
        message: 'Account created. Enter the 6-digit verification code sent to your email.',
        email: normalizedEmail,
        requiresVerification: true,
        resendCooldownSeconds: 60,
        ...(delivery.devCode ? { devOtpPreview: delivery.devCode } : {}),
      });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/verify-otp', async (req: AuthenticatedRequest, res, next) => {
    try {
      const parsed = verifyOtpSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Please enter a valid email and 6-digit code.' });
      }
      const email = parsed.data.email.trim().toLowerCase();
      const { code, purpose } = parsed.data;

      const rl = await checkRateLimit(db, `otp_verify:${email}`, 10, 900);
      if (!rl.allowed) {
        return res.status(429).json({ error: `Too many verification attempts. Try again in ${rl.retryAfterSec}s.` });
      }

      const otpRow = await db.queryOne<{
        id: string;
        code_hash: string;
        attempts: number;
        expires_at: string | Date;
      }>(
        `SELECT id, code_hash, attempts, expires_at
         FROM otp_codes
         WHERE lower(email) = $1 AND purpose = $2 AND used_at IS NULL
         ORDER BY created_at DESC LIMIT 1`,
        [email, purpose]
      );

      if (!otpRow) {
        return res.status(400).json({ error: 'No active verification code found. Please request a new code.' });
      }
      if (new Date(otpRow.expires_at).getTime() < Date.now()) {
        return res.status(400).json({ error: 'Verification code has expired. Please request a new one.' });
      }
      if (Number(otpRow.attempts) >= 5) {
        return res.status(429).json({ error: 'Maximum code attempts exceeded. Request a fresh code.' });
      }

      if (hashToken(code) !== String(otpRow.code_hash)) {
        await db.execute('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1', [otpRow.id]);
        return res.status(400).json({ error: 'Incorrect 6-digit verification code.' });
      }

      if (purpose === 'reset_password') {
        await db.execute('UPDATE otp_codes SET used_at = NOW() WHERE id = $1', [otpRow.id]);
        return res.json({ verified: true, message: 'Code verified. You may now set a new password.' });
      }

      const envSuperEmail = getConfiguredSuperAdminEmail();
      const token = generateSessionToken();

      const result = await db.transaction(
        async (tx) => {
          await tx.execute('UPDATE otp_codes SET used_at = NOW() WHERE id = $1', [otpRow.id]);

          const userRow = await tx.queryOne<{
            id: string;
            role: UserRole;
            external_reason_detail: string | null;
          }>(
            `SELECT p.id, p.role, p.external_reason_detail
             FROM profiles p
             JOIN user_credentials uc ON uc.user_id = p.id
             WHERE lower(uc.email) = $1`,
            [email]
          );
          if (!userRow) return null;

          // Atomic lock guarantees only a single first-time Super Admin can ever be initialized
          await tx.query('SELECT pg_advisory_xact_lock(984521)');

          const superRow = await tx.queryOne<{ cnt: string | number }>(
            "SELECT COUNT(*) AS cnt FROM profiles WHERE role = 'super_admin' AND email_verified = TRUE"
          );
          const initSetting = await tx.queryOne<{ value: string }>(
            "SELECT value FROM platform_settings WHERE key = 'super_admin_initialized'"
          );
          const superCount = Number(superRow?.cnt || 0);
          const alreadyInit = initSetting?.value === 'true';

          const isUni = isUniversityEmail(email);
          let assignedRole: UserRole = userRow.role;
          let cleanDetail: string | null = userRow.external_reason_detail;
          let bootstrappedSuperAdmin = false;

          if (!alreadyInit && superCount === 0 && envSuperEmail && envSuperEmail === email) {
            assignedRole = 'super_admin';
            cleanDetail = null;
            bootstrappedSuperAdmin = true;
            await tx.execute(
              `INSERT INTO platform_settings (key, value)
               VALUES ('super_admin_initialized', 'true')
               ON CONFLICT (key) DO UPDATE SET value = 'true'`
            );
          } else if (isUni) {
            assignedRole =
              userRow.external_reason_detail === 'pending_teacher_verification'
                ? 'verified_teacher'
                : 'verified_student';
            cleanDetail = null;
          } else if (cleanDetail === 'pending_super_admin_claim') {
            cleanDetail = null;
          }

          await tx.execute(
            `UPDATE profiles
             SET email_verified = TRUE,
                 university_email_verified = $1,
                 role = $2::user_role,
                 external_reason_detail = $3,
                 updated_at = NOW()
             WHERE id = $4`,
            [isUni, assignedRole, cleanDetail, userRow.id]
          );

          await tx.execute(
            `INSERT INTO user_roles (id, user_id, role, granted_by, reason, created_at)
             VALUES ($1, $2, $3::user_role, NULL, $4, NOW())`,
            [
              crypto.randomUUID(),
              userRow.id,
              assignedRole,
              bootstrappedSuperAdmin ? 'First-time Super Admin bootstrap via verified SUPER_ADMIN_EMAIL' : 'OTP email verification completed',
            ]
          );

          await writeAuditLog(tx, userRow.id, 'email_verified', 'user', userRow.id, {
            university_email_verified: isUni,
            assigned_role: assignedRole,
          });
          if (bootstrappedSuperAdmin) {
            await writeAuditLog(tx, userRow.id, 'super_admin_bootstrapped', 'user', userRow.id, { email });
          }

          await createSessionCookie(tx, req, res, userRow.id, token);
          const authUser = await getAuthUserFromDb(tx, userRow.id);
          return authUser;
        },
        { trustedServer: true }
      );

      if (!result) {
        return res.status(404).json({ error: 'User account not found.' });
      }

      return res.json({
        verified: true,
        user: result,
        sessionToken: token,
      });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/resend-otp', async (req, res, next) => {
    try {
      const parsed = z
        .object({ email: z.string().email(), purpose: z.enum(['verify_email', 'reset_password']).default('verify_email') })
        .safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Valid email is required.' });

      const email = parsed.data.email.trim().toLowerCase();
      const userRow = await db.queryOne<{ user_id: string }>(
        'SELECT user_id FROM user_credentials WHERE lower(email) = $1',
        [email]
      );
      if (!userRow) {
        return res.status(404).json({ error: 'No account found with that email address.' });
      }

      const latest = await db.queryOne<{ resend_after: string | Date }>(
        'SELECT resend_after FROM otp_codes WHERE lower(email) = $1 AND purpose = $2 ORDER BY created_at DESC LIMIT 1',
        [email, parsed.data.purpose]
      );

      if (latest && new Date(latest.resend_after).getTime() > Date.now()) {
        const waitSec = Math.ceil((new Date(latest.resend_after).getTime() - Date.now()) / 1000);
        return res
          .status(429)
          .json({ error: `Please wait ${waitSec}s before requesting another code.`, retryAfterSec: waitSec });
      }

      const rl = await checkRateLimit(db, `otp_send:${email}`, 5, 3600);
      if (!rl.allowed) {
        return res.status(429).json({ error: `Hourly OTP limit reached. Try again in ${rl.retryAfterSec}s.` });
      }

      const otp = generateSixDigitOtp();
      await db.execute(
        `INSERT INTO otp_codes (id, email, purpose, code_hash, attempts, resend_after, expires_at, created_at)
         VALUES ($1, $2, $3, $4, 0, $5::timestamptz, $6::timestamptz, NOW())`,
        [
          crypto.randomUUID(),
          email,
          parsed.data.purpose,
          hashToken(otp),
          new Date(Date.now() + 60 * 1000).toISOString(),
          new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        ]
      );

      const delivery = await dispatchOtpEmail(email, otp, parsed.data.purpose);
      return res.json({
        message: 'A fresh 6-digit verification code has been issued.',
        resendCooldownSeconds: 60,
        ...(delivery.devCode ? { devOtpPreview: delivery.devCode } : {}),
      });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/request-password-reset', async (req, res, next) => {
    try {
      const parsed = z.object({ email: z.string().email() }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Valid email is required.' });
      const email = parsed.data.email.trim().toLowerCase();

      const rl = await checkRateLimit(db, `pwd_reset:${email}`, 5, 3600);
      if (!rl.allowed) {
        return res.status(429).json({ error: `Too many reset requests. Retry in ${rl.retryAfterSec}s.` });
      }

      const userRow = await db.queryOne<{ user_id: string }>(
        'SELECT user_id FROM user_credentials WHERE lower(email) = $1',
        [email]
      );
      if (!userRow) {
        return res.json({ message: 'If an account matches that email, a 6-digit reset code has been sent.' });
      }

      const otp = generateSixDigitOtp();
      await db.execute(
        `INSERT INTO otp_codes (id, email, purpose, code_hash, attempts, resend_after, expires_at, created_at)
         VALUES ($1, $2, 'reset_password', $3, 0, $4::timestamptz, $5::timestamptz, NOW())`,
        [
          crypto.randomUUID(),
          email,
          hashToken(otp),
          new Date(Date.now() + 60 * 1000).toISOString(),
          new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        ]
      );

      const delivery = await dispatchOtpEmail(email, otp, 'reset_password');
      return res.json({
        message: 'If an account matches that email, a 6-digit reset code has been sent.',
        ...(delivery.devCode ? { devOtpPreview: delivery.devCode } : {}),
      });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/reset-password', async (req, res, next) => {
    try {
      const parsed = z
        .object({
          email: z.string().email(),
          code: z.string().length(6).regex(/^\d{6}$/),
          new_password: z.string().min(8).max(128).regex(/[A-Za-z]/).regex(/[0-9]/),
        })
        .safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Invalid reset fields.' });

      const email = parsed.data.email.trim().toLowerCase();
      const otpRow = await db.queryOne<{
        id: string;
        code_hash: string;
        attempts: number;
        expires_at: string | Date;
      }>(
        `SELECT id, code_hash, attempts, expires_at
         FROM otp_codes
         WHERE lower(email) = $1 AND purpose = 'reset_password' AND used_at IS NULL
         ORDER BY created_at DESC LIMIT 1`,
        [email]
      );

      if (!otpRow || new Date(otpRow.expires_at).getTime() < Date.now() || Number(otpRow.attempts) >= 5) {
        return res.status(400).json({ error: 'Invalid or expired password reset code.' });
      }
      if (hashToken(parsed.data.code) !== String(otpRow.code_hash)) {
        await db.execute('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1', [otpRow.id]);
        return res.status(400).json({ error: 'Invalid or expired password reset code.' });
      }

      const newPassHash = hashPassword(parsed.data.new_password);
      await db.transaction(async (tx) => {
        await tx.execute('UPDATE otp_codes SET used_at = NOW() WHERE id = $1', [otpRow.id]);
        const cred = await tx.queryOne<{ user_id: string }>(
          'SELECT user_id FROM user_credentials WHERE lower(email) = $1',
          [email]
        );
        if (cred) {
          await tx.execute(
            'UPDATE user_credentials SET password_hash = $1, updated_at = NOW() WHERE user_id = $2',
            [newPassHash, cred.user_id]
          );
          await tx.execute('DELETE FROM sessions WHERE user_id = $1', [cred.user_id]);
          await writeAuditLog(tx, cred.user_id, 'password_reset', 'user', cred.user_id, {});
        }
      });

      return res.json({ message: 'Password updated successfully. Please sign in with your new password.' });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/login', async (req, res, next) => {
    try {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Email or username and password are required.' });

      const identifier = (parsed.data.identifier ?? parsed.data.email ?? '').trim().toLowerCase();
      const rl = await checkRateLimit(db, `login:${identifier}`, 12, 900);
      if (!rl.allowed) {
        return res.status(429).json({ error: `Too many login attempts. Retry in ${rl.retryAfterSec}s.` });
      }

      const row = await db.queryOne<{
        id: string;
        email: string;
        password_hash: string;
        account_status: string;
        email_verified: boolean;
      }>(
        `SELECT p.id, uc.email, uc.password_hash, p.account_status, p.email_verified
         FROM profiles p
         JOIN user_credentials uc ON uc.user_id = p.id
         WHERE lower(uc.email) = $1 OR lower(p.username) = $1`,
        [identifier]
      );

      if (!row || !verifyPassword(parsed.data.password, String(row.password_hash))) {
        return res.status(401).json({ error: 'Invalid credentials.' });
      }
      if (row.account_status !== 'active') {
        return res.status(403).json({ error: 'Your account has been suspended. Contact campus moderation.' });
      }

      if (!row.email_verified) {
        const userEmail = String(row.email).toLowerCase();
        const otp = generateSixDigitOtp();
        await db.execute(
          `INSERT INTO otp_codes (id, email, purpose, code_hash, attempts, resend_after, expires_at, created_at)
           VALUES ($1, $2, 'verify_email', $3, 0, $4::timestamptz, $5::timestamptz, NOW())`,
          [
            crypto.randomUUID(),
            userEmail,
            hashToken(otp),
            new Date(Date.now() + 60 * 1000).toISOString(),
            new Date(Date.now() + 15 * 60 * 1000).toISOString(),
          ]
        );
        const delivery = await dispatchOtpEmail(userEmail, otp, 'verify_email');
        return res.status(403).json({
          error: 'Email verification pending. Enter the 6-digit verification code sent to your email.',
          requiresVerification: true,
          email: userEmail,
          ...(delivery.devCode ? { devOtpPreview: delivery.devCode } : {}),
        });
      }

      const token = generateSessionToken();
      await createSessionCookie(db, req, res, String(row.id), token);
      const user = await getAuthUserFromDb(db, String(row.id));
      return res.json({
        user,
        sessionToken: token,
      });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/logout', async (req: AuthenticatedRequest, res, next) => {
    try {
      const authHeader = req.headers.authorization;
      const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : undefined;
      const rawToken = (req.cookies?.gh_session as string | undefined) || bearerToken;
      if (rawToken) {
        await db.execute('DELETE FROM sessions WHERE token_hash = $1', [hashToken(rawToken)]);
      }
      clearSessionCookie(req, res);
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });

  router.patch('/profile', requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
      const parsed = profileUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid profile fields.' });
      }

      const u = req.user!;
      const d = parsed.data;
      const nextProgramId =
        d.program_id !== undefined ? (isUuid(d.program_id) ? d.program_id : null) : u.program_id;
      const nextSemesterId =
        d.semester_id !== undefined ? (isUuid(d.semester_id) ? d.semester_id : null) : u.semester_id;

      // Uses actorId WITHOUT trustedServer so PostgreSQL trigger protects role/status/verification fields
      const updated = await db.transaction(
        async (tx) => {
          await tx.execute(
            `UPDATE profiles SET
              display_name = COALESCE($1, display_name),
              bio = COALESCE($2, bio),
              program_id = $3,
              semester_id = $4,
              interests = COALESCE($5::text[], interests),
              notification_prefs = COALESCE($6::jsonb, notification_prefs),
              privacy_settings = COALESCE($7::jsonb, privacy_settings),
              updated_at = NOW()
             WHERE id = $8`,
            [
              d.display_name?.trim() ?? null,
              d.bio !== undefined ? d.bio.trim() : null,
              nextProgramId,
              nextSemesterId,
              d.interests ?? null,
              d.notification_prefs ? JSON.stringify(d.notification_prefs) : null,
              d.privacy_settings ? JSON.stringify(d.privacy_settings) : null,
              u.id,
            ]
          );
          return getAuthUserFromDb(tx, u.id);
        },
        { actorId: u.id, trustedServer: false }
      );

      return res.json({ user: updated });
    } catch (err) {
      return next(err);
    }
  });

  router.post(
    '/profile/avatar',
    requireAuth,
    avatarUpload.single('avatar'),
    async (req: AuthenticatedRequest, res, next) => {
      try {
        if (!req.file) {
          return res.status(400).json({ error: 'Please select an image file (PNG or JPEG, max 2MB).' });
        }
        const buf = req.file.buffer;
        const isPng = buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
        const isJpg = buf.subarray(0, 3).toString('hex') === 'ffd8ff';
        if (!isPng && !isJpg) {
          return res.status(400).json({ error: 'Only valid PNG or JPEG images are allowed for profile avatars.' });
        }

        const ext = isPng ? 'png' : 'jpg';
        const mime = isPng ? 'image/png' : 'image/jpeg';
        const safeName = `${req.user!.id}_${Date.now()}_${sanitizeFilename(req.file.originalname).replace(/\.[^.]+$/, '')}.${ext}`;
        await req.storage!.uploadPrivate(`avatars/${safeName}`, buf, mime);

        const avatarUrl = `/api/auth/avatars/${safeName}`;
        await db.transaction(
          async (tx) => {
            await tx.execute('UPDATE profiles SET avatar_url = $1, updated_at = NOW() WHERE id = $2', [
              avatarUrl,
              req.user!.id,
            ]);
          },
          { actorId: req.user!.id }
        );
        const user = await getAuthUserFromDb(db, req.user!.id);
        return res.json({ avatar_url: avatarUrl, user });
      } catch (err) {
        return next(err);
      }
    }
  );

  router.get('/avatars/:filename', async (req: AuthenticatedRequest, res, next) => {
    try {
      const safe = path.basename(req.params.filename);
      if (!/^[a-zA-Z0-9._-]+$/.test(safe)) {
        return res.status(400).end();
      }
      const data = await req.storage!.downloadPrivate(`avatars/${safe}`);
      if (!data) return res.status(404).end();
      const isPng = safe.toLowerCase().endsWith('.png');
      res.setHeader('Content-Type', isPng ? 'image/png' : 'image/jpeg');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.send(data);
    } catch (err) {
      return next(err);
    }
  });

  // Public profile lookup (respecting privacy: never exposes email or private connection list!)
  router.get('/users/:username', async (req: AuthenticatedRequest, res, next) => {
    try {
      const row = await db.queryOne<Record<string, unknown>>(
        `SELECT u.id, u.username, u.display_name, u.avatar_url, u.bio, u.role,
                u.university_email_verified, u.email_verified, u.program_id, u.semester_id,
                u.interests, u.privacy_settings, u.account_status, u.created_at,
                p.name AS program_name, s.name AS semester_name
         FROM profiles u
         LEFT JOIN programs p ON p.id = u.program_id
         LEFT JOIN semesters s ON s.id = u.semester_id
         WHERE lower(u.username) = $1`,
        [req.params.username.toLowerCase()]
      );

      if (!row) return res.status(404).json({ error: 'User profile not found.' });

      const privacy = (row.privacy_settings as { show_program?: boolean }) || { show_program: true };
      const isSelf = req.user?.id === String(row.id);

      const posts = await db.query(
        `SELECT p.id, p.title, p.created_at, p.upvote_count, p.comment_count, c.name AS community_name, c.slug AS community_slug
         FROM posts p JOIN communities c ON c.id = p.community_id
         WHERE p.author_id = $1 AND p.is_hidden = FALSE
         ORDER BY p.created_at DESC LIMIT 20`,
        [String(row.id)]
      );

      const resources = await db.query(
        `SELECT r.id, r.title, r.status, r.download_count, r.upvote_count, r.created_at, sub.name AS subject_name, rc.name AS category_name
         FROM resources r
         JOIN subjects sub ON sub.id = r.subject_id
         JOIN resource_categories rc ON rc.id = r.category_id
         WHERE r.uploader_id = $1 ${isSelf ? '' : "AND r.status = 'approved'"}
         ORDER BY r.created_at DESC LIMIT 20`,
        [String(row.id)]
      );

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
          interests: Array.isArray(row.interests) ? row.interests : [],
          account_status: row.account_status,
          created_at: new Date(String(row.created_at)).toISOString(),
        },
        posts,
        resources,
      });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}
