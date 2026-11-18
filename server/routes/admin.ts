import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { DatabaseSync } from 'node:sqlite';
import {
  type AuthenticatedRequest,
  requireAdmin,
  requireModerator,
  requireSuperAdmin,
} from '../authMiddleware.ts';
import { createNotification, writeAuditLog } from '../db.ts';
import { normalizeDictionaryTerm } from '../profanity.ts';
import { hashPassword } from '../security.ts';
import type { UserRole } from '../../src/types/index.ts';

export function createAdminRouter(db: DatabaseSync): Router {
  const router = Router();

  // Genuine Overview Metrics (never fabricated)
  router.get('/overview', requireModerator, (_req: AuthenticatedRequest, res) => {
    const count = (sql: string) => Number((db.prepare(sql).get() as { cnt: number }).cnt);

    const stats = {
      total_users: count('SELECT COUNT(*) as cnt FROM users'),
      verified_students: count("SELECT COUNT(*) as cnt FROM users WHERE role = 'verified_student' AND university_email_verified = 1"),
      verified_teachers: count("SELECT COUNT(*) as cnt FROM users WHERE role = 'verified_teacher' AND university_email_verified = 1"),
      active_users: count("SELECT COUNT(*) as cnt FROM users WHERE account_status = 'active'"),
      total_communities: count('SELECT COUNT(*) as cnt FROM communities WHERE is_archived = 0'),
      total_posts: count('SELECT COUNT(*) as cnt FROM posts WHERE is_hidden = 0'),
      total_resources: count("SELECT COUNT(*) as cnt FROM resources WHERE status = 'approved'"),
      pending_resources: count("SELECT COUNT(*) as cnt FROM resources WHERE status = 'pending'") +
        count("SELECT COUNT(*) as cnt FROM resource_revisions WHERE status = 'pending' AND resource_id IN (SELECT id FROM resources WHERE status = 'approved')"),
      pending_confessions: count("SELECT COUNT(*) as cnt FROM confessions WHERE status = 'pending'"),
      pending_complaints: count("SELECT COUNT(*) as cnt FROM complaints WHERE status IN ('submitted', 'under_review')"),
      open_reports: count("SELECT COUNT(*) as cnt FROM reports WHERE status = 'open'"),
    };

    const pendingResources = db
      .prepare(
        `SELECT r.id, r.title, r.status, r.created_at, p.code as program_code, sem.name as semester_name, sub.name as subject_name,
                rc.name as category_name, u.display_name as uploader_name, rr.id as revision_id, rr.revision_number, rr.original_filename, rr.file_size
         FROM resource_revisions rr
         JOIN resources r ON r.id = rr.resource_id
         JOIN programs p ON p.id = r.program_id
         JOIN semesters sem ON sem.id = r.semester_id
         JOIN subjects sub ON sub.id = r.subject_id
         JOIN resource_categories rc ON rc.id = r.category_id
         JOIN users u ON u.id = r.uploader_id
         WHERE rr.status = 'pending'
         ORDER BY rr.created_at ASC`
      )
      .all();

    const pendingConfessions = db
      .prepare("SELECT id, title, body, image_url, category, created_at FROM confessions WHERE status = 'pending' ORDER BY created_at ASC")
      .all();

    const pendingOpportunities = db
      .prepare("SELECT o.*, u.display_name as author_name FROM opportunities o JOIN users u ON u.id = o.author_id WHERE o.status = 'pending' ORDER BY o.created_at ASC")
      .all();

    const pendingDonations = db
      .prepare("SELECT d.*, u.display_name as requester_name FROM donation_requests d JOIN users u ON u.id = d.requester_id WHERE d.status = 'pending' ORDER BY d.created_at ASC")
      .all();

    const openReports = db
      .prepare(
        `SELECT rp.*, u.display_name as reporter_name
         FROM reports rp JOIN users u ON u.id = rp.reporter_id
         ORDER BY CASE WHEN rp.status = 'open' THEN 0 ELSE 1 END, rp.created_at DESC LIMIT 50`
      )
      .all();

    return res.json({
      stats,
      queues: {
        pendingResources,
        pendingConfessions,
        pendingOpportunities,
        pendingDonations,
        openReports,
      },
    });
  });

  // User management
  router.get('/users', requireAdmin, (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    const rows = db
      .prepare(
        `SELECT u.id, u.email, u.username, u.display_name, u.role, u.email_verified, u.university_email_verified,
                u.account_status, u.is_demo, u.created_at, p.code as program_code
         FROM users u
         LEFT JOIN programs p ON p.id = u.program_id
         ${q ? 'WHERE lower(u.display_name) LIKE ? OR lower(u.username) LIKE ? OR lower(u.email) LIKE ?' : ''}
         ORDER BY u.created_at DESC LIMIT 100`
      )
      .all(...(q ? [`%${q}%`, `%${q}%`, `%${q}%`] : []));
    return res.json({ users: rows });
  });

  router.patch('/users/:id/status', requireAdmin, (req: AuthenticatedRequest, res) => {
    const { account_status, reason } = z
      .object({ account_status: z.enum(['active', 'suspended', 'restricted']), reason: z.string().max(300).default('') })
      .parse(req.body);

    const target = db.prepare('SELECT role FROM users WHERE id = ?').get(req.params.id) as { role: UserRole } | undefined;
    if (!target) return res.status(404).json({ error: 'User not found.' });
    if (target.role === 'super_admin' && req.user!.role !== 'super_admin') {
      return res.status(403).json({ error: 'Only a Super Admin can modify another Super Admin.' });
    }

    db.prepare('UPDATE users SET account_status = ? WHERE id = ?').run(account_status, req.params.id);
    writeAuditLog(db, req.user!.id, 'update_user_status', 'user', req.params.id, { account_status, reason });
    return res.json({ ok: true });
  });

  router.patch('/users/:id/role', requireAdmin, (req: AuthenticatedRequest, res) => {
    const { role } = z
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
      .parse(req.body);

    if ((role === 'super_admin' || role === 'admin') && req.user!.role !== 'super_admin') {
      return res.status(403).json({ error: 'Only a Super Admin can assign Admin or Super Admin roles.' });
    }

    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, req.params.id);
    writeAuditLog(db, req.user!.id, 'change_user_role', 'user', req.params.id, { new_role: role });
    createNotification(db, req.params.id, 'role_changed', 'Account Role Updated', `Your GandakiHub role was updated to ${role.replace('_', ' ')}.`, '/profile');
    return res.json({ ok: true });
  });

  // Super Admin ONLY: Create dedicated Admin account with username & password
  router.post('/admins', requireSuperAdmin, (req: AuthenticatedRequest, res) => {
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

    if (db.prepare('SELECT id FROM users WHERE lower(username) = ?').get(username)) {
      return res.status(409).json({ error: 'This username is already taken.' });
    }
    if (db.prepare('SELECT id FROM users WHERE lower(email) = ?').get(email)) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO users (id, email, password_hash, username, display_name, bio, role, email_verified, university_email_verified, interests_json, account_status, is_demo, created_at)
       VALUES (?, ?, ?, ?, ?, '', 'admin', 1, 0, '[]', 'active', 0, ?)`
    ).run(id, email, hashPassword(parsed.data.password), username, displayName, now);

    writeAuditLog(db, req.user!.id, 'create_admin_account', 'user', id, { username, email });
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
  });

  // Super Admin ONLY: Update an existing admin's password or display name
  router.patch('/admins/:id', requireSuperAdmin, (req: AuthenticatedRequest, res) => {
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

    const target = db.prepare('SELECT id, role FROM users WHERE id = ?').get(req.params.id) as { id: string; role: UserRole } | undefined;
    if (!target || target.role !== 'admin') {
      return res.status(404).json({ error: 'Admin account not found.' });
    }

    if (parsed.data.display_name) {
      db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(parsed.data.display_name.trim(), target.id);
    }
    if (parsed.data.password) {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(parsed.data.password), target.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
    }
    writeAuditLog(db, req.user!.id, 'update_admin_account', 'user', target.id, {
      updated_display_name: Boolean(parsed.data.display_name),
      reset_password: Boolean(parsed.data.password),
    });
    return res.json({ ok: true });
  });

  // Resolve report
  router.patch('/reports/:id', requireModerator, (req: AuthenticatedRequest, res) => {
    const { status, resolution_notes } = z
      .object({ status: z.enum(['resolved', 'dismissed']), resolution_notes: z.string().max(400).default('') })
      .parse(req.body);
    db.prepare('UPDATE reports SET status = ?, reviewed_by = ?, resolution_notes = ? WHERE id = ?').run(
      status,
      req.user!.id,
      resolution_notes.trim() || null,
      req.params.id
    );
    writeAuditLog(db, req.user!.id, `report_${status}`, 'report', req.params.id, { resolution_notes });
    return res.json({ ok: true });
  });

  // Profanity dictionary management (English, Devanagari, Romanized Nepali)
  router.get('/profanity', requireModerator, (_req, res) => {
    const terms = db.prepare('SELECT * FROM profanity_dictionary ORDER BY language ASC, severity DESC, term ASC').all();
    return res.json({ terms });
  });

  router.post('/profanity', requireAdmin, (req: AuthenticatedRequest, res) => {
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
      db.prepare(
        'INSERT INTO profanity_dictionary (id, term, normalized_term, language, severity, context_exception_note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(id, parsed.data.term.trim(), norm, parsed.data.language, parsed.data.severity, parsed.data.context_exception_note ?? null, new Date().toISOString());
    } catch {
      return res.status(409).json({ error: 'This term already exists in the moderation dictionary.' });
    }
    writeAuditLog(db, req.user!.id, 'add_profanity_term', 'profanity_dictionary', id, parsed.data);
    return res.status(201).json({ id });
  });

  router.delete('/profanity/:id', requireAdmin, (req: AuthenticatedRequest, res) => {
    db.prepare('DELETE FROM profanity_dictionary WHERE id = ?').run(req.params.id);
    writeAuditLog(db, req.user!.id, 'delete_profanity_term', 'profanity_dictionary', req.params.id, {});
    return res.json({ ok: true });
  });

  // Audit logs viewer (Admins & Super Admins)
  router.get('/audit-logs', requireAdmin, (_req, res) => {
    const logs = db
      .prepare(
        `SELECT a.*, u.display_name as actor_name, u.username as actor_username, u.role as actor_role
         FROM audit_logs a
         LEFT JOIN users u ON u.id = a.actor_id
         ORDER BY a.created_at DESC LIMIT 120`
      )
      .all();
    return res.json({ logs });
  });

  // Platform settings
  router.get('/settings', requireAdmin, (_req, res) => {
    const rows = db.prepare('SELECT key, value FROM platform_settings').all();
    return res.json({ settings: rows });
  });

  router.patch('/settings', requireSuperAdmin, (req: AuthenticatedRequest, res) => {
    const { key, value } = z.object({ key: z.string().min(1), value: z.string().min(1) }).parse(req.body);
    db.prepare('INSERT OR REPLACE INTO platform_settings (key, value) VALUES (?, ?)').run(key, value);
    writeAuditLog(db, req.user!.id, 'update_platform_setting', 'platform_settings', key, { value });
    return res.json({ ok: true });
  });

  return router;
}
