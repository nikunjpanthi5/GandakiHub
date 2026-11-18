import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import type { DatabaseSync } from 'node:sqlite';
import {
  type AuthenticatedRequest,
  requireAdmin,
  requireAuth,
  requireModerator,
} from '../authMiddleware.ts';
import { createNotification, getStorageDir, indexSearchEntity, writeAuditLog } from '../db.ts';
import {
  canUploadResources,
  isAdminRole,
  isModeratorOrAbove,
  sanitizeFilename,
  sha256Buffer,
  validatePdfBuffer,
} from '../security.ts';

export function createAcademicRouter(db: DatabaseSync): Router {
  const router = Router();

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 }, // Hard ceiling; real configurable limit enforced below
  });

  // Public read of academic structure
  router.get('/structure', (req, res) => {
    const includeArchived = req.query.includeArchived === 'true';
    const archiveClause = includeArchived ? '' : 'WHERE is_archived = 0';

    const programs = db
      .prepare(`SELECT * FROM programs ${archiveClause} ORDER BY sort_order ASC, code ASC`)
      .all();
    const semesters = db
      .prepare(`SELECT * FROM semesters ${archiveClause} ORDER BY sort_order ASC, number ASC`)
      .all();
    const subjects = db
      .prepare(
        `SELECT s.*,
          (SELECT COUNT(*) FROM resources r WHERE r.subject_id = s.id AND r.status = 'approved') as resource_count
         FROM subjects s ${includeArchived ? '' : 'WHERE s.is_archived = 0'}
         ORDER BY s.sort_order ASC, s.name ASC`
      )
      .all();
    const folders = db
      .prepare(`SELECT * FROM academic_folders ${archiveClause} ORDER BY sort_order ASC, name ASC`)
      .all();
    const categories = db
      .prepare('SELECT * FROM resource_categories ORDER BY sort_order ASC')
      .all();

    return res.json({
      programs: programs.map((p: Record<string, unknown>) => ({ ...p, is_archived: Boolean(p.is_archived) })),
      semesters: semesters.map((s: Record<string, unknown>) => ({ ...s, is_archived: Boolean(s.is_archived) })),
      subjects: subjects.map((sub: Record<string, unknown>) => ({ ...sub, is_archived: Boolean(sub.is_archived) })),
      folders: folders.map((f: Record<string, unknown>) => ({ ...f, is_archived: Boolean(f.is_archived) })),
      categories: categories.map((c: Record<string, unknown>) => ({ ...c, pdf_only: Boolean(c.pdf_only) })),
    });
  });

  // Admin: Create Program (also auto-creates 8 semesters & optional community)
  router.post('/programs', requireAdmin, (req: AuthenticatedRequest, res) => {
    const parsed = z
      .object({
        code: z.string().min(2).max(16),
        name: z.string().min(3).max(120),
        description: z.string().max(400).default(''),
      })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid program.' });

    const { code, name, description } = parsed.data;
    const id = `prog-${code.toLowerCase().replace(/[^a-z0-9]/g, '')}-${crypto.randomUUID().slice(0, 4)}`;
    const now = new Date().toISOString();
    const maxOrder = (db.prepare('SELECT COALESCE(MAX(sort_order), 0) as m FROM programs').get() as { m: number }).m;

    try {
      db.prepare(
        'INSERT INTO programs (id, code, name, description, sort_order, is_archived, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)'
      ).run(id, code.trim().toUpperCase(), name.trim(), description.trim(), maxOrder + 1, now);
    } catch {
      return res.status(409).json({ error: 'Program code already exists.' });
    }

    const semNames = [
      'First Semester',
      'Second Semester',
      'Third Semester',
      'Fourth Semester',
      'Fifth Semester',
      'Sixth Semester',
      'Seventh Semester',
      'Eighth Semester',
    ];
    semNames.forEach((sName, idx) => {
      db.prepare(
        'INSERT INTO semesters (id, program_id, number, name, sort_order, is_archived, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)'
      ).run(`${id}-sem-${idx + 1}`, id, idx + 1, sName, idx + 1, now);
    });

    indexSearchEntity(db, 'program', id, `${code.toUpperCase()} — ${name}`, description, code);
    writeAuditLog(db, req.user!.id, 'create_program', 'program', id, { code, name });
    return res.status(201).json({ id, code: code.toUpperCase(), name, description });
  });

  router.patch('/programs/:id', requireAdmin, (req: AuthenticatedRequest, res) => {
    const parsed = z
      .object({
        code: z.string().min(2).max(16).optional(),
        name: z.string().min(3).max(120).optional(),
        description: z.string().max(400).optional(),
        is_archived: z.boolean().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid program update.' });
    const d = parsed.data;
    db.prepare(
      `UPDATE programs SET
        code = COALESCE(?, code),
        name = COALESCE(?, name),
        description = COALESCE(?, description),
        is_archived = COALESCE(?, is_archived)
       WHERE id = ?`
    ).run(
      d.code?.trim().toUpperCase() ?? null,
      d.name?.trim() ?? null,
      d.description?.trim() ?? null,
      d.is_archived !== undefined ? (d.is_archived ? 1 : 0) : null,
      req.params.id
    );
    writeAuditLog(db, req.user!.id, 'update_program', 'program', req.params.id, d);
    const prog = db.prepare('SELECT * FROM programs WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
    if (prog) {
      indexSearchEntity(db, 'program', String(prog.id), `${prog.code} — ${prog.name}`, String(prog.description || ''), String(prog.code));
    }
    return res.json({ ok: true });
  });

  router.post('/semesters', requireAdmin, (req: AuthenticatedRequest, res) => {
    const parsed = z
      .object({
        program_id: z.string().min(1),
        number: z.number().int().min(1).max(16),
        name: z.string().min(2).max(60),
      })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid semester fields.' });
    const id = `${parsed.data.program_id}-sem-${parsed.data.number}-${crypto.randomUUID().slice(0, 4)}`;
    try {
      db.prepare(
        'INSERT INTO semesters (id, program_id, number, name, sort_order, is_archived, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)'
      ).run(id, parsed.data.program_id, parsed.data.number, parsed.data.name.trim(), parsed.data.number, new Date().toISOString());
    } catch {
      return res.status(409).json({ error: 'Semester number already exists for this program.' });
    }
    writeAuditLog(db, req.user!.id, 'create_semester', 'semester', id, parsed.data);
    return res.status(201).json({ id, ...parsed.data });
  });

  router.patch('/semesters/:id', requireAdmin, (req: AuthenticatedRequest, res) => {
    const parsed = z
      .object({
        name: z.string().min(2).max(60).optional(),
        is_archived: z.boolean().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid semester update.' });
    const d = parsed.data;
    db.prepare(
      `UPDATE semesters SET
        name = COALESCE(?, name),
        is_archived = COALESCE(?, is_archived)
       WHERE id = ?`
    ).run(
      d.name?.trim() ?? null,
      d.is_archived !== undefined ? (d.is_archived ? 1 : 0) : null,
      req.params.id
    );
    writeAuditLog(db, req.user!.id, 'update_semester', 'semester', req.params.id, d);
    return res.json({ ok: true });
  });

  router.post('/subjects', requireAdmin, (req: AuthenticatedRequest, res) => {
    const parsed = z
      .object({
        program_id: z.string().min(1),
        semester_id: z.string().min(1),
        code: z.string().max(24).default(''),
        name: z.string().min(2).max(120),
        description: z.string().max(400).default(''),
      })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid subject.' });

    const maxOrder = (
      db.prepare('SELECT COALESCE(MAX(sort_order), 0) as m FROM subjects WHERE semester_id = ?').get(parsed.data.semester_id) as { m: number }
    ).m;
    const id = `subj-${crypto.randomUUID().slice(0, 8)}`;
    db.prepare(
      'INSERT INTO subjects (id, program_id, semester_id, code, name, description, sort_order, is_archived, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)'
    ).run(
      id,
      parsed.data.program_id,
      parsed.data.semester_id,
      parsed.data.code.trim(),
      parsed.data.name.trim(),
      parsed.data.description.trim(),
      maxOrder + 1,
      new Date().toISOString()
    );

    const prog = db.prepare('SELECT code FROM programs WHERE id = ?').get(parsed.data.program_id) as { code: string } | undefined;
    const sem = db.prepare('SELECT name FROM semesters WHERE id = ?').get(parsed.data.semester_id) as { name: string } | undefined;
    indexSearchEntity(
      db,
      'subject',
      id,
      `${parsed.data.name.trim()} (${prog?.code || ''} · ${sem?.name || ''})`,
      parsed.data.description,
      `${prog?.code || ''} ${sem?.name || ''}`
    );
    writeAuditLog(db, req.user!.id, 'create_subject', 'subject', id, parsed.data);
    return res.status(201).json({ id, ...parsed.data, sort_order: maxOrder + 1, is_archived: false });
  });

  router.patch('/subjects/:id', requireAdmin, (req: AuthenticatedRequest, res) => {
    const parsed = z
      .object({
        name: z.string().min(2).max(120).optional(),
        code: z.string().max(24).optional(),
        description: z.string().max(400).optional(),
        sort_order: z.number().int().min(0).optional(),
        is_archived: z.boolean().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid subject update.' });
    const d = parsed.data;
    db.prepare(
      `UPDATE subjects SET
        name = COALESCE(?, name),
        code = COALESCE(?, code),
        description = COALESCE(?, description),
        sort_order = COALESCE(?, sort_order),
        is_archived = COALESCE(?, is_archived)
       WHERE id = ?`
    ).run(
      d.name?.trim() ?? null,
      d.code?.trim() ?? null,
      d.description?.trim() ?? null,
      d.sort_order ?? null,
      d.is_archived !== undefined ? (d.is_archived ? 1 : 0) : null,
      req.params.id
    );

    const sub = db
      .prepare(
        'SELECT s.*, p.code as p_code, sem.name as sem_name FROM subjects s JOIN programs p ON p.id = s.program_id JOIN semesters sem ON sem.id = s.semester_id WHERE s.id = ?'
      )
      .get(req.params.id) as Record<string, unknown> | undefined;
    if (sub) {
      indexSearchEntity(
        db,
        'subject',
        String(sub.id),
        `${sub.name} (${sub.p_code} · ${sub.sem_name})`,
        String(sub.description || ''),
        `${sub.p_code} ${sub.sem_name}`
      );
    }
    writeAuditLog(db, req.user!.id, 'update_subject', 'subject', req.params.id, d);
    return res.json({ ok: true });
  });

  // Folders (nested subtopics under subjects) — Admin only
  router.post('/folders', requireAdmin, (req: AuthenticatedRequest, res) => {
    const parsed = z
      .object({
        subject_id: z.string().min(1),
        parent_folder_id: z.string().nullable().optional(),
        name: z.string().min(2).max(100),
      })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid folder fields.' });
    const id = `folder-${crypto.randomUUID().slice(0, 8)}`;
    const maxOrder = (
      db.prepare('SELECT COALESCE(MAX(sort_order), 0) as m FROM academic_folders WHERE subject_id = ?').get(parsed.data.subject_id) as { m: number }
    ).m;
    db.prepare(
      'INSERT INTO academic_folders (id, subject_id, parent_folder_id, name, sort_order, is_archived, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)'
    ).run(id, parsed.data.subject_id, parsed.data.parent_folder_id ?? null, parsed.data.name.trim(), maxOrder + 1, new Date().toISOString());
    writeAuditLog(db, req.user!.id, 'create_folder', 'academic_folder', id, parsed.data);
    return res.status(201).json({ id, ...parsed.data });
  });

  router.patch('/folders/:id', requireAdmin, (req: AuthenticatedRequest, res) => {
    const parsed = z
      .object({
        name: z.string().min(2).max(100).optional(),
        sort_order: z.number().int().min(0).optional(),
        is_archived: z.boolean().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid folder update.' });
    const d = parsed.data;
    db.prepare(
      `UPDATE academic_folders SET
        name = COALESCE(?, name),
        sort_order = COALESCE(?, sort_order),
        is_archived = COALESCE(?, is_archived)
       WHERE id = ?`
    ).run(
      d.name?.trim() ?? null,
      d.sort_order ?? null,
      d.is_archived !== undefined ? (d.is_archived ? 1 : 0) : null,
      req.params.id
    );
    writeAuditLog(db, req.user!.id, 'update_folder', 'academic_folder', req.params.id, d);
    return res.json({ ok: true });
  });

  // Categories management (Admin)
  router.post('/categories', requireAdmin, (req: AuthenticatedRequest, res) => {
    const parsed = z
      .object({
        name: z.string().min(2).max(60),
        description: z.string().max(200).default(''),
        pdf_only: z.boolean().default(true),
      })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid category.' });
    const slug = parsed.data.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const id = `cat-${slug}-${crypto.randomUUID().slice(0, 4)}`;
    const maxOrder = (db.prepare('SELECT COALESCE(MAX(sort_order), 0) as m FROM resource_categories').get() as { m: number }).m;
    db.prepare(
      'INSERT INTO resource_categories (id, slug, name, description, pdf_only, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, slug, parsed.data.name.trim(), parsed.data.description.trim(), parsed.data.pdf_only ? 1 : 0, maxOrder + 1);
    writeAuditLog(db, req.user!.id, 'create_category', 'resource_category', id, parsed.data);
    return res.status(201).json({ id, slug, ...parsed.data });
  });

  router.patch('/categories/:id', requireAdmin, (req: AuthenticatedRequest, res) => {
    const parsed = z
      .object({
        name: z.string().min(2).max(60).optional(),
        description: z.string().max(200).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid category update.' });
    db.prepare(
      'UPDATE resource_categories SET name = COALESCE(?, name), description = COALESCE(?, description) WHERE id = ?'
    ).run(parsed.data.name?.trim() ?? null, parsed.data.description?.trim() ?? null, req.params.id);
    writeAuditLog(db, req.user!.id, 'update_category', 'resource_category', req.params.id, parsed.data);
    return res.json({ ok: true });
  });

  // List resources with hierarchy & sort filters
  router.get('/resources', (req: AuthenticatedRequest, res) => {
    const { program_id, semester_id, subject_id, category_id, folder_id, sort, mine, status } = req.query as Record<string, string>;
    const viewerId = req.user?.id || '';
    const isMod = req.user ? isModeratorOrAbove(req.user.role) : false;

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (mine === 'true' && req.user) {
      conditions.push('r.uploader_id = ?');
      params.push(req.user.id);
    } else if (status && isMod) {
      conditions.push('r.status = ?');
      params.push(status);
    } else {
      conditions.push("(r.status = 'approved' OR r.uploader_id = ?)");
      params.push(viewerId);
    }

    if (program_id) {
      conditions.push('r.program_id = ?');
      params.push(program_id);
    }
    if (semester_id) {
      conditions.push('r.semester_id = ?');
      params.push(semester_id);
    }
    if (subject_id) {
      conditions.push('r.subject_id = ?');
      params.push(subject_id);
    }
    if (category_id) {
      conditions.push('r.category_id = ?');
      params.push(category_id);
    }
    if (folder_id) {
      conditions.push('r.folder_id = ?');
      params.push(folder_id);
    }

    let orderBy = 'r.created_at DESC';
    if (sort === 'downloads') orderBy = 'r.download_count DESC, r.created_at DESC';
    else if (sort === 'upvotes') orderBy = 'r.upvote_count DESC, r.created_at DESC';

    const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = db
      .prepare(
        `SELECT r.*,
                rc.name as category_name, rc.slug as category_slug,
                p.code as program_code, p.name as program_name,
                sem.name as semester_name,
                sub.name as subject_name,
                f.name as folder_name,
                u.display_name as uploader_name, u.username as uploader_username, u.role as uploader_role,
                COALESCE(rev_cur.revision_number, rev_latest.revision_number, 1) as revision_number,
                COALESCE(rev_cur.file_size, rev_latest.file_size, 0) as file_size,
                COALESCE(rev_cur.original_filename, rev_latest.original_filename, 'document.pdf') as original_filename,
                (SELECT value FROM votes v WHERE v.user_id = ? AND v.target_type = 'resource' AND v.target_id = r.id) as user_vote,
                (SELECT 1 FROM bookmarks b WHERE b.user_id = ? AND b.target_type = 'resource' AND b.target_id = r.id) as is_bookmarked,
                (SELECT COUNT(*) FROM resource_revisions rr WHERE rr.resource_id = r.id AND rr.status = 'pending') as pending_rev_count
         FROM resources r
         JOIN resource_categories rc ON rc.id = r.category_id
         JOIN programs p ON p.id = r.program_id
         JOIN semesters sem ON sem.id = r.semester_id
         JOIN subjects sub ON sub.id = r.subject_id
         LEFT JOIN academic_folders f ON f.id = r.folder_id
         JOIN users u ON u.id = r.uploader_id
         LEFT JOIN resource_revisions rev_cur ON rev_cur.id = r.current_revision_id
         LEFT JOIN resource_revisions rev_latest ON rev_latest.id = (
           SELECT id FROM resource_revisions WHERE resource_id = r.id ORDER BY revision_number DESC LIMIT 1
         )
         ${whereSql}
         ORDER BY ${orderBy}
         LIMIT 100`
      )
      .all(viewerId, viewerId, ...params) as Record<string, unknown>[];

    const formatted = rows.map((r) => ({
      ...r,
      user_vote: Number(r.user_vote || 0),
      is_bookmarked: Boolean(r.is_bookmarked),
      has_pending_revision: Number(r.pending_rev_count || 0) > 0,
      is_demo: Boolean(r.is_demo),
    }));

    return res.json({ resources: formatted });
  });

  // Upload new PDF Academic Resource
  router.post('/resources', requireAuth, upload.single('file'), (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    if (!canUploadResources(user.role)) {
      return res.status(403).json({ error: 'Only verified university students, teachers, moderators, or admins can upload academic resources.' });
    }

    const parsed = z
      .object({
        title: z.string().min(4, 'Enter a meaningful document title (at least 4 characters).').max(180),
        description: z.string().min(5).max(1000),
        category_id: z.string().min(1),
        program_id: z.string().min(1),
        semester_id: z.string().min(1),
        subject_id: z.string().min(1),
        folder_id: z.string().optional().nullable(),
        academic_year: z.string().min(4).max(20),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'All required hierarchy and document fields must be filled.' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Please attach a PDF document.' });
    }

    const maxMbSetting = db.prepare("SELECT value FROM platform_settings WHERE key = 'max_upload_mb'").get() as { value: string } | undefined;
    const maxBytes = (Number(maxMbSetting?.value || 10)) * 1024 * 1024;
    if (req.file.size > maxBytes) {
      return res.status(413).json({ error: `File exceeds maximum allowed upload size of ${maxBytes / (1024 * 1024)} MB.` });
    }

    // Validate extension & PDF magic bytes + structure
    const ext = path.extname(req.file.originalname).toLowerCase();
    if (ext !== '.pdf') {
      return res.status(400).json({ error: 'Only .pdf files are accepted for academic resource uploads.' });
    }
    if (req.file.mimetype !== 'application/pdf' && req.file.mimetype !== 'application/x-pdf') {
      return res.status(400).json({ error: `Rejected invalid MIME type (${req.file.mimetype}). Only application/pdf is permitted.` });
    }

    const pdfCheck = validatePdfBuffer(req.file.buffer);
    if (!pdfCheck.valid) {
      return res.status(400).json({ error: pdfCheck.reason || 'Invalid PDF document.' });
    }

    // Verify hierarchy foreign keys exist and match
    const subj = db
      .prepare('SELECT id, program_id, semester_id FROM subjects WHERE id = ? AND is_archived = 0')
      .get(parsed.data.subject_id) as { id: string; program_id: string; semester_id: string } | undefined;
    if (!subj || subj.program_id !== parsed.data.program_id || subj.semester_id !== parsed.data.semester_id) {
      return res.status(400).json({ error: 'Selected subject does not belong to the selected program and semester.' });
    }

    const hash = sha256Buffer(req.file.buffer);
    const duplicate = db
      .prepare(
        `SELECT r.title FROM resource_revisions rev
         JOIN resources r ON r.id = rev.resource_id
         WHERE rev.sha256_hash = ? AND r.subject_id = ? AND r.status != 'rejected' LIMIT 1`
      )
      .get(hash, parsed.data.subject_id) as { title: string } | undefined;
    if (duplicate) {
      return res.status(409).json({
        error: `Duplicate PDF detected for this subject ("${duplicate.title}" has identical file content).`,
      });
    }

    const resourceId = `res-${crypto.randomUUID().slice(0, 10)}`;
    const revId = `rev-${crypto.randomUUID().slice(0, 10)}`;
    const safeName = sanitizeFilename(req.file.originalname);
    const diskName = `${revId}_${safeName}`;
    fs.writeFileSync(path.join(getStorageDir(), diskName), req.file.buffer);

    const autoApprove = isAdminRole(user.role);
    const initialStatus = autoApprove ? 'approved' : 'pending';
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO resources (id, title, description, category_id, program_id, semester_id, subject_id, folder_id, academic_year, uploader_id, status, current_revision_id, download_count, upvote_count, is_demo, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?)`
    ).run(
      resourceId,
      parsed.data.title.trim(),
      parsed.data.description.trim(),
      parsed.data.category_id,
      parsed.data.program_id,
      parsed.data.semester_id,
      parsed.data.subject_id,
      parsed.data.folder_id || null,
      parsed.data.academic_year.trim(),
      user.id,
      initialStatus,
      autoApprove ? revId : null,
      now,
      now
    );

    db.prepare(
      `INSERT INTO resource_revisions (id, resource_id, revision_number, file_path, original_filename, sanitized_filename, file_size, sha256_hash, mime_type, extracted_text, status, reviewer_id, review_notes, created_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, 'application/pdf', '', ?, ?, ?, ?)`
    ).run(
      revId,
      resourceId,
      diskName,
      req.file.originalname,
      safeName,
      req.file.size,
      hash,
      initialStatus,
      autoApprove ? user.id : null,
      autoApprove ? 'Published directly by administrator.' : null,
      now
    );

    if (autoApprove) {
      indexSearchEntity(db, 'resource', resourceId, parsed.data.title.trim(), parsed.data.description.trim(), `${parsed.data.academic_year} ${safeName}`);
    }

    writeAuditLog(db, user.id, 'upload_resource', 'resource', resourceId, { status: initialStatus, file_size: req.file.size });
    return res.status(201).json({
      id: resourceId,
      status: initialStatus,
      message: autoApprove
        ? 'Resource uploaded and published.'
        : 'Resource uploaded and submitted to the moderator review queue.',
    });
  });

  // Edit own resource — if approved, creates a pending revision while keeping existing approved file live!
  router.put('/resources/:id', requireAuth, upload.single('file'), (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const resource = db.prepare('SELECT * FROM resources WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
    if (!resource) return res.status(404).json({ error: 'Resource not found.' });

    if (String(resource.uploader_id) !== user.id && !isAdminRole(user.role)) {
      return res.status(403).json({ error: 'You may only edit your own uploaded resources.' });
    }

    const parsed = z
      .object({
        title: z.string().min(4).max(180).optional(),
        description: z.string().min(5).max(1000).optional(),
        academic_year: z.string().min(4).max(20).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid edit fields.' });

    const now = new Date().toISOString();
    const isApproved = String(resource.status) === 'approved';

    if (req.file) {
      const ext = path.extname(req.file.originalname).toLowerCase();
      if (ext !== '.pdf') return res.status(400).json({ error: 'Replacement file must be a PDF.' });
      const pdfCheck = validatePdfBuffer(req.file.buffer);
      if (!pdfCheck.valid) return res.status(400).json({ error: pdfCheck.reason || 'Invalid PDF file.' });

      const maxRev = (
        db.prepare('SELECT COALESCE(MAX(revision_number), 0) as m FROM resource_revisions WHERE resource_id = ?').get(req.params.id) as { m: number }
      ).m;
      const revId = `rev-${crypto.randomUUID().slice(0, 10)}`;
      const safeName = sanitizeFilename(req.file.originalname);
      const diskName = `${revId}_${safeName}`;
      fs.writeFileSync(path.join(getStorageDir(), diskName), req.file.buffer);

      const newRevStatus = isAdminRole(user.role) ? 'approved' : 'pending';
      db.prepare(
        `INSERT INTO resource_revisions (id, resource_id, revision_number, file_path, original_filename, sanitized_filename, file_size, sha256_hash, mime_type, extracted_text, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'application/pdf', '', ?, ?)`
      ).run(revId, req.params.id, maxRev + 1, diskName, req.file.originalname, safeName, req.file.size, sha256Buffer(req.file.buffer), newRevStatus, now);

      if (newRevStatus === 'approved') {
        db.prepare('UPDATE resources SET current_revision_id = ?, updated_at = ? WHERE id = ?').run(revId, now, req.params.id);
      }
    }

    if (isApproved && !isAdminRole(user.role) && !req.file) {
      // Metadata edit on an approved resource creates a pending revision marker referencing current file
      const curRev = db.prepare('SELECT * FROM resource_revisions WHERE id = ?').get(String(resource.current_revision_id)) as Record<string, unknown> | undefined;
      if (curRev) {
        const maxRev = (
          db.prepare('SELECT COALESCE(MAX(revision_number), 0) as m FROM resource_revisions WHERE resource_id = ?').get(req.params.id) as { m: number }
        ).m;
        const revId = `rev-${crypto.randomUUID().slice(0, 10)}`;
        db.prepare(
          `INSERT INTO resource_revisions (id, resource_id, revision_number, file_path, original_filename, sanitized_filename, file_size, sha256_hash, mime_type, extracted_text, status, review_notes, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'application/pdf', '', 'pending', ?, ?)`
        ).run(
          revId,
          req.params.id,
          maxRev + 1,
          String(curRev.file_path),
          String(curRev.original_filename),
          String(curRev.sanitized_filename),
          Number(curRev.file_size),
          String(curRev.sha256_hash),
          JSON.stringify({ pending_title: parsed.data.title, pending_description: parsed.data.description }),
          now
        );
      }
      return res.json({
        ok: true,
        pendingReview: true,
        message: 'Edit submitted as a pending revision. The previously approved version remains live until reviewed.',
      });
    }

    db.prepare(
      `UPDATE resources SET
        title = COALESCE(?, title),
        description = COALESCE(?, description),
        academic_year = COALESCE(?, academic_year),
        updated_at = ?
       WHERE id = ?`
    ).run(
      parsed.data.title?.trim() ?? null,
      parsed.data.description?.trim() ?? null,
      parsed.data.academic_year?.trim() ?? null,
      now,
      req.params.id
    );

    return res.json({ ok: true, message: 'Resource updated.' });
  });

  // Delete own resource
  router.delete('/resources/:id', requireAuth, (req: AuthenticatedRequest, res) => {
    const resource = db.prepare('SELECT * FROM resources WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
    if (!resource) return res.status(404).json({ error: 'Resource not found.' });
    if (String(resource.uploader_id) !== req.user!.id && !isAdminRole(req.user!.role)) {
      return res.status(403).json({ error: 'Only the resource uploader or an administrator can delete this resource.' });
    }
    db.prepare('DELETE FROM resources WHERE id = ?').run(req.params.id);
    db.prepare("DELETE FROM search_index WHERE entity_type = 'resource' AND entity_id = ?").run(req.params.id);
    writeAuditLog(db, req.user!.id, 'delete_resource', 'resource', req.params.id, {});
    return res.json({ ok: true });
  });

  // Authorized PDF Preview / Download stream (never exposes private storage paths publicly!)
  router.get('/resources/:id/file', (req: AuthenticatedRequest, res) => {
    const resource = db.prepare('SELECT * FROM resources WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
    if (!resource) return res.status(404).json({ error: 'Resource not found.' });

    const isOwner = req.user?.id === String(resource.uploader_id);
    const isMod = req.user ? isModeratorOrAbove(req.user.role) : false;

    if (String(resource.status) !== 'approved' && !isOwner && !isMod) {
      return res.status(403).json({ error: 'Unauthorized: pending or rejected resources cannot be downloaded publicly.' });
    }

    const revId = req.query.revisionId
      ? String(req.query.revisionId)
      : String(resource.current_revision_id || '');

    let rev = revId
      ? (db.prepare('SELECT * FROM resource_revisions WHERE id = ? AND resource_id = ?').get(revId, req.params.id) as Record<string, unknown> | undefined)
      : undefined;

    if (!rev) {
      rev = db
        .prepare('SELECT * FROM resource_revisions WHERE resource_id = ? ORDER BY revision_number DESC LIMIT 1')
        .get(req.params.id) as Record<string, unknown> | undefined;
    }

    if (!rev) return res.status(404).json({ error: 'Revision file not found.' });

    const fullPath = path.join(getStorageDir(), path.basename(String(rev.file_path)));
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'Stored PDF file could not be located.' });
    }

    const mode = req.query.download === '1' ? 'attachment' : 'inline';
    if (req.query.download === '1' && String(resource.status) === 'approved') {
      db.prepare('UPDATE resources SET download_count = download_count + 1 WHERE id = ?').run(req.params.id);
      db.prepare('INSERT INTO resource_downloads (id, resource_id, user_id, created_at) VALUES (?, ?, ?, ?)').run(
        crypto.randomUUID(),
        req.params.id,
        req.user?.id ?? null,
        new Date().toISOString()
      );
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${mode}; filename="${sanitizeFilename(String(rev.original_filename))}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.sendFile(fullPath);
  });

  // Resource revision history
  router.get('/resources/:id/revisions', (req: AuthenticatedRequest, res) => {
    const resource = db.prepare('SELECT * FROM resources WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
    if (!resource) return res.status(404).json({ error: 'Resource not found.' });
    const isOwner = req.user?.id === String(resource.uploader_id);
    const isMod = req.user ? isModeratorOrAbove(req.user.role) : false;

    const revisions = db
      .prepare(
        `SELECT rr.id, rr.resource_id, rr.revision_number, rr.original_filename, rr.file_size, rr.sha256_hash, rr.status, rr.reviewer_id, rr.review_notes, rr.created_at,
                u.display_name as reviewer_name
         FROM resource_revisions rr
         LEFT JOIN users u ON u.id = rr.reviewer_id
         WHERE rr.resource_id = ? ${isOwner || isMod ? '' : "AND rr.status = 'approved'"}
         ORDER BY rr.revision_number DESC`
      )
      .all(req.params.id);

    return res.json({ revisions });
  });

  // Review resource or revision (Moderator / Admin)
  router.post('/resources/:id/review', requireModerator, (req: AuthenticatedRequest, res) => {
    const parsed = z
      .object({
        decision: z.enum(['approved', 'rejected', 'changes_requested']),
        revision_id: z.string().optional(),
        review_notes: z.string().max(500).default(''),
      })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid review decision.' });

    const resource = db.prepare('SELECT * FROM resources WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
    if (!resource) return res.status(404).json({ error: 'Resource not found.' });

    const targetRev = parsed.data.revision_id
      ? (db.prepare('SELECT * FROM resource_revisions WHERE id = ? AND resource_id = ?').get(parsed.data.revision_id, req.params.id) as Record<string, unknown> | undefined)
      : (db.prepare('SELECT * FROM resource_revisions WHERE resource_id = ? ORDER BY revision_number DESC LIMIT 1').get(req.params.id) as Record<string, unknown> | undefined);

    if (!targetRev) return res.status(404).json({ error: 'Revision not found.' });

    db.prepare('UPDATE resource_revisions SET status = ?, reviewer_id = ?, review_notes = ? WHERE id = ?').run(
      parsed.data.decision,
      req.user!.id,
      parsed.data.review_notes.trim() || null,
      String(targetRev.id)
    );

    if (parsed.data.decision === 'approved') {
      db.prepare("UPDATE resources SET status = 'approved', current_revision_id = ?, updated_at = ? WHERE id = ?").run(
        String(targetRev.id),
        new Date().toISOString(),
        req.params.id
      );
      indexSearchEntity(
        db,
        'resource',
        req.params.id,
        String(resource.title),
        String(resource.description || ''),
        `${resource.academic_year} ${targetRev.original_filename}`
      );
    } else if (!resource.current_revision_id) {
      db.prepare('UPDATE resources SET status = ?, updated_at = ? WHERE id = ?').run(
        parsed.data.decision,
        new Date().toISOString(),
        req.params.id
      );
    }

    createNotification(
      db,
      String(resource.uploader_id),
      `resource_${parsed.data.decision}`,
      `Resource ${parsed.data.decision.replace('_', ' ')}`,
      `"${resource.title}" was reviewed: ${parsed.data.review_notes || parsed.data.decision}.`,
      '/academic'
    );
    writeAuditLog(db, req.user!.id, 'review_resource', 'resource', req.params.id, {
      decision: parsed.data.decision,
      revision_id: targetRev.id,
    });

    return res.json({ ok: true });
  });

  return router;
}
