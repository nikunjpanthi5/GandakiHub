import crypto from 'node:crypto';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import {
  type AuthenticatedRequest,
  requireAdmin,
  requireAuth,
  requireModerator,
} from '../authMiddleware.ts';
import { type AppDatabase, createNotification, syncModerationQueue, writeAuditLog } from '../db.ts';
import {
  canUploadResources,
  isAdminRole,
  isModeratorOrAbove,
  isUuid,
  sanitizeFilename,
  sha256Buffer,
  validatePdfBuffer,
} from '../security.ts';

export function createAcademicRouter(db: AppDatabase): Router {
  const router = Router();

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 },
  });

  // Public read of academic structure
  router.get('/structure', async (req, res, next) => {
    try {
      const includeArchived = req.query.includeArchived === 'true';
      const archiveClause = includeArchived ? '' : 'WHERE is_archived = FALSE';

      const [programs, semesters, subjects, folders, categories] = await Promise.all([
        db.query<Record<string, unknown>>(
          `SELECT * FROM programs ${archiveClause} ORDER BY sort_order ASC, code ASC`
        ),
        db.query<Record<string, unknown>>(
          `SELECT * FROM semesters ${archiveClause} ORDER BY sort_order ASC, number ASC`
        ),
        db.query<Record<string, unknown>>(
          `SELECT s.*,
            (SELECT COUNT(*) FROM resources r WHERE r.subject_id = s.id AND r.status = 'approved') AS resource_count
           FROM subjects s ${includeArchived ? '' : 'WHERE s.is_archived = FALSE'}
           ORDER BY s.sort_order ASC, s.name ASC`
        ),
        db.query<Record<string, unknown>>(
          `SELECT * FROM academic_folders ${archiveClause} ORDER BY sort_order ASC, name ASC`
        ),
        db.query<Record<string, unknown>>('SELECT * FROM resource_categories ORDER BY sort_order ASC'),
      ]);

      return res.json({
        programs: programs.map((p) => ({ ...p, is_archived: Boolean(p.is_archived) })),
        semesters: semesters.map((s) => ({ ...s, is_archived: Boolean(s.is_archived) })),
        subjects: subjects.map((sub) => ({
          ...sub,
          is_archived: Boolean(sub.is_archived),
          resource_count: Number(sub.resource_count || 0),
        })),
        folders: folders.map((f) => ({ ...f, is_archived: Boolean(f.is_archived) })),
        categories: categories.map((c) => ({ ...c, pdf_only: Boolean(c.pdf_only) })),
      });
    } catch (err) {
      return next(err);
    }
  });

  // Admin: Create Program (auto-creates 8 semesters)
  router.post('/programs', requireAdmin, async (req: AuthenticatedRequest, res, next) => {
    try {
      const parsed = z
        .object({
          code: z.string().min(2).max(16),
          name: z.string().min(3).max(120),
          description: z.string().max(400).default(''),
        })
        .safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid program.' });
      }

      const code = parsed.data.code.trim().toUpperCase();
      const name = parsed.data.name.trim();
      const description = parsed.data.description.trim();
      const id = crypto.randomUUID();

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

      try {
        await db.transaction(async (tx) => {
          const maxRow = await tx.queryOne<{ m: string | number }>(
            'SELECT COALESCE(MAX(sort_order), 0) AS m FROM programs'
          );
          const maxOrder = Number(maxRow?.m || 0);

          await tx.execute(
            'INSERT INTO programs (id, code, name, description, sort_order, is_archived, created_at) VALUES ($1, $2, $3, $4, $5, FALSE, NOW())',
            [id, code, name, description, maxOrder + 1]
          );

          for (let idx = 0; idx < semNames.length; idx++) {
            await tx.execute(
              'INSERT INTO semesters (id, program_id, number, name, sort_order, is_archived, created_at) VALUES ($1, $2, $3, $4, $5, FALSE, NOW())',
              [crypto.randomUUID(), id, idx + 1, semNames[idx], idx + 1]
            );
          }

          await writeAuditLog(tx, req.user!.id, 'create_program', 'program', id, { code, name });
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : '';
        if (msg.toLowerCase().includes('unique')) {
          return res.status(409).json({ error: 'Program code already exists.' });
        }
        throw err;
      }

      return res.status(201).json({ id, code, name, description });
    } catch (err) {
      return next(err);
    }
  });

  router.patch('/programs/:id', requireAdmin, async (req: AuthenticatedRequest, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Program not found.' });
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

      await db.execute(
        `UPDATE programs SET
          code = COALESCE($1, code),
          name = COALESCE($2, name),
          description = COALESCE($3, description),
          is_archived = COALESCE($4, is_archived)
         WHERE id = $5`,
        [
          d.code?.trim().toUpperCase() ?? null,
          d.name?.trim() ?? null,
          d.description?.trim() ?? null,
          d.is_archived ?? null,
          req.params.id,
        ]
      );
      await writeAuditLog(db, req.user!.id, 'update_program', 'program', req.params.id, d);
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/semesters', requireAdmin, async (req: AuthenticatedRequest, res, next) => {
    try {
      const parsed = z
        .object({
          program_id: z.string().min(1),
          number: z.number().int().min(1).max(16),
          name: z.string().min(2).max(60),
        })
        .safeParse(req.body);
      if (!parsed.success || !isUuid(parsed.data.program_id)) {
        return res.status(400).json({ error: 'Invalid semester fields.' });
      }
      const id = crypto.randomUUID();
      try {
        await db.execute(
          'INSERT INTO semesters (id, program_id, number, name, sort_order, is_archived, created_at) VALUES ($1, $2, $3, $4, $5, FALSE, NOW())',
          [id, parsed.data.program_id, parsed.data.number, parsed.data.name.trim(), parsed.data.number]
        );
      } catch {
        return res.status(409).json({ error: 'Semester number already exists for this program.' });
      }
      await writeAuditLog(db, req.user!.id, 'create_semester', 'semester', id, parsed.data);
      return res.status(201).json({ id, ...parsed.data });
    } catch (err) {
      return next(err);
    }
  });

  router.patch('/semesters/:id', requireAdmin, async (req: AuthenticatedRequest, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Semester not found.' });
      const parsed = z
        .object({
          name: z.string().min(2).max(60).optional(),
          is_archived: z.boolean().optional(),
        })
        .safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Invalid semester update.' });
      const d = parsed.data;
      await db.execute(
        `UPDATE semesters SET
          name = COALESCE($1, name),
          is_archived = COALESCE($2, is_archived)
         WHERE id = $3`,
        [d.name?.trim() ?? null, d.is_archived ?? null, req.params.id]
      );
      await writeAuditLog(db, req.user!.id, 'update_semester', 'semester', req.params.id, d);
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/subjects', requireAdmin, async (req: AuthenticatedRequest, res, next) => {
    try {
      const parsed = z
        .object({
          program_id: z.string().min(1),
          semester_id: z.string().min(1),
          code: z.string().max(24).default(''),
          name: z.string().min(2).max(120),
          description: z.string().max(400).default(''),
        })
        .safeParse(req.body);
      if (!parsed.success || !isUuid(parsed.data.program_id) || !isUuid(parsed.data.semester_id)) {
        return res.status(400).json({ error: 'Invalid subject fields.' });
      }

      const maxRow = await db.queryOne<{ m: string | number }>(
        'SELECT COALESCE(MAX(sort_order), 0) AS m FROM subjects WHERE semester_id = $1',
        [parsed.data.semester_id]
      );
      const maxOrder = Number(maxRow?.m || 0);
      const id = crypto.randomUUID();
      await db.execute(
        'INSERT INTO subjects (id, program_id, semester_id, code, name, description, sort_order, is_archived, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, NOW())',
        [
          id,
          parsed.data.program_id,
          parsed.data.semester_id,
          parsed.data.code.trim(),
          parsed.data.name.trim(),
          parsed.data.description.trim(),
          maxOrder + 1,
        ]
      );
      await writeAuditLog(db, req.user!.id, 'create_subject', 'subject', id, parsed.data);
      return res.status(201).json({ id, ...parsed.data, sort_order: maxOrder + 1, is_archived: false });
    } catch (err) {
      return next(err);
    }
  });

  router.patch('/subjects/:id', requireAdmin, async (req: AuthenticatedRequest, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Subject not found.' });
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

      await db.execute(
        `UPDATE subjects SET
          name = COALESCE($1, name),
          code = COALESCE($2, code),
          description = COALESCE($3, description),
          sort_order = COALESCE($4, sort_order),
          is_archived = COALESCE($5, is_archived)
         WHERE id = $6`,
        [
          d.name?.trim() ?? null,
          d.code?.trim() ?? null,
          d.description?.trim() ?? null,
          d.sort_order ?? null,
          d.is_archived ?? null,
          req.params.id,
        ]
      );
      await writeAuditLog(db, req.user!.id, 'update_subject', 'subject', req.params.id, d);
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });

  // Folders (nested subtopics under subjects) — Admin only
  router.post('/folders', requireAdmin, async (req: AuthenticatedRequest, res, next) => {
    try {
      const parsed = z
        .object({
          subject_id: z.string().min(1),
          parent_folder_id: z.string().nullable().optional(),
          name: z.string().min(2).max(100),
        })
        .safeParse(req.body);
      if (!parsed.success || !isUuid(parsed.data.subject_id)) {
        return res.status(400).json({ error: 'Invalid folder fields.' });
      }
      const id = crypto.randomUUID();
      const maxRow = await db.queryOne<{ m: string | number }>(
        'SELECT COALESCE(MAX(sort_order), 0) AS m FROM academic_folders WHERE subject_id = $1',
        [parsed.data.subject_id]
      );
      const maxOrder = Number(maxRow?.m || 0);
      await db.execute(
        'INSERT INTO academic_folders (id, subject_id, parent_folder_id, name, sort_order, is_archived, created_at) VALUES ($1, $2, $3, $4, $5, FALSE, NOW())',
        [
          id,
          parsed.data.subject_id,
          isUuid(parsed.data.parent_folder_id) ? parsed.data.parent_folder_id : null,
          parsed.data.name.trim(),
          maxOrder + 1,
        ]
      );
      await writeAuditLog(db, req.user!.id, 'create_folder', 'academic_folder', id, parsed.data);
      return res.status(201).json({ id, ...parsed.data });
    } catch (err) {
      return next(err);
    }
  });

  router.patch('/folders/:id', requireAdmin, async (req: AuthenticatedRequest, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Folder not found.' });
      const parsed = z
        .object({
          name: z.string().min(2).max(100).optional(),
          sort_order: z.number().int().min(0).optional(),
          is_archived: z.boolean().optional(),
        })
        .safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Invalid folder update.' });
      const d = parsed.data;
      await db.execute(
        `UPDATE academic_folders SET
          name = COALESCE($1, name),
          sort_order = COALESCE($2, sort_order),
          is_archived = COALESCE($3, is_archived)
         WHERE id = $4`,
        [d.name?.trim() ?? null, d.sort_order ?? null, d.is_archived ?? null, req.params.id]
      );
      await writeAuditLog(db, req.user!.id, 'update_folder', 'academic_folder', req.params.id, d);
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });

  // Categories management (Admin)
  router.post('/categories', requireAdmin, async (req: AuthenticatedRequest, res, next) => {
    try {
      const parsed = z
        .object({
          name: z.string().min(2).max(60),
          description: z.string().max(200).default(''),
          pdf_only: z.boolean().default(true),
        })
        .safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Invalid category.' });
      const slug = parsed.data.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const id = crypto.randomUUID();
      const maxRow = await db.queryOne<{ m: string | number }>(
        'SELECT COALESCE(MAX(sort_order), 0) AS m FROM resource_categories'
      );
      await db.execute(
        'INSERT INTO resource_categories (id, slug, name, description, pdf_only, sort_order) VALUES ($1, $2, $3, $4, $5, $6)',
        [id, slug, parsed.data.name.trim(), parsed.data.description.trim(), parsed.data.pdf_only, Number(maxRow?.m || 0) + 1]
      );
      await writeAuditLog(db, req.user!.id, 'create_category', 'resource_category', id, parsed.data);
      return res.status(201).json({ id, slug, ...parsed.data });
    } catch (err) {
      return next(err);
    }
  });

  router.patch('/categories/:id', requireAdmin, async (req: AuthenticatedRequest, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Category not found.' });
      const parsed = z
        .object({
          name: z.string().min(2).max(60).optional(),
          description: z.string().max(200).optional(),
        })
        .safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Invalid category update.' });
      await db.execute(
        'UPDATE resource_categories SET name = COALESCE($1, name), description = COALESCE($2, description) WHERE id = $3',
        [parsed.data.name?.trim() ?? null, parsed.data.description?.trim() ?? null, req.params.id]
      );
      await writeAuditLog(db, req.user!.id, 'update_category', 'resource_category', req.params.id, parsed.data);
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });

  // List resources with hierarchy & sort filters
  router.get('/resources', async (req: AuthenticatedRequest, res, next) => {
    try {
      const { program_id, semester_id, subject_id, category_id, folder_id, sort, mine, status } = req.query as Record<string, string>;
      const viewerId = req.user?.id || null;
      const isMod = req.user ? isModeratorOrAbove(req.user.role) : false;

      const conditions: string[] = [];
      const params: unknown[] = [viewerId];

      const addParam = (val: unknown) => {
        params.push(val);
        return `$${params.length}`;
      };

      if (mine === 'true' && req.user) {
        conditions.push(`r.uploader_id = ${addParam(req.user.id)}`);
      } else if (status && isMod) {
        conditions.push(`r.status = ${addParam(status)}`);
      } else if (viewerId) {
        conditions.push(`(r.status = 'approved' OR r.uploader_id = ${addParam(viewerId)})`);
      } else {
        conditions.push("r.status = 'approved'");
      }

      if (isUuid(program_id)) conditions.push(`r.program_id = ${addParam(program_id)}`);
      if (isUuid(semester_id)) conditions.push(`r.semester_id = ${addParam(semester_id)}`);
      if (isUuid(subject_id)) conditions.push(`r.subject_id = ${addParam(subject_id)}`);
      if (isUuid(category_id)) conditions.push(`r.category_id = ${addParam(category_id)}`);
      if (isUuid(folder_id)) conditions.push(`r.folder_id = ${addParam(folder_id)}`);

      let orderBy = 'r.created_at DESC';
      if (sort === 'downloads') orderBy = 'r.download_count DESC, r.created_at DESC';
      else if (sort === 'upvotes') orderBy = 'r.upvote_count DESC, r.created_at DESC';

      const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const rows = await db.query<Record<string, unknown>>(
        `SELECT r.*,
                rc.name AS category_name, rc.slug AS category_slug,
                p.code AS program_code, p.name AS program_name,
                sem.name AS semester_name,
                sub.name AS subject_name,
                f.name AS folder_name,
                u.display_name AS uploader_name, u.username AS uploader_username, u.role AS uploader_role,
                COALESCE(rev_cur.revision_number, rev_latest.revision_number, 1) AS revision_number,
                COALESCE(rev_cur.file_size, rev_latest.file_size, 0) AS file_size,
                COALESCE(rev_cur.original_filename, rev_latest.original_filename, 'document.pdf') AS original_filename,
                (SELECT value FROM votes v WHERE v.user_id = $1 AND v.target_type = 'resource' AND v.target_id = r.id) AS user_vote,
                (SELECT 1 FROM bookmarks b WHERE b.user_id = $1 AND b.target_type = 'resource' AND b.target_id = r.id) AS is_bookmarked,
                (SELECT COUNT(*) FROM resource_revisions rr WHERE rr.resource_id = r.id AND rr.status = 'pending') AS pending_rev_count
         FROM resources r
         JOIN resource_categories rc ON rc.id = r.category_id
         JOIN programs p ON p.id = r.program_id
         JOIN semesters sem ON sem.id = r.semester_id
         JOIN subjects sub ON sub.id = r.subject_id
         LEFT JOIN academic_folders f ON f.id = r.folder_id
         JOIN profiles u ON u.id = r.uploader_id
         LEFT JOIN resource_revisions rev_cur ON rev_cur.id = r.current_revision_id
         LEFT JOIN LATERAL (
           SELECT revision_number, file_size, original_filename
           FROM resource_revisions
           WHERE resource_id = r.id
           ORDER BY revision_number DESC LIMIT 1
         ) rev_latest ON TRUE
         ${whereSql}
         ORDER BY ${orderBy}
         LIMIT 100`,
        params
      );

      const formatted = rows.map((r) => ({
        ...r,
        download_count: Number(r.download_count || 0),
        upvote_count: Number(r.upvote_count || 0),
        revision_number: Number(r.revision_number || 1),
        file_size: Number(r.file_size || 0),
        user_vote: Number(r.user_vote || 0),
        is_bookmarked: Boolean(r.is_bookmarked),
        has_pending_revision: Number(r.pending_rev_count || 0) > 0,
      }));

      return res.json({ resources: formatted });
    } catch (err) {
      return next(err);
    }
  });

  // Upload new PDF Academic Resource to Private Supabase Storage
  router.post('/resources', requireAuth, upload.single('file'), async (req: AuthenticatedRequest, res, next) => {
    try {
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
      if (
        !isUuid(parsed.data.category_id) ||
        !isUuid(parsed.data.program_id) ||
        !isUuid(parsed.data.semester_id) ||
        !isUuid(parsed.data.subject_id)
      ) {
        return res.status(400).json({ error: 'Invalid academic hierarchy selection.' });
      }
      if (!req.file) {
        return res.status(400).json({ error: 'Please attach a PDF document.' });
      }

      const maxMbSetting = await db.queryOne<{ value: string }>(
        "SELECT value FROM platform_settings WHERE key = 'max_upload_mb'"
      );
      const maxBytes = Number(maxMbSetting?.value || 10) * 1024 * 1024;
      if (req.file.size > maxBytes) {
        return res.status(413).json({ error: `File exceeds maximum allowed upload size of ${maxBytes / (1024 * 1024)} MB.` });
      }

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

      const subj = await db.queryOne<{ id: string; program_id: string; semester_id: string }>(
        'SELECT id, program_id, semester_id FROM subjects WHERE id = $1 AND is_archived = FALSE',
        [parsed.data.subject_id]
      );
      if (!subj || subj.program_id !== parsed.data.program_id || subj.semester_id !== parsed.data.semester_id) {
        return res.status(400).json({ error: 'Selected subject does not belong to the selected program and semester.' });
      }

      const hash = sha256Buffer(req.file.buffer);
      const duplicate = await db.queryOne<{ title: string }>(
        `SELECT r.title FROM resource_revisions rev
         JOIN resources r ON r.id = rev.resource_id
         WHERE rev.sha256_hash = $1 AND r.subject_id = $2 AND r.status <> 'rejected' LIMIT 1`,
        [hash, parsed.data.subject_id]
      );
      if (duplicate) {
        return res.status(409).json({
          error: `Duplicate PDF detected for this subject ("${duplicate.title}" has identical file content).`,
        });
      }

      const resourceId = crypto.randomUUID();
      const revId = crypto.randomUUID();
      const safeName = sanitizeFilename(req.file.originalname);
      const objectPath = `pdfs/${resourceId}/${revId}_${safeName}`;

      await req.storage!.uploadPrivate(objectPath, req.file.buffer, 'application/pdf');

      const autoApprove = isAdminRole(user.role);
      const initialStatus: 'approved' | 'pending' = autoApprove ? 'approved' : 'pending';

      try {
        await db.transaction(async (tx) => {
          await tx.execute(
            `INSERT INTO resources (id, title, description, category_id, program_id, semester_id, subject_id, folder_id, academic_year, uploader_id, status, current_revision_id, download_count, upvote_count, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 0, 0, NOW(), NOW())`,
            [
              resourceId,
              parsed.data.title.trim(),
              parsed.data.description.trim(),
              parsed.data.category_id,
              parsed.data.program_id,
              parsed.data.semester_id,
              parsed.data.subject_id,
              isUuid(parsed.data.folder_id) ? parsed.data.folder_id : null,
              parsed.data.academic_year.trim(),
              user.id,
              initialStatus,
              autoApprove ? revId : null,
            ]
          );

          await tx.execute(
            `INSERT INTO resource_revisions (id, resource_id, revision_number, storage_object_path, original_filename, sanitized_filename, file_size, sha256_hash, mime_type, extracted_text, status, reviewer_id, review_notes, created_at)
             VALUES ($1, $2, 1, $3, $4, $5, $6, $7, 'application/pdf', '', $8, $9, $10, NOW())`,
            [
              revId,
              resourceId,
              objectPath,
              req.file!.originalname,
              safeName,
              req.file!.size,
              hash,
              initialStatus,
              autoApprove ? user.id : null,
              autoApprove ? 'Published directly by administrator.' : null,
            ]
          );

          await syncModerationQueue(
            tx,
            'resource',
            resourceId,
            user.id,
            initialStatus,
            autoApprove ? user.id : null,
            autoApprove ? 'Published directly by administrator.' : null
          );

          await writeAuditLog(tx, user.id, 'upload_resource', 'resource', resourceId, {
            status: initialStatus,
            file_size: req.file!.size,
          });
        });
      } catch (err) {
        await req.storage!.deletePrivate(objectPath).catch(() => {});
        throw err;
      }

      return res.status(201).json({
        id: resourceId,
        status: initialStatus,
        message: autoApprove
          ? 'Resource uploaded and published.'
          : 'Resource uploaded and submitted to the moderator review queue.',
      });
    } catch (err) {
      return next(err);
    }
  });

  // Edit own resource — keeps existing approved file live while revision is pending!
  router.put('/resources/:id', requireAuth, upload.single('file'), async (req: AuthenticatedRequest, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Resource not found.' });
      const user = req.user!;
      const resource = await db.queryOne<Record<string, unknown>>(
        'SELECT * FROM resources WHERE id = $1',
        [req.params.id]
      );
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

      const isApproved = String(resource.status) === 'approved';
      let uploadedPath: string | null = null;

      if (req.file) {
        const ext = path.extname(req.file.originalname).toLowerCase();
        if (ext !== '.pdf') return res.status(400).json({ error: 'Replacement file must be a PDF.' });
        const pdfCheck = validatePdfBuffer(req.file.buffer);
        if (!pdfCheck.valid) return res.status(400).json({ error: pdfCheck.reason || 'Invalid PDF file.' });

        const revId = crypto.randomUUID();
        const safeName = sanitizeFilename(req.file.originalname);
        uploadedPath = `pdfs/${req.params.id}/${revId}_${safeName}`;
        await req.storage!.uploadPrivate(uploadedPath, req.file.buffer, 'application/pdf');

        try {
          await db.transaction(async (tx) => {
            const maxRow = await tx.queryOne<{ m: string | number }>(
              'SELECT COALESCE(MAX(revision_number), 0) AS m FROM resource_revisions WHERE resource_id = $1',
              [req.params.id]
            );
            const newRevStatus: 'approved' | 'pending' = isAdminRole(user.role) ? 'approved' : 'pending';
            await tx.execute(
              `INSERT INTO resource_revisions (id, resource_id, revision_number, storage_object_path, original_filename, sanitized_filename, file_size, sha256_hash, mime_type, extracted_text, status, reviewer_id, created_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'application/pdf', '', $9, $10, NOW())`,
              [
                revId,
                req.params.id,
                Number(maxRow?.m || 0) + 1,
                uploadedPath,
                req.file!.originalname,
                safeName,
                req.file!.size,
                sha256Buffer(req.file!.buffer),
                newRevStatus,
                newRevStatus === 'approved' ? user.id : null,
              ]
            );

            if (newRevStatus === 'approved') {
              await tx.execute('UPDATE resources SET current_revision_id = $1, updated_at = NOW() WHERE id = $2', [
                revId,
                req.params.id,
              ]);
            }
            await syncModerationQueue(tx, 'resource', req.params.id, String(resource.uploader_id), newRevStatus);
          });
        } catch (err) {
          if (uploadedPath) await req.storage!.deletePrivate(uploadedPath).catch(() => {});
          throw err;
        }
      }

      if (isApproved && !isAdminRole(user.role) && !req.file) {
        await db.transaction(async (tx) => {
          const curRev = await tx.queryOne<Record<string, unknown>>(
            'SELECT * FROM resource_revisions WHERE id = $1',
            [String(resource.current_revision_id)]
          );
          if (curRev) {
            const maxRow = await tx.queryOne<{ m: string | number }>(
              'SELECT COALESCE(MAX(revision_number), 0) AS m FROM resource_revisions WHERE resource_id = $1',
              [req.params.id]
            );
            await tx.execute(
              `INSERT INTO resource_revisions (id, resource_id, revision_number, storage_object_path, original_filename, sanitized_filename, file_size, sha256_hash, mime_type, extracted_text, status, review_notes, created_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'application/pdf', '', 'pending', $9, NOW())`,
              [
                crypto.randomUUID(),
                req.params.id,
                Number(maxRow?.m || 0) + 1,
                String(curRev.storage_object_path),
                String(curRev.original_filename),
                String(curRev.sanitized_filename),
                Number(curRev.file_size),
                String(curRev.sha256_hash),
                JSON.stringify({
                  pending_title: parsed.data.title,
                  pending_description: parsed.data.description,
                }),
              ]
            );
            await syncModerationQueue(tx, 'resource', req.params.id, String(resource.uploader_id), 'pending');
          }
        });
        return res.json({
          ok: true,
          pendingReview: true,
          message: 'Edit submitted as a pending revision. The previously approved version remains live until reviewed.',
        });
      }

      await db.execute(
        `UPDATE resources SET
          title = COALESCE($1, title),
          description = COALESCE($2, description),
          academic_year = COALESCE($3, academic_year),
          updated_at = NOW()
         WHERE id = $4`,
        [
          parsed.data.title?.trim() ?? null,
          parsed.data.description?.trim() ?? null,
          parsed.data.academic_year?.trim() ?? null,
          req.params.id,
        ]
      );

      return res.json({ ok: true, message: 'Resource updated.' });
    } catch (err) {
      return next(err);
    }
  });

  // Delete own resource
  router.delete('/resources/:id', requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Resource not found.' });
      const resource = await db.queryOne<Record<string, unknown>>(
        'SELECT * FROM resources WHERE id = $1',
        [req.params.id]
      );
      if (!resource) return res.status(404).json({ error: 'Resource not found.' });
      if (String(resource.uploader_id) !== req.user!.id && !isAdminRole(req.user!.role)) {
        return res.status(403).json({ error: 'Only the resource uploader or an administrator can delete this resource.' });
      }

      const revisions = await db.query<{ storage_object_path: string }>(
        'SELECT storage_object_path FROM resource_revisions WHERE resource_id = $1',
        [req.params.id]
      );

      await db.transaction(async (tx) => {
        await tx.execute('DELETE FROM resources WHERE id = $1', [req.params.id]);
        await tx.execute("DELETE FROM moderation_queue WHERE entity_type = 'resource' AND entity_id = $1", [req.params.id]);
        await writeAuditLog(tx, req.user!.id, 'delete_resource', 'resource', req.params.id, {});
      });

      for (const rev of revisions) {
        await req.storage!.deletePrivate(String(rev.storage_object_path)).catch(() => {});
      }

      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });

  // Shared helper for authorization & revision resolution on private PDF access
  async function resolveAuthorizedRevision(req: AuthenticatedRequest) {
    if (!isUuid(req.params.id)) return { errorStatus: 404, error: 'Resource not found.' as const };
    const resource = await db.queryOne<Record<string, unknown>>(
      'SELECT * FROM resources WHERE id = $1',
      [req.params.id]
    );
    if (!resource) return { errorStatus: 404, error: 'Resource not found.' as const };

    const isOwner = req.user?.id === String(resource.uploader_id);
    const isMod = req.user ? isModeratorOrAbove(req.user.role) : false;

    if (String(resource.status) !== 'approved' && !isOwner && !isMod) {
      return {
        errorStatus: 403,
        error: 'Unauthorized: pending or rejected resources cannot be downloaded publicly.' as const,
      };
    }

    const requestedRevId = req.query.revisionId ? String(req.query.revisionId) : '';
    const revId = isUuid(requestedRevId)
      ? requestedRevId
      : isUuid(String(resource.current_revision_id || ''))
        ? String(resource.current_revision_id)
        : '';

    let rev = revId
      ? await db.queryOne<Record<string, unknown>>(
          'SELECT * FROM resource_revisions WHERE id = $1 AND resource_id = $2',
          [revId, req.params.id]
        )
      : null;

    if (!rev) {
      rev = await db.queryOne<Record<string, unknown>>(
        'SELECT * FROM resource_revisions WHERE resource_id = $1 ORDER BY revision_number DESC LIMIT 1',
        [req.params.id]
      );
    }

    if (!rev) return { errorStatus: 404, error: 'Revision file not found.' as const };
    return { resource, rev };
  }

  // Short-lived Signed URL issuance for private PDFs (never returns permanent public URLs)
  router.get('/resources/:id/signed-url', async (req: AuthenticatedRequest, res, next) => {
    try {
      const resolved = await resolveAuthorizedRevision(req);
      if ('error' in resolved) {
        return res.status(resolved.errorStatus ?? 400).json({ error: resolved.error });
      }
      const { resource, rev } = resolved;
      const filename = sanitizeFilename(String(rev.original_filename));
      const signedUrl = await req.storage!.createSignedUrl(
        String(rev.storage_object_path),
        60,
        req.query.download === '1' ? filename : undefined
      );
      if (!signedUrl) {
        return res.status(404).json({ error: 'Stored PDF file could not be located.' });
      }

      if (req.query.download === '1' && String(resource.status) === 'approved') {
        await db.execute('UPDATE resources SET download_count = download_count + 1 WHERE id = $1', [req.params.id]);
        await db.execute('INSERT INTO resource_downloads (id, resource_id, user_id, created_at) VALUES ($1, $2, $3, NOW())', [
          crypto.randomUUID(),
          req.params.id,
          req.user?.id ?? null,
        ]);
      }

      return res.json({ url: signedUrl, expires_in: 60, filename });
    } catch (err) {
      return next(err);
    }
  });

  // Authorized PDF Preview / Download stream (or ?mode=url for short-lived signed URL)
  router.get('/resources/:id/file', async (req: AuthenticatedRequest, res, next) => {
    try {
      const resolved = await resolveAuthorizedRevision(req);
      if ('error' in resolved) {
        return res.status(resolved.errorStatus ?? 400).json({ error: resolved.error });
      }
      const { resource, rev } = resolved;
      const filename = sanitizeFilename(String(rev.original_filename));

      if (req.query.mode === 'url') {
        const signedUrl = await req.storage!.createSignedUrl(
          String(rev.storage_object_path),
          60,
          req.query.download === '1' ? filename : undefined
        );
        if (!signedUrl) {
          return res.status(404).json({ error: 'Stored PDF file could not be located.' });
        }
        return res.json({ url: signedUrl, expires_in: 60, filename });
      }

      const fileBuffer = await req.storage!.downloadPrivate(String(rev.storage_object_path));
      if (!fileBuffer) {
        return res.status(404).json({ error: 'Stored PDF file could not be located.' });
      }

      const mode = req.query.download === '1' ? 'attachment' : 'inline';
      if (req.query.download === '1' && String(resource.status) === 'approved') {
        await db.execute('UPDATE resources SET download_count = download_count + 1 WHERE id = $1', [req.params.id]);
        await db.execute('INSERT INTO resource_downloads (id, resource_id, user_id, created_at) VALUES ($1, $2, $3, NOW())', [
          crypto.randomUUID(),
          req.params.id,
          req.user?.id ?? null,
        ]);
      }

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `${mode}; filename="${filename}"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, no-store');
      return res.send(fileBuffer);
    } catch (err) {
      return next(err);
    }
  });

  // Resource revision history
  router.get('/resources/:id/revisions', async (req: AuthenticatedRequest, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Resource not found.' });
      const resource = await db.queryOne<Record<string, unknown>>(
        'SELECT * FROM resources WHERE id = $1',
        [req.params.id]
      );
      if (!resource) return res.status(404).json({ error: 'Resource not found.' });
      const isOwner = req.user?.id === String(resource.uploader_id);
      const isMod = req.user ? isModeratorOrAbove(req.user.role) : false;

      const revisions = await db.query(
        `SELECT rr.id, rr.resource_id, rr.revision_number, rr.original_filename, rr.file_size, rr.sha256_hash, rr.status, rr.reviewer_id, rr.review_notes, rr.created_at,
                u.display_name AS reviewer_name
         FROM resource_revisions rr
         LEFT JOIN profiles u ON u.id = rr.reviewer_id
         WHERE rr.resource_id = $1 ${isOwner || isMod ? '' : "AND rr.status = 'approved'"}
         ORDER BY rr.revision_number DESC`,
        [req.params.id]
      );

      return res.json({ revisions });
    } catch (err) {
      return next(err);
    }
  });

  // Review resource or revision (Moderator / Admin — uploaders cannot self-approve!)
  router.post('/resources/:id/review', requireModerator, async (req: AuthenticatedRequest, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Resource not found.' });
      const parsed = z
        .object({
          decision: z.enum(['approved', 'rejected', 'changes_requested']),
          revision_id: z.string().optional(),
          review_notes: z.string().max(500).default(''),
        })
        .safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Invalid review decision.' });

      const resource = await db.queryOne<Record<string, unknown>>(
        'SELECT * FROM resources WHERE id = $1',
        [req.params.id]
      );
      if (!resource) return res.status(404).json({ error: 'Resource not found.' });

      if (String(resource.uploader_id) === req.user!.id) {
        return res.status(403).json({
          error: 'Users cannot approve or review their own uploaded resources.',
        });
      }

      const targetRev = isUuid(parsed.data.revision_id)
        ? await db.queryOne<Record<string, unknown>>(
            'SELECT * FROM resource_revisions WHERE id = $1 AND resource_id = $2',
            [parsed.data.revision_id, req.params.id]
          )
        : await db.queryOne<Record<string, unknown>>(
            'SELECT * FROM resource_revisions WHERE resource_id = $1 ORDER BY revision_number DESC LIMIT 1',
            [req.params.id]
          );

      if (!targetRev) return res.status(404).json({ error: 'Revision not found.' });

      await db.transaction(async (tx) => {
        await tx.execute(
          'UPDATE resource_revisions SET status = $1, reviewer_id = $2, review_notes = $3 WHERE id = $4',
          [
            parsed.data.decision,
            req.user!.id,
            parsed.data.review_notes.trim() || null,
            String(targetRev.id),
          ]
        );

        if (parsed.data.decision === 'approved') {
          await tx.execute(
            "UPDATE resources SET status = 'approved', current_revision_id = $1, updated_at = NOW() WHERE id = $2",
            [String(targetRev.id), req.params.id]
          );
        } else if (!resource.current_revision_id) {
          await tx.execute('UPDATE resources SET status = $1, updated_at = NOW() WHERE id = $2', [
            parsed.data.decision,
            req.params.id,
          ]);
        }

        await syncModerationQueue(
          tx,
          'resource',
          req.params.id,
          String(resource.uploader_id),
          parsed.data.decision,
          req.user!.id,
          parsed.data.review_notes.trim() || null
        );

        await createNotification(
          tx,
          String(resource.uploader_id),
          `resource_${parsed.data.decision}`,
          `Resource ${parsed.data.decision.replace('_', ' ')}`,
          `"${resource.title}" was reviewed: ${parsed.data.review_notes || parsed.data.decision}.`,
          '/academic'
        );

        await writeAuditLog(tx, req.user!.id, 'review_resource', 'resource', req.params.id, {
          decision: parsed.data.decision,
          revision_id: targetRev.id,
        });
      });

      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}
