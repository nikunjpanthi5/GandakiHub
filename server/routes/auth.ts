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
import { type AppDatabase, type DbExecutor, syncModerationQueue, writeAuditLog } from '../db.ts';
import { dispatchOtpEmail } from '../email.ts';
import {
  generateSessionToken,
  generateSixDigitOtp,
  hashPassword,
  hashToken,
  isUniversityEmail,
  isUuid,
  sanitizeFilename,
  validatePdfBuffer,
  verifyPassword,
} from '../security.ts';
import type { UserRole } from '../../src/types/index.ts';

const STAFF_POSITIONS = [
  'Teacher',
  'Faculty',
  'Staff',
  'Lecturer',
  'Assistant Professor',
  'Associate Professor',
  'Professor',
  'Administrative Staff',
  'Other',
] as const;

const registerSchema = z
  .object({
    full_name: z.string().trim().min(2, 'Full name must be at least 2 characters').max(80).optional(),
    display_name: z.string().trim().min(2, 'Full name must be at least 2 characters').max(80).optional(),
    email: z.string().trim().email('Please enter a valid email address').max(160),
    password: z
      .string()
      .min(8, 'Password must be at least 8 characters')
      .max(128)
      .regex(/[A-Za-z]/, 'Password must include a letter')
      .regex(/[0-9]/, 'Password must include a number'),
    confirm_password: z.string().min(1, 'Please confirm your password'),
  })
  .refine((d) => Boolean((d.full_name || d.display_name || '').trim().length >= 2), {
    message: 'Full name is required (at least 2 characters).',
  })
  .refine((d) => d.password === d.confirm_password, {
    message: 'Password and Confirm Password do not match.',
    path: ['confirm_password'],
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
    password: z.string().min(1, 'Password is required.'),
  })
  .refine((d) => Boolean((d.identifier || d.email || '').trim()), {
    message: 'Email is required.',
  });

const profileUpdateSchema = z.object({
  display_name: z.string().trim().min(2).max(80).optional(),
  bio: z.string().max(500).optional(),
  program_id: z.string().nullable().optional(),
  semester_id: z.string().nullable().optional(),
  department: z.string().trim().max(120).nullable().optional(),
  student_id: z.string().trim().max(60).nullable().optional(),
  interests: z.array(z.string().trim().max(40)).max(12).optional(),
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
  profile_completed: z.boolean().optional(),
});

function getConfiguredSuperAdminEmail(): string | null {
  const val = process.env.SUPER_ADMIN_EMAIL?.trim().toLowerCase();
  return val && val.includes('@') ? val : null;
}

async function generateUniqueUsername(tx: DbExecutor, fullName: string, email: string): Promise<string> {
  const fromName = fullName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 20);
  const fromEmail = email
    .split('@')[0]
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 20);
  const base = (fromName.length >= 3 ? fromName : fromEmail.length >= 3 ? fromEmail : 'gandaki_member').slice(0, 22);

  const exact = await tx.queryOne<{ id: string }>('SELECT id FROM profiles WHERE lower(username) = $1', [base]);
  if (!exact) return base;

  for (let i = 0; i < 12; i++) {
    const suffix = crypto.randomBytes(2).toString('hex');
    const candidate = `${base.slice(0, 24)}_${suffix}`;
    const taken = await tx.queryOne<{ id: string }>('SELECT id FROM profiles WHERE lower(username) = $1', [candidate]);
    if (!taken) return candidate;
  }
  return `member_${crypto.randomBytes(4).toString('hex')}`;
}

async function hasMigration003ProfileCols(db: DbExecutor): Promise<boolean> {
  const row = await db.queryOne<{ exists: string | null }>(
    `SELECT column_name::text AS exists
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'department'
     LIMIT 1`
  );
  return Boolean(row?.exists);
}

async function hasStaffVerificationTable(db: DbExecutor): Promise<boolean> {
  const row = await db.queryOne<{ exists: string | null }>(
    "SELECT to_regclass('public.staff_verification_requests')::text AS exists"
  );
  return Boolean(row?.exists);
}

