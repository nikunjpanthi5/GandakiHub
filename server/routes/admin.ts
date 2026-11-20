import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import {
  type AuthenticatedRequest,
  requireAdmin,
  requireModerator,
  requireSuperAdmin,
} from '../authMiddleware.ts';
import { type AppDatabase, createNotification, syncModerationQueue, writeAuditLog } from '../db.ts';
import { normalizeDictionaryTerm } from '../profanity.ts';
import { hashPassword, isUuid } from '../security.ts';
import type { UserRole } from '../../src/types/index.ts';

export function createAdminRouter(db: AppDatabase): Router {
  const router = Router();

  // Genuine Overview Metrics (never fabricated)
  router.get('/overview', requireModerator, async (_req: AuthenticatedRequest, res, next) => {
    try {
      const countQuery = async (sql: string) => {
        const r = await db.queryOne<{ cnt: string | number }>(sql);
        return Number(r?.cnt || 0);
      };

      const [
        total_users,
        verified_students,
        verified_teachers,
        active_users,
        total_communities,
        total_posts,
        total_resources,
        pending_resources_new,
        pending_resources_revs,
        pending_confessions,
        pending_complaints,
        open_reports,
        pendingResources,
        pendingConfessions,
        pendingOpportunities,
        pendingDonations,
        openReports,
      ] = await Promise.all([
        countQuery('SELECT COUNT(*) AS cnt FROM profiles'),
        countQuery("SELECT COUNT(*) AS cnt FROM profiles WHERE role = 'verified_student' AND university_email_verified = TRUE"),
        countQuery("SELECT COUNT(*) AS cnt FROM profiles WHERE role = 'verified_teacher' AND university_email_verified = TRUE"),
        countQuery("SELECT COUNT(*) AS cnt FROM profiles WHERE account_status = 'active'"),
        countQuery('SELECT COUNT(*) AS cnt FROM communities WHERE is_archived = FALSE'),
        countQuery('SELECT COUNT(*) AS cnt FROM posts WHERE is_hidden = FALSE'),
        countQuery("SELECT COUNT(*) AS cnt FROM resources WHERE status = 'approved'"),
        countQuery("SELECT COUNT(*) AS cnt FROM resources WHERE status = 'pending'"),
        countQuery("SELECT COUNT(*) AS cnt FROM resource_revisions WHERE status = 'pending' AND resource_id IN (SELECT id FROM resources WHERE status = 'approved')"),
        countQuery("SELECT COUNT(*) AS cnt FROM confessions WHERE status = 'pending'"),
        countQuery("SELECT COUNT(*) AS cnt FROM complaints WHERE status IN ('submitted', 'under_review')"),
        countQuery("SELECT COUNT(*) AS cnt FROM reports WHERE status = 'open'"),
        db.query(
          `SELECT r.id, r.title, r.status, r.created_at, p.code AS program_code, sem.name AS semester_name, sub.name AS subject_name,
                  rc.name AS category_name, u.display_name AS uploader_name, rr.id AS revision_id, rr.revision_number, rr.original_filename, rr.file_size
           FROM resource_revisions rr
           JOIN resources r ON r.id = rr.resource_id
           JOIN programs p ON p.id = r.program_id
           JOIN semesters sem ON sem.id = r.semester_id
           JOIN subjects sub ON sub.id = r.subject_id
           JOIN resource_categories rc ON rc.id = r.category_id
           JOIN profiles u ON u.id = r.uploader_id
           WHERE rr.status = 'pending'
           ORDER BY rr.created_at ASC`
        ),
        db.query(
          "SELECT id, title, body, image_url, category, created_at FROM confessions WHERE status = 'pending' ORDER BY created_at ASC"
        ),
        db.query(
          "SELECT o.*, u.display_name AS author_name FROM opportunities o JOIN profiles u ON u.id = o.author_id WHERE o.status = 'pending' ORDER BY o.created_at ASC"
        ),
        db.query(
          "SELECT d.*, u.display_name AS requester_name FROM donation_requests d JOIN profiles u ON u.id = d.requester_id WHERE d.status = 'pending' ORDER BY d.created_at ASC"
        ),
        db.query(
          `SELECT rp.*, u.display_name AS reporter_name
           FROM reports rp JOIN profiles u ON u.id = rp.reporter_id
           ORDER BY CASE WHEN rp.status = 'open' THEN 0 ELSE 1 END, rp.created_at DESC LIMIT 50`
        ),
      ]);

      let pending_staff_verifications = 0;
      let pendingStaffVerifications: Array<Record<string, unknown>> = [];
      try {
        const svExists = await db.queryOne<{ exists: string | null }>(
          "SELECT to_regclass('public.staff_verification_requests')::text AS exists"
        );
        if (svExists?.exists) {
          pending_staff_verifications = await countQuery(
            "SELECT COUNT(*) AS cnt FROM staff_verification_requests WHERE status = 'pending'"
          );
          pendingStaffVerifications = await db.query(
            `SELECT sv.id, sv.user_id, sv.position, sv.department, sv.designation, sv.university_email,
                    sv.supporting_notes, (sv.evidence_object_path IS NOT NULL) AS has_evidence,
                    sv.evidence_original_filename, sv.status, sv.review_notes, sv.created_at,
                    u.display_name AS requester_name, u.username AS requester_username, u.role AS requester_role
             FROM staff_verification_requests sv
             JOIN profiles u ON u.id = sv.user_id
             WHERE sv.status = 'pending'
             ORDER BY sv.created_at ASC`
          );
        }
      } catch {
        // Ignore if 003 migration not yet applied in prod
      }

      return res.json({
        stats: {
          total_users,
          verified_students,
          verified_teachers,
          active_users,
          total_communities,
          total_posts,
          total_resources,
          pending_resources: pending_resources_new + pending_resources_revs,
          pending_confessions,
          pending_complaints,
          open_reports,
          pending_staff_verifications,
        },
        queues: {
          pendingResources,
          pendingConfessions,
          pendingOpportunities,
          pendingDonations,
          openReports,
          pendingStaffVerifications,
        },
      });
    } catch (err) {
      return next(err);
    }
  });

  // User management
  router.get('/users', requireAdmin, async (req, res, next) => {
    try {
      const q = String(req.query.q || '').trim().toLowerCase();
      const rows = await db.query(
        `SELECT u.id, uc.email, u.username, u.display_name, u.role, u.email_verified, u.university_email_verified,
                u.account_status, u.created_at, p.code AS program_code
         FROM profiles u
         JOIN user_credentials uc ON uc.user_id = u.id
         LEFT JOIN programs p ON p.id = u.program_id
         ${q ? 'WHERE lower(u.display_name) LIKE $1 OR lower(u.username) LIKE $1 OR lower(uc.email) LIKE $1' : ''}
         ORDER BY u.created_at DESC LIMIT 100`,
        q ? [`%${q}%`] : []
      );
      return res.json({ users: rows });
    } catch (err) {
      return next(err);
    }
  });

  router.patch('/users/:id/status', requireAdmin, async (req: AuthenticatedRequest, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'User not found.' });
      const parsed = z
        .object({ account_status: z.enum(['active', 'suspended', 'restricted']), reason: z.string().max(300).default('') })
        .safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Invalid status update.' });

      const target = await db.queryOne<{ role: UserRole }>('SELECT role FROM profiles WHERE id = $1', [req.params.id]);
      if (!target) return res.status(404).json({ error: 'User not found.' });
      if (target.role === 'super_admin' && req.user!.role !== 'super_admin') {
        return res.status(403).json({ error: 'Only a Super Admin can modify another Super Admin.' });
      }

      await db.transaction(
        async (tx) => {
          await tx.execute('UPDATE profiles SET account_status = $1, updated_at = NOW() WHERE id = $2', [
            parsed.data.account_status,
            req.params.id,
          ]);
          if (parsed.data.account_status !== 'active') {
            await tx.execute('DELETE FROM sessions WHERE user_id = $1', [req.params.id]);
          }
          await writeAuditLog(tx, req.user!.id, 'update_user_status', 'user', req.params.id, {
            account_status: parsed.data.account_status,
            reason: parsed.data.reason,
          });
        },
        { trustedServer: true, actorId: req.user!.id }
      );
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });

  router.patch('/users/:id/role', requireAdmin, async (req: AuthenticatedRequest, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'User not found.' });
      const parsed = z
        .object({
          role: z.enum([
            'super_admin',
            'admin',
            'community_moderator',
            'verified_student',
            'verified_teacher',
            'future_student',
            'alumni',
            'visitor',
          ]),
        })
        .safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Invalid role.' });

      const { role } = parsed.data;
      if ((role === 'super_admin' || role === 'admin') && req.user!.role !== 'super_admin') {
        return res.status(403).json({ error: 'Only a Super Admin can assign Admin or Super Admin roles.' });
      }

      await db.transaction(
        async (tx) => {
          await tx.execute('UPDATE profiles SET role = $1::user_role, updated_at = NOW() WHERE id = $2', [
            role,
            req.params.id,
          ]);
          await tx.execute(
            `INSERT INTO user_roles (id, user_id, role, granted_by, reason, created_at)
             VALUES ($1, $2, $3::user_role, $4, 'Role updated via admin governance', NOW())`,
            [crypto.randomUUID(), req.params.id, role, req.user!.id]
          );
          await writeAuditLog(tx, req.user!.id, 'change_user_role', 'user', req.params.id, { new_role: role });
          await createNotification(
            tx,
            req.params.id,
            'role_changed',
            'Account Role Updated',
            `Your GandakiHub role was updated to ${role.replace('_', ' ')}.`,
            '/profile'
          );
        },
        { trustedServer: true, actorId: req.user!.id }
      );

      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });

  // Super Admin ONLY: Create dedicated Admin account with username & password
  router.post('/admins', requireSuperAdmin, async (req: AuthenticatedRequest, res, next) => {
    try {
      const parsed = z
        .object({
          username: z
            .string()
            .min(3, 'Admin username must be at least 3 characters')
            .max(30)
            .regex(/^[a-zA-Z0-9_]+$/, 'Username may contain letters, numbers, and underscores only'),
          display_name: z.string().min(2).max(80).optional(),
          email: z.string().email().max(160).optional().or(z.literal('')),
          password: z
            .string()
            .min(8, 'Password must be at least 8 characters')
            .max(128)
            .regex(/[A-Za-z]/, 'Password must include a letter')
            .regex(/[0-9]/, 'Password must include a number'),
        })
        .safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid admin account details.' });
      }

      const username = parsed.data.username.trim().toLowerCase();
      const displayName = (parsed.data.display_name || parsed.data.username).trim();
      const email = parsed.data.email?.trim()
        ? parsed.data.email.trim().toLowerCase()
        : `${username}@admin.gandakihub.local`;

      if (await db.queryOne('SELECT id FROM profiles WHERE lower(username) = $1', [username])) {
        return res.status(409).json({ error: 'This username is already taken.' });
      }
      if (await db.queryOne('SELECT user_id FROM user_credentials WHERE lower(email) = $1', [email])) {
        return res.status(409).json({ error: 'An account with this email already exists.' });
      }

      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const passHash = hashPassword(parsed.data.password);

      await db.transaction(
        async (tx) => {
          await tx.execute(
            `INSERT INTO profiles (id, username, display_name, bio, role, email_verified, university_email_verified, interests, account_status, created_at, updated_at)
             VALUES ($1, $2, $3, '', 'admin', TRUE, FALSE, '{}', 'active', $4::timestamptz, $4::timestamptz)`,
            [id, username, displayName, now]
          );
          await tx.execute(
            `INSERT INTO user_credentials (user_id, email, password_hash, created_at, updated_at)
             VALUES ($1, $2, $3, $4::timestamptz, $4::timestamptz)`,
            [id, email, passHash, now]
          );
          await tx.execute(
            `INSERT INTO user_roles (id, user_id, role, granted_by, reason, created_at)
             VALUES ($1, $2, 'admin', $3, 'Provisioned by Super Admin', $4::timestamptz)`,
            [crypto.randomUUID(), id, req.user!.id, now]
          );
          await writeAuditLog(tx, req.user!.id, 'create_admin_account', 'user', id, { username, email });
        },
        { trustedServer: true, actorId: req.user!.id }
      );

      return res.status(201).json({
        admin: {
          id,
          username,
          display_name: displayName,
          email,
          role: 'admin',
          account_status: 'active',
          created_at: now,
        },
      });
    } catch (err) {
      return next(err);
    }
  });

  // Super Admin ONLY: Update an existing admin's password or display name
  router.patch('/admins/:id', requireSuperAdmin, async (req: AuthenticatedRequest, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Admin account not found.' });
      const parsed = z
        .object({
          display_name: z.string().min(2).max(80).optional(),
          password: z
            .string()
            .min(8, 'Password must be at least 8 characters')
            .max(128)
            .regex(/[A-Za-z]/, 'Password must include a letter')
            .regex(/[0-9]/, 'Password must include a number')
            .optional(),
        })
        .safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid update.' });
      }

      const target = await db.queryOne<{ id: string; role: UserRole }>(
        'SELECT id, role FROM profiles WHERE id = $1',
        [req.params.id]
      );
      if (!target || target.role !== 'admin') {
        return res.status(404).json({ error: 'Admin account not found.' });
      }

      await db.transaction(
        async (tx) => {
          if (parsed.data.display_name) {
            await tx.execute('UPDATE profiles SET display_name = $1, updated_at = NOW() WHERE id = $2', [
              parsed.data.display_name.trim(),
              target.id,
            ]);
          }
          if (parsed.data.password) {
            await tx.execute(
              'UPDATE user_credentials SET password_hash = $1, updated_at = NOW() WHERE user_id = $2',
              [hashPassword(parsed.data.password), target.id]
            );
            await tx.execute('DELETE FROM sessions WHERE user_id = $1', [target.id]);
          }
          await writeAuditLog(tx, req.user!.id, 'update_admin_account', 'user', target.id, {
            updated_display_name: Boolean(parsed.data.display_name),
            reset_password: Boolean(parsed.data.password),
          });
        },
        { trustedServer: true, actorId: req.user!.id }
      );
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });

  // Resolve report
  router.patch('/reports/:id', requireModerator, async (req: AuthenticatedRequest, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Report not found.' });
      const parsed = z
        .object({ status: z.enum(['resolved', 'dismissed']), resolution_notes: z.string().max(400).default('') })
        .safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Invalid report resolution.' });

      await db.execute(
        'UPDATE reports SET status = $1, reviewed_by = $2, resolution_notes = $3 WHERE id = $4',
        [parsed.data.status, req.user!.id, parsed.data.resolution_notes.trim() || null, req.params.id]
      );
      await writeAuditLog(db, req.user!.id, `report_${parsed.data.status}`, 'report', req.params.id, {
        resolution_notes: parsed.data.resolution_notes,
      });
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });

  // Profanity dictionary management (English, Devanagari, Romanized Nepali)
  router.get('/profanity', requireModerator, async (_req, res, next) => {
    try {
      const terms = await db.query(
        'SELECT * FROM profanity_dictionary ORDER BY language ASC, severity DESC, term ASC'
      );
      return res.json({ terms });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/profanity', requireAdmin, async (req: AuthenticatedRequest, res, next) => {
    try {
      const parsed = z
        .object({
          term: z.string().min(2).max(60),
          language: z.enum(['en', 'ne_devanagari', 'ne_romanized']),
          severity: z.enum(['low', 'medium', 'high']),
          context_exception_note: z.string().max(240).nullable().optional(),
        })
        .safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Invalid profanity rule.' });

      const id = crypto.randomUUID();
      const norm = normalizeDictionaryTerm(parsed.data.term);
      try {
        await db.execute(
          'INSERT INTO profanity_dictionary (id, term, normalized_term, language, severity, context_exception_note, created_at) VALUES ($1, $2, $3, $4, $5, $6, NOW())',
          [
            id,
            parsed.data.term.trim(),
            norm,
            parsed.data.language,
            parsed.data.severity,
            parsed.data.context_exception_note ?? null,
          ]
        );
      } catch {
        return res.status(409).json({ error: 'This term already exists in the moderation dictionary.' });
      }
      await writeAuditLog(db, req.user!.id, 'add_profanity_term', 'profanity_dictionary', id, parsed.data);
      return res.status(201).json({ id });
    } catch (err) {
      return next(err);
    }
  });

  router.delete('/profanity/:id', requireAdmin, async (req: AuthenticatedRequest, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Term not found.' });
      await db.execute('DELETE FROM profanity_dictionary WHERE id = $1', [req.params.id]);
      await writeAuditLog(db, req.user!.id, 'delete_profanity_term', 'profanity_dictionary', req.params.id, {});
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });

  // Audit logs viewer (Admins & Super Admins)
  router.get('/audit-logs', requireAdmin, async (_req, res, next) => {
    try {
      const logs = await db.query(
        `SELECT a.*, u.display_name AS actor_name, u.username AS actor_username, u.role AS actor_role
         FROM audit_logs a
         LEFT JOIN profiles u ON u.id = a.actor_id
         ORDER BY a.created_at DESC LIMIT 120`
      );
      return res.json({ logs });
    } catch (err) {
      return next(err);
    }
  });

  // Platform settings
  router.get('/settings', requireAdmin, async (_req, res, next) => {
    try {
      const rows = await db.query('SELECT key, value FROM platform_settings');
      return res.json({ settings: rows });
    } catch (err) {
      return next(err);
    }
  });

  router.patch('/settings', requireSuperAdmin, async (req: AuthenticatedRequest, res, next) => {
    try {
      const parsed = z.object({ key: z.string().min(1), value: z.string().min(1) }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Invalid setting payload.' });
      const { key, value } = parsed.data;

      await db.execute(
        `INSERT INTO platform_settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [key, value]
      );
      await writeAuditLog(db, req.user!.id, 'update_platform_setting', 'platform_settings', key, { value });
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });

  // Staff / Faculty Verification Requests (Admin & Super Admin)
  router.get('/staff-verification', requireAdmin, async (req: AuthenticatedRequest, res, next) => {
    try {
      const svExists = await db.queryOne<{ exists: string | null }>(
        "SELECT to_regclass('public.staff_verification_requests')::text AS exists"
      );
      if (!svExists?.exists) {
        return res.json({ requests: [] });
      }

      const statusFilter = req.query.status ? String(req.query.status) : '';
      const validStatus = ['pending', 'approved', 'rejected'].includes(statusFilter);
      const rows = await db.query<Record<string, unknown>>(
        `SELECT sv.id, sv.user_id, sv.position, sv.department, sv.designation, sv.university_email,
                sv.supporting_notes, (sv.evidence_object_path IS NOT NULL) AS has_evidence,
                sv.evidence_original_filename, sv.status, sv.reviewer_id, sv.review_notes,
                sv.reviewed_at, sv.created_at, sv.updated_at,
                u.display_name AS requester_name, u.username AS requester_username,
                u.role AS requester_role, uc.email AS requester_email
         FROM staff_verification_requests sv
         JOIN profiles u ON u.id = sv.user_id
         JOIN user_credentials uc ON uc.user_id = u.id
         ${validStatus ? 'WHERE sv.status = $1' : ''}
         ORDER BY CASE WHEN sv.status = 'pending' THEN 0 ELSE 1 END, sv.created_at DESC
         LIMIT 100`,
        validStatus ? [statusFilter] : []
      );

      return res.json({
        requests: rows.map((r) => ({
          ...r,
          has_evidence: Boolean(r.has_evidence),
          reviewed_at: r.reviewed_at ? new Date(String(r.reviewed_at)).toISOString() : null,
          created_at: new Date(String(r.created_at)).toISOString(),
          updated_at: new Date(String(r.updated_at)).toISOString(),
        })),
      });
    } catch (err) {
      return next(err);
    }
  });

  router.get('/staff-verification/:id/evidence', requireAdmin, async (req: AuthenticatedRequest, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Verification request not found.' });
      const row = await db.queryOne<{
        evidence_object_path: string | null;
        evidence_original_filename: string | null;
        evidence_mime_type: string | null;
      }>(
        'SELECT evidence_object_path, evidence_original_filename, evidence_mime_type FROM staff_verification_requests WHERE id = $1',
        [req.params.id]
      );
      if (!row || !row.evidence_object_path) {
        return res.status(404).json({ error: 'No supporting document attached to this request.' });
      }
      const data = await req.storage!.downloadPrivate(String(row.evidence_object_path));
      if (!data) {
        return res.status(404).json({ error: 'Supporting document not found in private storage.' });
      }

      res.setHeader('Content-Type', row.evidence_mime_type || 'application/octet-stream');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader(
        'Content-Disposition',
        `inline; filename="${row.evidence_original_filename || 'evidence'}"`
      );
      return res.send(data);
    } catch (err) {
      return next(err);
    }
  });

  router.post('/staff-verification/:id/review', requireAdmin, async (req: AuthenticatedRequest, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Verification request not found.' });
      const parsed = z
        .object({
          decision: z.enum(['approved', 'rejected']),
          review_notes: z.string().trim().max(500).default(''),
        })
        .safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Invalid review decision.' });

      const reqRow = await db.queryOne<{
        id: string;
        user_id: string;
        position: string;
        department: string;
        designation: string;
        status: string;
      }>('SELECT id, user_id, position, department, designation, status FROM staff_verification_requests WHERE id = $1', [
        req.params.id,
      ]);

      if (!reqRow) return res.status(404).json({ error: 'Verification request not found.' });
      if (reqRow.status !== 'pending') {
        return res.status(409).json({ error: `This verification request has already been ${reqRow.status}.` });
      }
      if (String(reqRow.user_id) === req.user!.id) {
        return res.status(403).json({ error: 'Administrators cannot approve their own verification request.' });
      }

      await db.transaction(
        async (tx) => {
          await tx.execute(
            `UPDATE staff_verification_requests
             SET status = $1,
                 reviewer_id = $2,
                 review_notes = $3,
                 reviewed_at = NOW(),
                 updated_at = NOW()
             WHERE id = $4`,
            [parsed.data.decision, req.user!.id, parsed.data.review_notes || null, reqRow.id]
          );

          if (parsed.data.decision === 'approved') {
            await tx.execute(
              `UPDATE profiles
               SET role = 'verified_teacher',
                   staff_position = $1,
                   department = $2,
                   designation = $3,
                   profile_completed = TRUE,
                   updated_at = NOW()
               WHERE id = $4`,
              [reqRow.position, reqRow.department, reqRow.designation || null, reqRow.user_id]
            );
            await tx.execute(
              `INSERT INTO user_roles (id, user_id, role, granted_by, reason, created_at)
               VALUES ($1, $2, 'verified_teacher', $3, $4, NOW())`,
              [
                crypto.randomUUID(),
                reqRow.user_id,
                req.user!.id,
                `University staff verification approved (${reqRow.position} · ${reqRow.department})`,
              ]
            );
          }

          await syncModerationQueue(
            tx,
            'staff_verification',
            reqRow.id,
            reqRow.user_id,
            parsed.data.decision,
            req.user!.id,
            parsed.data.review_notes || null
          );

          await writeAuditLog(tx, req.user!.id, `staff_verification_${parsed.data.decision}`, 'staff_verification', reqRow.id, {
            target_user_id: reqRow.user_id,
            position: reqRow.position,
            department: reqRow.department,
            review_notes: parsed.data.review_notes,
          });

          await createNotification(
            tx,
            reqRow.user_id,
            'staff_verification_update',
            parsed.data.decision === 'approved'
              ? 'University Staff Verification Approved'
              : 'University Staff Verification Update',
            parsed.data.decision === 'approved'
              ? `Your verification request (${reqRow.position} · ${reqRow.department}) has been approved.`
              : `Your university staff verification request was declined.${parsed.data.review_notes ? ` Note: ${parsed.data.review_notes}` : ''}`,
            '/profile'
          );
        },
        { trustedServer: true, actorId: req.user!.id }
      );

      return res.json({ ok: true, status: parsed.data.decision });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}
