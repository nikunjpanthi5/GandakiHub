import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import {
  type AuthenticatedRequest,
  requireAdmin,
  requireAuth,
  requireModerator,
  requireSuperAdmin,
} from '../authMiddleware.ts';
import { type AppDatabase, type DbExecutor, createNotification, syncModerationQueue, writeAuditLog } from '../db.ts';
import { checkTextAgainstDictionary, type ProfanityRule } from '../profanity.ts';
import { isAdminRole, isModeratorOrAbove, isUuid } from '../security.ts';

async function getProfanityRules(db: DbExecutor): Promise<ProfanityRule[]> {
  return db.query('SELECT * FROM profanity_dictionary') as unknown as Promise<ProfanityRule[]>;
}

const imageUrlSchema = z
  .string()
  .regex(/^\/api\/media\/images\/[a-zA-Z0-9._-]+$/, 'Invalid image reference.')
  .nullable()
  .optional();

export function createSpecialRouter(db: AppDatabase): Router {
  const router = Router();

  // ================= CONFESSIONS (Strict Author Isolation) =================
  router.get('/confessions', async (req: AuthenticatedRequest, res, next) => {
    try {
      const showPending = req.query.status === 'pending' && req.user && isModeratorOrAbove(req.user.role);
      const status = showPending ? 'pending' : 'approved';

      // confessions table intentionally has NO author_id column!
      const rows = await db.query<Record<string, unknown>>(
        'SELECT * FROM confessions WHERE status = $1 ORDER BY created_at DESC LIMIT 80',
        [status]
      );

      const ids = rows.map((r) => String(r.id));
      const commentsByConf = new Map<string, Record<string, unknown>[]>();
      if (ids.length > 0) {
        const cmts = await db.query<Record<string, unknown>>(
          'SELECT id, confession_id, alias_label, body, created_at FROM confession_comments WHERE confession_id = ANY($1::uuid[]) ORDER BY created_at ASC',
          [ids]
        );
        for (const cm of cmts) {
          const cid = String(cm.confession_id);
          const list = commentsByConf.get(cid) || [];
          list.push({
            id: cm.id,
            alias_label: cm.alias_label,
            body: cm.body,
            created_at: new Date(String(cm.created_at)).toISOString(),
          });
          commentsByConf.set(cid, list);
        }
      }

      return res.json({
        confessions: rows.map((c) => ({
          ...c,
          created_at: new Date(String(c.created_at)).toISOString(),
          comments: commentsByConf.get(String(c.id)) || [],
        })),
      });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/confessions', requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
      if (req.user!.role === 'visitor') {
        return res.status(403).json({ error: 'Visitors cannot submit confessions.' });
      }
      const parsed = z
        .object({
          title: z.string().max(140).default(''),
          body: z.string().max(2000).default(''),
          image_url: imageUrlSchema,
          category: z.string().min(2).max(50).default('Campus Life'),
        })
        .safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid confession.' });
      }

      const cleanTitle = parsed.data.title.trim();
      const cleanBody = parsed.data.body.trim();
      const cleanImage = parsed.data.image_url || null;
      if (!cleanTitle && !cleanBody && !cleanImage) {
        return res.status(400).json({ error: 'Please include text or an image for your confession.' });
      }

      const rules = await getProfanityRules(db);
      const prof = checkTextAgainstDictionary(`${cleanTitle} ${cleanBody}`, rules);
      if (prof.blocked) {
        return res.status(400).json({ error: 'Submission blocked due to severe abusive terms or threats.' });
      }

      const id = crypto.randomUUID();
      await db.transaction(async (tx) => {
        await tx.execute(
          "INSERT INTO confessions (id, title, body, image_url, category, status, reaction_support, reaction_relate, comment_count, created_at) VALUES ($1, $2, $3, $4, $5, 'pending', 0, 0, 0, NOW())",
          [id, cleanTitle, cleanBody, cleanImage, parsed.data.category.trim()]
        );

        await tx.execute(
          'INSERT INTO confession_identity_vault (confession_id, author_id, created_at) VALUES ($1, $2, NOW())',
          [id, req.user!.id]
        );

        await syncModerationQueue(tx, 'confession', id, null, 'pending');
      });

      return res.status(201).json({
        id,
        status: 'pending',
        message: 'Confession submitted anonymously to the moderation queue.',
      });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/confessions/:id/react', requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
      if (req.user!.role === 'visitor') return res.status(403).json({ error: 'Sign in as a member to react.' });
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Confession not found.' });
      const parsed = z.object({ reaction: z.enum(['support', 'relate']) }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Invalid reaction.' });
      const col = parsed.data.reaction === 'support' ? 'reaction_support' : 'reaction_relate';
      await db.execute(`UPDATE confessions SET ${col} = ${col} + 1 WHERE id = $1 AND status = 'approved'`, [
        req.params.id,
      ]);
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/confessions/:id/comments', requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
      if (req.user!.role === 'visitor') return res.status(403).json({ error: 'Visitors cannot comment.' });
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Confession not found.' });
      const parsed = z.object({ body: z.string().min(2).max(1000) }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Comment text is required.' });

      const rules = await getProfanityRules(db);
      const prof = checkTextAgainstDictionary(parsed.data.body, rules);
      if (prof.blocked) return res.status(400).json({ error: 'Comment contains prohibited abusive terms.' });

      const aliasNum = 100 + Math.floor(Math.random() * 899);
      await db.transaction(async (tx) => {
        await tx.execute(
          'INSERT INTO confession_comments (id, confession_id, alias_label, body, created_at) VALUES ($1, $2, $3, $4, NOW())',
          [crypto.randomUUID(), req.params.id, `Anonymous Peer #${aliasNum}`, parsed.data.body.trim()]
        );
        await tx.execute('UPDATE confessions SET comment_count = comment_count + 1 WHERE id = $1', [req.params.id]);
      });

      return res.status(201).json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/confessions/:id/review', requireModerator, async (req: AuthenticatedRequest, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Confession not found.' });
      const parsed = z.object({ decision: z.enum(['approved', 'rejected']) }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Invalid review decision.' });

      const conf = await db.queryOne<Record<string, unknown>>('SELECT * FROM confessions WHERE id = $1', [
        req.params.id,
      ]);
      if (!conf) return res.status(404).json({ error: 'Confession not found.' });

      await db.transaction(async (tx) => {
        await tx.execute('UPDATE confessions SET status = $1 WHERE id = $2', [parsed.data.decision, req.params.id]);
        await syncModerationQueue(tx, 'confession', req.params.id, null, parsed.data.decision, req.user!.id);
        await writeAuditLog(tx, req.user!.id, `confession_${parsed.data.decision}`, 'confession', req.params.id, {});
      });

      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });

  // Super Admin ONLY: Audited identity lookup for critical legal/safety cases
  router.post('/confessions/:id/identity-lookup', requireSuperAdmin, async (req: AuthenticatedRequest, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Confession not found.' });
      const parsed = z
        .object({ reason: z.string().min(10, 'Provide an explicit safety/legal justification (min 10 chars).') })
        .safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message });

      const vault = await db.queryOne<Record<string, unknown>>(
        `SELECT v.author_id, u.username, u.display_name, uc.email, u.role
         FROM confession_identity_vault v
         JOIN profiles u ON u.id = v.author_id
         JOIN user_credentials uc ON uc.user_id = u.id
         WHERE v.confession_id = $1`,
        [req.params.id]
      );

      await writeAuditLog(db, req.user!.id, 'SUPER_ADMIN_CONFESSION_IDENTITY_ACCESS', 'confession', req.params.id, {
        justification: parsed.data.reason,
        found: Boolean(vault),
      });

      if (!vault) return res.status(404).json({ error: 'Identity mapping not found.' });
      return res.json({ identity: vault });
    } catch (err) {
      return next(err);
    }
  });

  // ================= COMPLAINTS & SUGGESTIONS =================
  router.get('/complaints', async (req: AuthenticatedRequest, res, next) => {
    try {
      const viewer = req.user;
      const isHandler = viewer ? isAdminRole(viewer.role) || viewer.role === 'community_moderator' : false;

      const rows = await db.query<Record<string, unknown>>(
        `SELECT c.*, u.display_name AS submitter_name, h.display_name AS assigned_handler_name
         FROM complaints c
         JOIN profiles u ON u.id = c.submitter_id
         LEFT JOIN profiles h ON h.id = c.assigned_handler_id
         ORDER BY c.created_at DESC LIMIT 80`
      );

      const visible = rows.filter((r) => {
        if (!r.is_private) return true;
        if (!viewer) return false;
        return (
          String(r.submitter_id) === viewer.id ||
          String(r.assigned_handler_id) === viewer.id ||
          isAdminRole(viewer.role) ||
          isHandler
        );
      });

      return res.json({
        complaints: visible.map((r) => ({
          ...r,
          is_private: Boolean(r.is_private),
          created_at: new Date(String(r.created_at)).toISOString(),
          updated_at: new Date(String(r.updated_at)).toISOString(),
          submitter_name:
            r.is_private && (!viewer || (String(r.submitter_id) !== viewer.id && !isAdminRole(viewer.role)))
              ? 'Authorized Submitter'
              : r.submitter_name,
        })),
      });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/complaints', requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
      if (req.user!.role === 'visitor') return res.status(403).json({ error: 'Visitors cannot submit complaints.' });
      const parsed = z
        .object({
          title: z.string().max(180).default(''),
          body: z.string().max(3000).default(''),
          image_url: imageUrlSchema,
          category: z.string().min(2).max(60),
          is_private: z.boolean().default(false),
        })
        .safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid complaint.' });
      }

      const cleanTitle = parsed.data.title.trim();
      const cleanBody = parsed.data.body.trim();
      const cleanImage = parsed.data.image_url || null;
      if (!cleanTitle && !cleanBody && !cleanImage) {
        return res.status(400).json({ error: 'Please include text or an image.' });
      }

      const id = crypto.randomUUID();
      await db.execute(
        `INSERT INTO complaints (id, submitter_id, is_private, category, title, body, image_url, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'submitted', NOW(), NOW())`,
        [id, req.user!.id, parsed.data.is_private, parsed.data.category.trim(), cleanTitle, cleanBody, cleanImage]
      );

      return res.status(201).json({ id, status: 'submitted' });
    } catch (err) {
      return next(err);
    }
  });

  router.patch('/complaints/:id', requireAdmin, async (req: AuthenticatedRequest, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Complaint not found.' });
      const parsed = z
        .object({
          status: z.enum(['submitted', 'under_review', 'in_progress', 'resolved', 'rejected']).optional(),
          assigned_handler_id: z.string().nullable().optional(),
          handler_notes: z.string().max(1000).nullable().optional(),
        })
        .safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Invalid complaint update.' });

      const comp = await db.queryOne<Record<string, unknown>>('SELECT * FROM complaints WHERE id = $1', [
        req.params.id,
      ]);
      if (!comp) return res.status(404).json({ error: 'Complaint not found.' });

      await db.transaction(async (tx) => {
        await tx.execute(
          `UPDATE complaints SET
            status = COALESCE($1, status),
            assigned_handler_id = COALESCE($2, assigned_handler_id),
            handler_notes = COALESCE($3, handler_notes),
            updated_at = NOW()
           WHERE id = $4`,
          [
            parsed.data.status ?? null,
            isUuid(parsed.data.assigned_handler_id) ? parsed.data.assigned_handler_id : null,
            parsed.data.handler_notes ?? null,
            req.params.id,
          ]
        );

        await createNotification(
          tx,
          String(comp.submitter_id),
          'complaint_update',
          'Complaint Status Updated',
          `"${comp.title}" is now ${parsed.data.status || comp.status}.`,
          '/complaints'
        );
        await writeAuditLog(tx, req.user!.id, 'update_complaint', 'complaint', req.params.id, parsed.data);
      });
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });

  // ================= GETIDEAS =================
  router.get('/ideas', async (req: AuthenticatedRequest, res, next) => {
    try {
      const viewerId = req.user?.id || null;
      const rows = await db.query<Record<string, unknown>>(
        `SELECT i.*, u.display_name AS author_name, u.username AS author_username,
          (SELECT value FROM votes v WHERE v.user_id = $1 AND v.target_type = 'idea' AND v.target_id = i.id) AS user_vote,
          (SELECT 1 FROM idea_followers f WHERE f.idea_id = i.id AND f.user_id = $1) AS is_following
         FROM ideas i
         JOIN profiles u ON u.id = i.author_id
         ORDER BY i.upvote_count DESC, i.created_at DESC`,
        [viewerId]
      );

      return res.json({
        ideas: rows.map((r) => ({
          ...r,
          upvote_count: Number(r.upvote_count || 0),
          follower_count: Number(r.follower_count || 0),
          user_vote: Number(r.user_vote || 0),
          is_following: Boolean(r.is_following),
          created_at: new Date(String(r.created_at)).toISOString(),
        })),
      });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/ideas', requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
      if (req.user!.role === 'visitor') return res.status(403).json({ error: 'Visitors cannot submit ideas.' });
      const parsed = z
        .object({
          title: z.string().max(180).default(''),
          problem_statement: z.string().max(2000).default(''),
          proposed_solution: z.string().max(2000).default(''),
          image_url: imageUrlSchema,
          collaborators_needed: z.string().max(300).default(''),
          status: z
            .enum(['new_idea', 'under_discussion', 'looking_for_collaborators', 'in_progress', 'completed'])
            .default('new_idea'),
        })
        .safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid idea.' });
      }

      const cleanTitle = parsed.data.title.trim();
      const cleanProb = parsed.data.problem_statement.trim();
      const cleanSol = parsed.data.proposed_solution.trim();
      const cleanImage = parsed.data.image_url || null;
      if (!cleanTitle && !cleanProb && !cleanSol && !cleanImage) {
        return res.status(400).json({ error: 'Please provide text or an image for your idea.' });
      }

      const id = crypto.randomUUID();
      await db.transaction(async (tx) => {
        await tx.execute(
          `INSERT INTO ideas (id, author_id, title, problem_statement, proposed_solution, image_url, collaborators_needed, status, upvote_count, follower_count, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, 1, NOW())`,
          [
            id,
            req.user!.id,
            cleanTitle,
            cleanProb,
            cleanSol,
            cleanImage,
            parsed.data.collaborators_needed.trim(),
            parsed.data.status,
          ]
        );
        await tx.execute(
          "INSERT INTO votes (user_id, target_type, target_id, value, created_at) VALUES ($1, 'idea', $2, 1, NOW())",
          [req.user!.id, id]
        );
        await tx.execute(
          'INSERT INTO idea_followers (idea_id, user_id, created_at) VALUES ($1, $2, NOW())',
          [id, req.user!.id]
        );
      });

      return res.status(201).json({ id });
    } catch (err) {
      return next(err);
    }
  });

  router.patch('/ideas/:id/status', requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Idea not found.' });
      const idea = await db.queryOne<Record<string, unknown>>('SELECT * FROM ideas WHERE id = $1', [req.params.id]);
      if (!idea) return res.status(404).json({ error: 'Idea not found.' });
      if (String(idea.author_id) !== req.user!.id && !isAdminRole(req.user!.role)) {
        return res.status(403).json({ error: 'Only the idea author or an administrator can update status.' });
      }
      const parsed = z
        .object({ status: z.enum(['new_idea', 'under_discussion', 'looking_for_collaborators', 'in_progress', 'completed']) })
        .safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Invalid status.' });
      await db.execute('UPDATE ideas SET status = $1 WHERE id = $2', [parsed.data.status, req.params.id]);
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/ideas/:id/follow', requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Idea not found.' });
      const existing = await db.queryOne(
        'SELECT 1 FROM idea_followers WHERE idea_id = $1 AND user_id = $2',
        [req.params.id, req.user!.id]
      );
      if (existing) {
        await db.transaction(async (tx) => {
          await tx.execute('DELETE FROM idea_followers WHERE idea_id = $1 AND user_id = $2', [
            req.params.id,
            req.user!.id,
          ]);
          await tx.execute('UPDATE ideas SET follower_count = GREATEST(0, follower_count - 1) WHERE id = $1', [
            req.params.id,
          ]);
        });
        return res.json({ following: false });
      }
      await db.transaction(async (tx) => {
        await tx.execute('INSERT INTO idea_followers (idea_id, user_id, created_at) VALUES ($1, $2, NOW())', [
          req.params.id,
          req.user!.id,
        ]);
        await tx.execute('UPDATE ideas SET follower_count = follower_count + 1 WHERE id = $1', [req.params.id]);
      });
      return res.json({ following: true });
    } catch (err) {
      return next(err);
    }
  });

  // ================= STUDENT DONATIONS =================
  router.get('/donations', async (req: AuthenticatedRequest, res, next) => {
    try {
      const isMod = req.user ? isModeratorOrAbove(req.user.role) : false;
      const viewerId = req.user?.id || null;
      const rows = await db.query<Record<string, unknown>>(
        `SELECT d.*, u.display_name AS requester_name
         FROM donation_requests d
         JOIN profiles u ON u.id = d.requester_id
         ${isMod ? '' : viewerId ? "WHERE d.status IN ('approved', 'fulfilled') OR d.requester_id = $1" : "WHERE d.status IN ('approved', 'fulfilled')"}
         ORDER BY d.created_at DESC`,
        isMod || !viewerId ? [] : [viewerId]
      );

      return res.json({
        donations: rows.map((r) => ({ ...r, created_at: new Date(String(r.created_at)).toISOString() })),
      });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/donations', requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
      if (req.user!.role === 'visitor') {
        return res.status(403).json({ error: 'Visitors cannot submit assistance requests.' });
      }
      const parsed = z
        .object({
          title: z.string().max(160).default(''),
          category: z.string().min(2).max(60),
          description: z.string().max(1500).default(''),
          image_url: imageUrlSchema,
          contact_method: z.string().max(160).default('Reach via GandakiHub connection request'),
        })
        .safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Invalid assistance request.' });

      const cleanTitle = parsed.data.title.trim();
      const cleanDesc = parsed.data.description.trim();
      const cleanImage = parsed.data.image_url || null;
      if (!cleanTitle && !cleanDesc && !cleanImage) {
        return res.status(400).json({ error: 'Please include text or an image.' });
      }

      const id = crypto.randomUUID();
      await db.transaction(async (tx) => {
        await tx.execute(
          `INSERT INTO donation_requests (id, requester_id, title, category, description, image_url, contact_method, status, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', NOW())`,
          [
            id,
            req.user!.id,
            cleanTitle,
            parsed.data.category.trim(),
            cleanDesc,
            cleanImage,
            parsed.data.contact_method.trim(),
          ]
        );
        await syncModerationQueue(tx, 'donation_request', id, req.user!.id, 'pending');
      });

      return res.status(201).json({
        id,
        status: 'pending',
        message: 'Request sent to moderators for verification before publishing.',
      });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/donations/:id/review', requireModerator, async (req: AuthenticatedRequest, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Donation request not found.' });
      const parsed = z
        .object({ decision: z.enum(['approved', 'rejected', 'fulfilled']), verification_notes: z.string().max(400).default('') })
        .safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Invalid review decision.' });

      await db.transaction(async (tx) => {
        await tx.execute('UPDATE donation_requests SET status = $1, verification_notes = $2 WHERE id = $3', [
          parsed.data.decision,
          parsed.data.verification_notes.trim() || null,
          req.params.id,
        ]);
        await syncModerationQueue(
          tx,
          'donation_request',
          req.params.id,
          null,
          parsed.data.decision === 'fulfilled' ? 'approved' : parsed.data.decision,
          req.user!.id,
          parsed.data.verification_notes.trim() || null
        );
        await writeAuditLog(tx, req.user!.id, `donation_${parsed.data.decision}`, 'donation_request', req.params.id, {
          verification_notes: parsed.data.verification_notes,
        });
      });

      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });

  // ================= OPPORTUNITIES, EVENTS & STUDY GROUPS =================
  router.get('/opportunities', async (req: AuthenticatedRequest, res, next) => {
    try {
      const isMod = req.user ? isModeratorOrAbove(req.user.role) : false;
      const kind = req.query.kind ? String(req.query.kind) : '';
      const clauses: string[] = [];
      const params: unknown[] = [];

      if (!isMod || req.query.includePending !== 'true') {
        clauses.push("o.status = 'approved'");
      }
      if (kind) {
        params.push(kind);
        clauses.push(`o.kind = $${params.length}`);
      }
      const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = await db.query(
        `SELECT o.*, u.display_name AS author_name FROM opportunities o JOIN profiles u ON u.id = o.author_id ${whereSql} ORDER BY o.deadline ASC, o.created_at DESC`,
        params
      );
      return res.json({ opportunities: rows });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/opportunities', requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
      if (req.user!.role === 'visitor' || req.user!.role === 'future_student') {
        return res.status(403).json({ error: 'Only verified members, alumni, teachers, or admins can submit opportunities.' });
      }
      const parsed = z
        .object({
          kind: z.enum(['internship', 'job', 'scholarship', 'competition', 'research', 'workshop']),
          title: z.string().max(180).default(''),
          organization: z.string().max(120).default(''),
          description: z.string().max(2000).default(''),
          image_url: imageUrlSchema,
          eligibility: z.string().max(300).default('Open to eligible students'),
          deadline: z.string().min(4).max(30),
          external_url: z.string().max(300).default(''),
        })
        .safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Invalid opportunity details.' });

      const cleanTitle = parsed.data.title.trim();
      const cleanDesc = parsed.data.description.trim();
      const cleanImage = parsed.data.image_url || null;
      if (!cleanTitle && !cleanDesc && !cleanImage) {
        return res.status(400).json({ error: 'Please include text or an image.' });
      }

      const id = crypto.randomUUID();
      const status: 'approved' | 'pending' = isModeratorOrAbove(req.user!.role) ? 'approved' : 'pending';
      await db.transaction(async (tx) => {
        await tx.execute(
          `INSERT INTO opportunities (id, author_id, kind, title, organization, description, image_url, eligibility, deadline, external_url, status, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())`,
          [
            id,
            req.user!.id,
            parsed.data.kind,
            cleanTitle,
            parsed.data.organization.trim(),
            cleanDesc,
            cleanImage,
            parsed.data.eligibility.trim(),
            parsed.data.deadline.trim(),
            parsed.data.external_url.trim(),
            status,
          ]
        );
        await syncModerationQueue(tx, 'opportunity', id, req.user!.id, status, status === 'approved' ? req.user!.id : null);
      });

      return res.status(201).json({ id, status });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/opportunities/:id/review', requireModerator, async (req: AuthenticatedRequest, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Opportunity not found.' });
      const parsed = z.object({ decision: z.enum(['approved', 'rejected']) }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Invalid review decision.' });

      const opp = await db.queryOne<Record<string, unknown>>('SELECT * FROM opportunities WHERE id = $1', [
        req.params.id,
      ]);
      if (!opp) return res.status(404).json({ error: 'Opportunity not found.' });

      await db.transaction(async (tx) => {
        await tx.execute('UPDATE opportunities SET status = $1 WHERE id = $2', [parsed.data.decision, req.params.id]);
        await syncModerationQueue(tx, 'opportunity', req.params.id, String(opp.author_id), parsed.data.decision, req.user!.id);
        await writeAuditLog(tx, req.user!.id, `opportunity_${parsed.data.decision}`, 'opportunity', req.params.id, {});
      });

      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });

  router.get('/events', async (_req, res, next) => {
    try {
      const rows = await db.query(
        'SELECT e.*, u.display_name AS author_name FROM events e JOIN profiles u ON u.id = e.author_id ORDER BY e.starts_at ASC'
      );
      return res.json({ events: rows });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/events', requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
      if (!['super_admin', 'admin', 'community_moderator', 'verified_teacher', 'verified_student'].includes(req.user!.role)) {
        return res.status(403).json({ error: 'Only verified campus members or faculty can publish events.' });
      }
      const parsed = z
        .object({
          kind: z.enum(['event', 'seminar', 'announcement']).default('event'),
          title: z.string().max(160).default(''),
          location: z.string().max(160).default('Gandaki University Campus'),
          starts_at: z.string().min(4).max(50),
          description: z.string().max(2000).default(''),
          image_url: imageUrlSchema,
        })
        .safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Invalid event fields.' });

      const cleanTitle = parsed.data.title.trim();
      const cleanDesc = parsed.data.description.trim();
      const cleanImage = parsed.data.image_url || null;
      if (!cleanTitle && !cleanDesc && !cleanImage) {
        return res.status(400).json({ error: 'Please include text or an image.' });
      }

      const id = crypto.randomUUID();
      const isOfficial = isAdminRole(req.user!.role) && parsed.data.kind === 'announcement';
      await db.execute(
        'INSERT INTO events (id, author_id, kind, title, location, starts_at, description, image_url, is_official_notice, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())',
        [
          id,
          req.user!.id,
          parsed.data.kind,
          cleanTitle,
          parsed.data.location.trim(),
          parsed.data.starts_at,
          cleanDesc,
          cleanImage,
          isOfficial,
        ]
      );

      return res.status(201).json({ id });
    } catch (err) {
      return next(err);
    }
  });

  router.get('/study-groups', async (req: AuthenticatedRequest, res, next) => {
    try {
      const viewerId = req.user?.id || null;
      const rows = await db.query<Record<string, unknown>>(
        `SELECT sg.*, u.display_name AS creator_name, p.code AS program_code, sub.name AS subject_name,
          (SELECT 1 FROM study_group_members m WHERE m.group_id = sg.id AND m.user_id = $1) AS is_member
         FROM study_groups sg
         JOIN profiles u ON u.id = sg.creator_id
         LEFT JOIN programs p ON p.id = sg.program_id
         LEFT JOIN subjects sub ON sub.id = sg.subject_id
         ORDER BY sg.created_at DESC`,
        [viewerId]
      );

      return res.json({
        study_groups: rows.map((r) => ({
          ...r,
          member_count: Number(r.member_count || 1),
          max_members: Number(r.max_members || 15),
          is_member: Boolean(r.is_member),
          created_at: new Date(String(r.created_at)).toISOString(),
        })),
      });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/study-groups', requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
      if (!['super_admin', 'admin', 'community_moderator', 'verified_student', 'verified_teacher'].includes(req.user!.role)) {
        return res.status(403).json({ error: 'Only verified university members can create study groups.' });
      }
      const parsed = z
        .object({
          name: z.string().min(2).max(120),
          description: z.string().max(800).default(''),
          image_url: imageUrlSchema,
          schedule_text: z.string().min(2).max(120),
          program_id: z.string().nullable().optional(),
          semester_id: z.string().nullable().optional(),
          subject_id: z.string().nullable().optional(),
          max_members: z.number().int().min(2).max(50).default(15),
        })
        .safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Invalid study group.' });

      const cleanDesc = parsed.data.description.trim();
      const cleanImage = parsed.data.image_url || null;
      if (!cleanDesc && !cleanImage) {
        return res.status(400).json({ error: 'Please include a description or an image for the study group.' });
      }

      const id = crypto.randomUUID();
      await db.transaction(async (tx) => {
        await tx.execute(
          `INSERT INTO study_groups (id, creator_id, program_id, semester_id, subject_id, name, description, image_url, schedule_text, max_members, member_count, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1, NOW())`,
          [
            id,
            req.user!.id,
            isUuid(parsed.data.program_id) ? parsed.data.program_id : null,
            isUuid(parsed.data.semester_id) ? parsed.data.semester_id : null,
            isUuid(parsed.data.subject_id) ? parsed.data.subject_id : null,
            parsed.data.name.trim(),
            cleanDesc,
            cleanImage,
            parsed.data.schedule_text.trim(),
            parsed.data.max_members,
          ]
        );
        await tx.execute(
          'INSERT INTO study_group_members (group_id, user_id, joined_at) VALUES ($1, $2, NOW())',
          [id, req.user!.id]
        );
      });

      return res.status(201).json({ id });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/study-groups/:id/toggle-join', requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
      if (!['super_admin', 'admin', 'community_moderator', 'verified_student', 'verified_teacher'].includes(req.user!.role)) {
        return res.status(403).json({ error: 'Only verified university members can join study groups.' });
      }
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Study group not found.' });

      const outcome = await db.transaction(async (tx) => {
        const existing = await tx.queryOne(
          'SELECT 1 FROM study_group_members WHERE group_id = $1 AND user_id = $2',
          [req.params.id, req.user!.id]
        );
        if (existing) {
          await tx.execute('DELETE FROM study_group_members WHERE group_id = $1 AND user_id = $2', [
            req.params.id,
            req.user!.id,
          ]);
          await tx.execute('UPDATE study_groups SET member_count = GREATEST(0, member_count - 1) WHERE id = $1', [
            req.params.id,
          ]);
          return { joined: false as const };
        }
        const sg = await tx.queryOne<{ member_count: number; max_members: number }>(
          'SELECT member_count, max_members FROM study_groups WHERE id = $1',
          [req.params.id]
        );
        if (!sg) return { notFound: true as const };
        if (Number(sg.member_count) >= Number(sg.max_members)) return { full: true as const };

        await tx.execute(
          'INSERT INTO study_group_members (group_id, user_id, joined_at) VALUES ($1, $2, NOW())',
          [req.params.id, req.user!.id]
        );
        await tx.execute('UPDATE study_groups SET member_count = member_count + 1 WHERE id = $1', [req.params.id]);
        return { joined: true as const };
      });

      if ('notFound' in outcome) return res.status(404).json({ error: 'Study group not found.' });
      if ('full' in outcome) return res.status(400).json({ error: 'This study group is already full.' });
      return res.json({ joined: outcome.joined });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}