export function createAuthRouter(db: AppDatabase): Router {
  const router = Router();

  const avatarUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 2 * 1024 * 1024 },
  });

  const evidenceUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
  });

  router.get('/me', (req: AuthenticatedRequest, res) => {
    res.json({ user: req.user ?? null });
  });

  // Simplified, unified registration: Full Name + Gandaki University Email + Password + Confirm Password
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
      const fullName = (data.full_name || data.display_name || '').trim();
      const normalizedEmail = data.email.trim().toLowerCase();
      const envSuperEmail = getConfiguredSuperAdminEmail();

      const superRow = await db.queryOne<{ cnt: string | number }>(
        "SELECT COUNT(*) AS cnt FROM profiles WHERE role = 'super_admin' AND email_verified = TRUE"
      );
      const initSetting = await db.queryOne<{ value: string }>(
        "SELECT value FROM platform_settings WHERE key = 'super_admin_initialized'"
      );
      const superAlreadyInitialized = Number(superRow?.cnt || 0) > 0 || initSetting?.value === 'true';

      const isBootstrapSuperEmail =
        !superAlreadyInitialized && Boolean(envSuperEmail && envSuperEmail === normalizedEmail);

      if (!isUniversityEmail(normalizedEmail) && !isBootstrapSuperEmail) {
        return res.status(400).json({
          error: 'Registration requires a valid @gandakiuniversity.edu.np email address.',
        });
      }

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

      // Server-side always starts unverified accounts as 'visitor' until OTP passes,
      // then promotes university members strictly to ordinary 'verified_student' role.
      const initialRole: UserRole = 'visitor';
      const userId = crypto.randomUUID();
      const passHash = hashPassword(data.password);
      const otp = generateSixDigitOtp();
      const resendAfter = new Date(Date.now() + 60 * 1000).toISOString();
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

      try {
        await db.transaction(
          async (tx) => {
            const generatedUsername = await generateUniqueUsername(tx, fullName, normalizedEmail);

            await tx.execute(
              `INSERT INTO profiles (id, username, display_name, bio, role, email_verified, university_email_verified, interests, account_status, created_at, updated_at)
               VALUES ($1, $2, $3, '', $4::user_role, FALSE, FALSE, '{}', 'active', NOW(), NOW())`,
              [userId, generatedUsername, fullName, initialRole]
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
              registration_mode: 'simplified_unified',
            });
          },
          { trustedServer: true }
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : '';
        if (msg.toLowerCase().includes('unique')) {
          return res.status(409).json({
            error: 'An account with this email address already exists.',
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
            // Unverified registrants strictly receive ordinary registered user role;
            // staff/teacher elevation happens ONLY after admin approval.
            assignedRole = 'verified_student';
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
              bootstrappedSuperAdmin
                ? 'First-time Super Admin bootstrap via verified SUPER_ADMIN_EMAIL'
                : 'OTP email verification completed',
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

  // Normal User Sign In
  router.post('/login', async (req, res, next) => {
    try {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Email and password are required.' });

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
        return res.status(401).json({ error: 'Invalid email or password.' });
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

  // Dedicated Administrator Portal Login (/admin-login-hub)
  // Unified form (Email + Password), server-side checks admin/super_admin role without exposing role picker or leaking admin emails.
  router.post('/admin-login', async (req, res, next) => {
    try {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Email and password are required.' });
      }

      const identifier = (parsed.data.email ?? parsed.data.identifier ?? '').trim().toLowerCase();
      const rl = await checkRateLimit(db, `admin_login:${req.ip || 'local'}:${identifier}`, 10, 900);
      if (!rl.allowed) {
        return res.status(429).json({ error: `Too many login attempts. Retry in ${rl.retryAfterSec}s.` });
      }

      const row = await db.queryOne<{
        id: string;
        email: string;
        password_hash: string;
        role: UserRole;
        account_status: string;
        email_verified: boolean;
      }>(
        `SELECT p.id, uc.email, uc.password_hash, p.role, p.account_status, p.email_verified
         FROM profiles p
         JOIN user_credentials uc ON uc.user_id = p.id
         WHERE lower(uc.email) = $1 OR lower(p.username) = $1`,
        [identifier]
      );

      // Uniform failure message on wrong email/password so administrator emails are never enumerable
      if (!row || !verifyPassword(parsed.data.password, String(row.password_hash))) {
        return res.status(401).json({ error: 'Invalid credentials.' });
      }

      if (row.role !== 'admin' && row.role !== 'super_admin') {
        await writeAuditLog(db, String(row.id), 'admin_portal_unauthorized_attempt', 'user', String(row.id), {
          role: row.role,
        });
        return res.status(403).json({
          error: 'You are not authorized to access the administrator portal.',
        });
      }

      if (row.account_status !== 'active') {
        return res.status(403).json({ error: 'This administrator account is currently suspended.' });
      }

      if (!row.email_verified) {
        return res.status(403).json({ error: 'Administrator email verification is pending.' });
      }

      const token = generateSessionToken();
      await createSessionCookie(db, req, res, String(row.id), token);
      await writeAuditLog(db, String(row.id), 'admin_portal_login', 'user', String(row.id), {
        role: row.role,
      });

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

      if (nextProgramId) {
        const progExists = await db.queryOne('SELECT id FROM programs WHERE id = $1 AND is_archived = FALSE', [nextProgramId]);
        if (!progExists) {
          return res.status(400).json({ error: 'Selected academic program was not found.' });
        }
      }
      if (nextSemesterId) {
        const semExists = await db.queryOne('SELECT id FROM semesters WHERE id = $1 AND is_archived = FALSE', [nextSemesterId]);
        if (!semExists) {
          return res.status(400).json({ error: 'Selected semester was not found.' });
        }
      }

      const supportsExtendedCols = await hasMigration003ProfileCols(db);
      const nextDept = d.department !== undefined ? (d.department?.trim() || null) : (u.department ?? null);
      const nextStudentId = d.student_id !== undefined ? (d.student_id?.trim() || null) : (u.student_id ?? null);
      const nextCompleted = Boolean(u.profile_completed || (d.profile_completed ?? true));

      const basePrivacy = {
        show_program: d.privacy_settings?.show_program ?? u.privacy_settings.show_program,
        allow_connection_requests:
          d.privacy_settings?.allow_connection_requests ?? u.privacy_settings.allow_connection_requests,
      };

      // Uses actorId WITHOUT trustedServer so PostgreSQL trigger protects role/status/verification fields
      const updated = await db.transaction(
        async (tx) => {
          if (supportsExtendedCols) {
            await tx.execute(
              `UPDATE profiles SET
                display_name = COALESCE($1, display_name),
                bio = COALESCE($2, bio),
                program_id = $3,
                semester_id = $4,
                department = $5,
                student_id = $6,
                profile_completed = profile_completed OR $7,
                interests = COALESCE($8::text[], interests),
                notification_prefs = COALESCE($9::jsonb, notification_prefs),
                privacy_settings = $10::jsonb,
                updated_at = NOW()
               WHERE id = $11`,
              [
                d.display_name?.trim() ?? null,
                d.bio !== undefined ? d.bio.trim() : null,
                nextProgramId,
                nextSemesterId,
                nextDept,
                nextStudentId,
                nextCompleted,
                d.interests ?? null,
                d.notification_prefs ? JSON.stringify(d.notification_prefs) : null,
                JSON.stringify(basePrivacy),
                u.id,
              ]
            );
          } else {
            const fallbackPrivacy = {
              ...basePrivacy,
              _profile_ext: {
                department: nextDept,
                student_id: nextStudentId,
                profile_completed: nextCompleted,
              },
            };
            await tx.execute(
              `UPDATE profiles SET
                display_name = COALESCE($1, display_name),
                bio = COALESCE($2, bio),
                program_id = $3,
                semester_id = $4,
                interests = COALESCE($5::text[], interests),
                notification_prefs = COALESCE($6::jsonb, notification_prefs),
                privacy_settings = $7::jsonb,
                updated_at = NOW()
               WHERE id = $8`,
              [
                d.display_name?.trim() ?? null,
                d.bio !== undefined ? d.bio.trim() : null,
                nextProgramId,
                nextSemesterId,
                d.interests ?? null,
                d.notification_prefs ? JSON.stringify(d.notification_prefs) : null,
                JSON.stringify(fallbackPrivacy),
                u.id,
              ]
            );
          }
          return getAuthUserFromDb(tx, u.id);
        },
        { actorId: u.id, trustedServer: false }
      );

      return res.json({ user: updated });
    } catch (err) {
      return next(err);
    }
  });

  // Get own latest university staff verification request & status
  router.get('/staff-verification', requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
      const tableReady = await hasStaffVerificationTable(db);
      if (!tableReady) {
        return res.json({
          status: req.user!.role === 'verified_teacher' ? 'approved' : 'not_requested',
          latestRequest: null,
        });
      }

      const row = await db.queryOne<Record<string, unknown>>(
        `SELECT id, user_id, position, department, designation, university_email, supporting_notes,
                (evidence_object_path IS NOT NULL) AS has_evidence, evidence_original_filename,
                status, reviewer_id, review_notes, reviewed_at, created_at, updated_at
         FROM staff_verification_requests
         WHERE user_id = $1
         ORDER BY created_at DESC LIMIT 1`,
        [req.user!.id]
      );

      const status =
        req.user!.role === 'verified_teacher'
          ? 'approved'
          : row
            ? String(row.status)
            : 'not_requested';

      const latestRequest = row
        ? {
            ...row,
            has_evidence: Boolean(row.has_evidence),
            reviewed_at: row.reviewed_at ? new Date(String(row.reviewed_at)).toISOString() : null,
            created_at: new Date(String(row.created_at)).toISOString(),
            updated_at: new Date(String(row.updated_at)).toISOString(),
          }
        : null;

      return res.json({
        status,
        latestRequest,
      });
    } catch (err) {
      return next(err);
    }
  });

  // Submit University Staff Verification Request (NEVER grants privileges immediately; requires admin approval)
  router.post(
    '/staff-verification',
    requireAuth,
    evidenceUpload.single('evidence'),
    async (req: AuthenticatedRequest, res, next) => {
      try {
        const u = req.user!;
        if (u.role === 'visitor' || u.role === 'future_student') {
          return res.status(403).json({
            error: 'Only verified university members can request university staff verification.',
          });
        }
        if (u.role === 'verified_teacher' || u.role === 'admin' || u.role === 'super_admin') {
          return res.status(400).json({
            error: 'Your account already holds verified staff or administrative privileges.',
          });
        }

        const tableReady = await hasStaffVerificationTable(db);
        if (!tableReady) {
          return res.status(503).json({
            error: 'Staff verification database migration (003) has not been applied yet.',
          });
        }

        const parsed = z
          .object({
            position: z.enum(STAFF_POSITIONS),
            department: z.string().trim().min(2, 'Department is required').max(120),
            designation: z.string().trim().max(120).default(''),
            supporting_notes: z.string().trim().max(1000).default(''),
          })
          .safeParse(req.body);

        if (!parsed.success) {
          return res.status(400).json({
            error: parsed.error.issues[0]?.message || 'Please complete all required staff verification fields.',
          });
        }

        const existingPending = await db.queryOne<{ id: string }>(
          "SELECT id FROM staff_verification_requests WHERE user_id = $1 AND status = 'pending'",
          [u.id]
        );
        if (existingPending) {
          return res.status(409).json({
            error: 'You already have a pending university staff verification request awaiting review.',
          });
        }

        let evidencePath: string | null = null;
        let evidenceOrigName: string | null = null;
        let evidenceMime: string | null = null;

        if (req.file) {
          const buf = req.file.buffer;
          const isPng = buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
          const isJpg = buf.subarray(0, 3).toString('hex') === 'ffd8ff';
          const pdfCheck = validatePdfBuffer(buf);

          if (!isPng && !isJpg && !pdfCheck.valid) {
            return res.status(400).json({
              error: 'Supporting evidence must be a valid PDF, PNG, or JPEG file (max 5MB).',
            });
          }

          const ext = isPng ? 'png' : isJpg ? 'jpg' : 'pdf';
          evidenceMime = isPng ? 'image/png' : isJpg ? 'image/jpeg' : 'application/pdf';
          evidenceOrigName = sanitizeFilename(req.file.originalname);
          const safeBase = evidenceOrigName.replace(/\.[^.]+$/, '');
          evidencePath = `verification-evidence/${u.id}/${Date.now()}_${safeBase}.${ext}`;
          await req.storage!.uploadPrivate(evidencePath, buf, evidenceMime);
        }

        const reqId = crypto.randomUUID();
        const supportsExtendedCols = await hasMigration003ProfileCols(db);

        await db.transaction(
          async (tx) => {
            await tx.execute(
              `INSERT INTO staff_verification_requests
               (id, user_id, position, department, designation, university_email, supporting_notes,
                evidence_object_path, evidence_original_filename, evidence_mime_type, status, created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', NOW(), NOW())`,
              [
                reqId,
                u.id,
                parsed.data.position,
                parsed.data.department,
                parsed.data.designation,
                u.email,
                parsed.data.supporting_notes,
                evidencePath,
                evidenceOrigName,
                evidenceMime,
              ]
            );

            // Save descriptive position/department on profile WITHOUT elevating role
            if (supportsExtendedCols) {
              await tx.execute(
                `UPDATE profiles
                 SET staff_position = $1,
                     department = $2,
                     designation = $3,
                     updated_at = NOW()
                 WHERE id = $4`,
                [parsed.data.position, parsed.data.department, parsed.data.designation || null, u.id]
              );
            }

            await syncModerationQueue(tx, 'staff_verification', reqId, u.id, 'pending');
            await writeAuditLog(tx, u.id, 'staff_verification_requested', 'staff_verification', reqId, {
              position: parsed.data.position,
              department: parsed.data.department,
              has_evidence: Boolean(evidencePath),
            });
          },
          { actorId: u.id, trustedServer: false }
        );

        const refreshedUser = await getAuthUserFromDb(db, u.id);
        return res.status(201).json({
          status: 'pending',
          user: refreshedUser,
          request: {
            id: reqId,
            user_id: u.id,
            position: parsed.data.position,
            department: parsed.data.department,
            designation: parsed.data.designation,
            university_email: u.email,
            supporting_notes: parsed.data.supporting_notes,
            has_evidence: Boolean(evidencePath),
            evidence_original_filename: evidenceOrigName,
            status: 'pending',
            reviewer_id: null,
            review_notes: null,
            reviewed_at: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
          message:
            'Your university staff verification request has been submitted for administrator review. Your account remains a standard member until approved.',
        });
      } catch (err) {
        return next(err);
      }
    }
  );

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
        `SELECT u.*, p.name AS program_name, s.name AS semester_name
         FROM profiles u
         LEFT JOIN programs p ON p.id = u.program_id
         LEFT JOIN semesters s ON s.id = u.semester_id
         WHERE lower(u.username) = $1`,
        [req.params.username.toLowerCase()]
      );

      if (!row) return res.status(404).json({ error: 'User profile not found.' });

      const rawPrivacy =
        row.privacy_settings && typeof row.privacy_settings === 'object'
          ? (row.privacy_settings as Record<string, unknown>)
          : {};
      const profileExt =
        rawPrivacy._profile_ext && typeof rawPrivacy._profile_ext === 'object'
          ? (rawPrivacy._profile_ext as Record<string, unknown>)
          : {};
      const privacy = { show_program: rawPrivacy.show_program !== false };
      const isSelf = req.user?.id === String(row.id);
      const deptVal =
        row.department != null
          ? String(row.department)
          : typeof profileExt.department === 'string' && profileExt.department
            ? profileExt.department
            : null;
      const studentIdVal =
        row.student_id != null
          ? String(row.student_id)
          : typeof profileExt.student_id === 'string' && profileExt.student_id
            ? profileExt.student_id
            : null;
      const staffPosVal =
        row.staff_position != null
          ? String(row.staff_position)
          : typeof profileExt.staff_position === 'string' && profileExt.staff_position
            ? profileExt.staff_position
            : null;
      const designationVal =
        row.designation != null
          ? String(row.designation)
          : typeof profileExt.designation === 'string' && profileExt.designation
            ? profileExt.designation
            : null;

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
          department: privacy.show_program || isSelf ? deptVal : null,
          student_id: isSelf ? studentIdVal : null,
          staff_position: row.role === 'verified_teacher' ? staffPosVal : null,
          designation: row.role === 'verified_teacher' ? designationVal : null,
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
