import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { DatabaseSync } from 'node:sqlite';
import {
  type AuthenticatedRequest,
  requireAdmin,
  requireAuth,
  requireModerator,
  requireSuperAdmin,
} from '../authMiddleware.ts';
import { createNotification, indexSearchEntity, writeAuditLog } from '../db.ts';
import { checkTextAgainstDictionary, type ProfanityRule } from '../profanity.ts';
import { isAdminRole, isModeratorOrAbove } from '../security.ts';

function getProfanityRules(db: DatabaseSync): ProfanityRule[] {
  return db.prepare('SELECT * FROM profanity_dictionary').all() as unknown as ProfanityRule[];
}

const imageUrlSchema = z
  .string()
  .regex(/^\/api\/media\/images\/[a-zA-Z0-9._-]+$/, 'Invalid image reference.')
  .nullable()
  .optional();

export function createSpecialRouter(db: DatabaseSync): Router {
  const router = Router();

  // ================= CONFESSIONS (Strict Author Isolation) =================
  router.get('/confessions', (req: AuthenticatedRequest, res) => {
    const showPending = req.query.status === 'pending' && req.user && isModeratorOrAbove(req.user.role);
    const status = showPending ? 'pending' : 'approved';

    // Note: confessions table has NO author_id column at all!
    const rows = db
      .prepare('SELECT * FROM confessions WHERE status = ? ORDER BY created_at DESC LIMIT 80')
      .all(status) as Record<string, unknown>[];

    const confessions = rows.map((c) => {
      const comments = db
        .prepare('SELECT id, alias_label, body, created_at FROM confession_comments WHERE confession_id = ? ORDER BY created_at ASC')
        .all(String(c.id));
      return {
        ...c,
        is_demo: Boolean(c.is_demo),
        comments,
      };
    });

    return res.json({ confessions });
  });

  router.post('/confessions', requireAuth, (req: AuthenticatedRequest, res) => {
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
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid confession.' });

    const cleanTitle = parsed.data.title.trim();
    const cleanBody = parsed.data.body.trim();
    const cleanImage = parsed.data.image_url || null;
    if (!cleanTitle && !cleanBody && !cleanImage) {
      return res.status(400).json({ error: 'Please include text or an image for your confession.' });
    }

    const prof = checkTextAgainstDictionary(`${cleanTitle} ${cleanBody}`, getProfanityRules(db));
    if (prof.blocked) {
      return res.status(400).json({ error: 'Submission blocked due to severe abusive terms or threats.' });
    }

    const id = `conf-${crypto.randomUUID().slice(0, 10)}`;
    const now = new Date().toISOString();
    db.exec('BEGIN');
    try {
      db.prepare(
        'INSERT INTO confessions (id, title, body, image_url, category, status, reaction_support, reaction_relate, comment_count, is_demo, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0, ?)'
      ).run(id, cleanTitle, cleanBody, cleanImage, parsed.data.category.trim(), 'pending', now);

      // Author stored strictly in isolated identity vault table
      db.prepare('INSERT INTO confession_identity_vault (confession_id, author_id, created_at) VALUES (?, ?, ?)').run(
        id,
        req.user!.id,
        now
      );
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }

    return res.status(201).json({
      id,
      status: 'pending',
      message: 'Confession submitted anonymously to the moderation queue.',
    });
  });

  router.post('/confessions/:id/react', requireAuth, (req: AuthenticatedRequest, res) => {
    if (req.user!.role === 'visitor') return res.status(403).json({ error: 'Sign in as a member to react.' });
    const { reaction } = z.object({ reaction: z.enum(['support', 'relate']) }).parse(req.body);
    const col = reaction === 'support' ? 'reaction_support' : 'reaction_relate';
    db.prepare(`UPDATE confessions SET ${col} = ${col} + 1 WHERE id = ? AND status = 'approved'`).run(req.params.id);
    return res.json({ ok: true });
  });

  router.post('/confessions/:id/comments', requireAuth, (req: AuthenticatedRequest, res) => {
    if (req.user!.role === 'visitor') return res.status(403).json({ error: 'Visitors cannot comment.' });
    const { body } = z.object({ body: z.string().min(2).max(1000) }).parse(req.body);
    const prof = checkTextAgainstDictionary(body, getProfanityRules(db));
    if (prof.blocked) return res.status(400).json({ error: 'Comment contains prohibited abusive terms.' });

    const aliasNum = 100 + Math.floor(Math.random() * 899);
    db.prepare('INSERT INTO confession_comments (id, confession_id, alias_label, body, created_at) VALUES (?, ?, ?, ?, ?)').run(
      `ccmt-${crypto.randomUUID().slice(0, 8)}`,
      req.params.id,
      `Anonymous Peer #${aliasNum}`,
      body.trim(),
      new Date().toISOString()
    );
    db.prepare('UPDATE confessions SET comment_count = comment_count + 1 WHERE id = ?').run(req.params.id);
    return res.status(201).json({ ok: true });
  });

  router.post('/confessions/:id/review', requireModerator, (req: AuthenticatedRequest, res) => {
    const { decision } = z.object({ decision: z.enum(['approved', 'rejected']) }).parse(req.body);
    const conf = db.prepare('SELECT * FROM confessions WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
    if (!conf) return res.status(404).json({ error: 'Confession not found.' });

    db.prepare('UPDATE confessions SET status = ? WHERE id = ?').run(decision, req.params.id);
    if (decision === 'approved') {
      indexSearchEntity(db, 'confession', req.params.id, String(conf.title), String(conf.body), String(conf.category));
    }
    writeAuditLog(db, req.user!.id, `confession_${decision}`, 'confession', req.params.id, {});
    return res.json({ ok: true });
  });

  // Super Admin ONLY: Audited identity lookup for critical legal/safety cases
  router.post('/confessions/:id/identity-lookup', requireSuperAdmin, (req: AuthenticatedRequest, res) => {
    const parsed = z.object({ reason: z.string().min(10, 'Provide an explicit safety/legal justification (min 10 chars).') }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message });

    const vault = db
      .prepare(
        `SELECT v.author_id, u.username, u.display_name, u.email, u.role
         FROM confession_identity_vault v
         JOIN users u ON u.id = v.author_id
         WHERE v.confession_id = ?`
      )
      .get(req.params.id) as Record<string, unknown> | undefined;

    writeAuditLog(db, req.user!.id, 'SUPER_ADMIN_CONFESSION_IDENTITY_ACCESS', 'confession', req.params.id, {
      justification: parsed.data.reason,
      found: Boolean(vault),
    });

    if (!vault) return res.status(404).json({ error: 'Identity mapping not found.' });
    return res.json({ identity: vault });
  });

  // ================= COMPLAINTS & SUGGESTIONS =================
  router.get('/complaints', (req: AuthenticatedRequest, res) => {
    const viewer = req.user;
    const isHandler = viewer ? isAdminRole(viewer.role) || viewer.role === 'community_moderator' : false;

    const rows = db
      .prepare(
        `SELECT c.*, u.display_name as submitter_name, h.display_name as assigned_handler_name
         FROM complaints c
         JOIN users u ON u.id = c.submitter_id
         LEFT JOIN users h ON h.id = c.assigned_handler_id
         ORDER BY c.created_at DESC LIMIT 80`
      )
      .all() as Record<string, unknown>[];

    // Enforce strict privacy: private complaints only visible to submitter or authorized handlers
    const visible = rows.filter((r) => {
      if (!r.is_private) return true;
      if (!viewer) return false;
      return String(r.submitter_id) === viewer.id || String(r.assigned_handler_id) === viewer.id || isAdminRole(viewer.role) || isHandler;
    });

    return res.json({
      complaints: visible.map((r) => ({
        ...r,
        is_private: Boolean(r.is_private),
        is_demo: Boolean(r.is_demo),
        submitter_name: r.is_private && (!viewer || (String(r.submitter_id) !== viewer.id && !isAdminRole(viewer.role)))
          ? 'Authorized Submitter'
          : r.submitter_name,
      })),
    });
  });

  router.post('/complaints', requireAuth, (req: AuthenticatedRequest, res) => {
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
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid complaint.' });

    const cleanTitle = parsed.data.title.trim();
    const cleanBody = parsed.data.body.trim();
    const cleanImage = parsed.data.image_url || null;
    if (!cleanTitle && !cleanBody && !cleanImage) {
      return res.status(400).json({ error: 'Please include text or an image.' });
    }

    const id = `comp-${crypto.randomUUID().slice(0, 10)}`;
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO complaints (id, submitter_id, is_private, category, title, body, image_url, status, is_demo, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'submitted', 0, ?, ?)`
    ).run(id, req.user!.id, parsed.data.is_private ? 1 : 0, parsed.data.category.trim(), cleanTitle, cleanBody, cleanImage, now, now);

    // NEVER index private complaints in public search!
    if (!parsed.data.is_private) {
      indexSearchEntity(db, 'complaint', id, cleanTitle || cleanBody.slice(0, 80) || 'Public Feedback', cleanBody, parsed.data.category.trim());
    }
    return res.status(201).json({ id, status: 'submitted' });
  });

  router.patch('/complaints/:id', requireAdmin, (req: AuthenticatedRequest, res) => {
    const parsed = z
      .object({
        status: z.enum(['submitted', 'under_review', 'in_progress', 'resolved', 'rejected']).optional(),
        assigned_handler_id: z.string().nullable().optional(),
        handler_notes: z.string().max(1000).nullable().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid complaint update.' });

    const comp = db.prepare('SELECT * FROM complaints WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
    if (!comp) return res.status(404).json({ error: 'Complaint not found.' });

    db.prepare(
      `UPDATE complaints SET
        status = COALESCE(?, status),
        assigned_handler_id = COALESCE(?, assigned_handler_id),
        handler_notes = COALESCE(?, handler_notes),
        updated_at = ?
       WHERE id = ?`
    ).run(
      parsed.data.status ?? null,
      parsed.data.assigned_handler_id ?? null,
      parsed.data.handler_notes ?? null,
      new Date().toISOString(),
      req.params.id
    );

    createNotification(
      db,
      String(comp.submitter_id),
      'complaint_update',
      'Complaint Status Updated',
      `"${comp.title}" is now ${parsed.data.status || comp.status}.`,
      '/complaints'
    );
    writeAuditLog(db, req.user!.id, 'update_complaint', 'complaint', req.params.id, parsed.data);
    return res.json({ ok: true });
  });

  // ================= GETIDEAS =================
  router.get('/ideas', (req: AuthenticatedRequest, res) => {
    const viewerId = req.user?.id || '';
    const rows = db
      .prepare(
        `SELECT i.*, u.display_name as author_name, u.username as author_username,
          (SELECT value FROM votes v WHERE v.user_id = ? AND v.target_type = 'idea' AND v.target_id = i.id) as user_vote,
          (SELECT 1 FROM idea_followers f WHERE f.idea_id = i.id AND f.user_id = ?) as is_following
         FROM ideas i
         JOIN users u ON u.id = i.author_id
         ORDER BY i.upvote_count DESC, i.created_at DESC`
      )
      .all(viewerId, viewerId) as Record<string, unknown>[];

    return res.json({
      ideas: rows.map((r) => ({
        ...r,
        user_vote: Number(r.user_vote || 0),
        is_following: Boolean(r.is_following),
        is_demo: Boolean(r.is_demo),
      })),
    });
  });

  router.post('/ideas', requireAuth, (req: AuthenticatedRequest, res) => {
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
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid idea.' });

    const cleanTitle = parsed.data.title.trim();
    const cleanProb = parsed.data.problem_statement.trim();
    const cleanSol = parsed.data.proposed_solution.trim();
    const cleanImage = parsed.data.image_url || null;
    if (!cleanTitle && !cleanProb && !cleanSol && !cleanImage) {
      return res.status(400).json({ error: 'Please provide text or an image for your idea.' });
    }

    const id = `idea-${crypto.randomUUID().slice(0, 10)}`;
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO ideas (id, author_id, title, problem_statement, proposed_solution, image_url, collaborators_needed, status, upvote_count, follower_count, is_demo, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 0, ?)`
    ).run(
      id,
      req.user!.id,
      cleanTitle,
      cleanProb,
      cleanSol,
      cleanImage,
      parsed.data.collaborators_needed.trim(),
      parsed.data.status,
      now
    );
    db.prepare('INSERT INTO votes (user_id, target_type, target_id, value, created_at) VALUES (?, ?, ?, 1, ?)').run(req.user!.id, 'idea', id, now);
    db.prepare('INSERT INTO idea_followers (idea_id, user_id, created_at) VALUES (?, ?, ?)').run(id, req.user!.id, now);
    indexSearchEntity(db, 'idea', id, cleanTitle || cleanProb.slice(0, 80) || 'Idea', `${cleanProb} ${cleanSol}`, parsed.data.status);
    return res.status(201).json({ id });
  });

  router.patch('/ideas/:id/status', requireAuth, (req: AuthenticatedRequest, res) => {
    const idea = db.prepare('SELECT * FROM ideas WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
    if (!idea) return res.status(404).json({ error: 'Idea not found.' });
    if (String(idea.author_id) !== req.user!.id && !isAdminRole(req.user!.role)) {
      return res.status(403).json({ error: 'Only the idea author or an administrator can update status.' });
    }
    const { status } = z
      .object({ status: z.enum(['new_idea', 'under_discussion', 'looking_for_collaborators', 'in_progress', 'completed']) })
      .parse(req.body);
    db.prepare('UPDATE ideas SET status = ? WHERE id = ?').run(status, req.params.id);
    return res.json({ ok: true });
  });

  router.post('/ideas/:id/follow', requireAuth, (req: AuthenticatedRequest, res) => {
    const existing = db.prepare('SELECT 1 FROM idea_followers WHERE idea_id = ? AND user_id = ?').get(req.params.id, req.user!.id);
    if (existing) {
      db.prepare('DELETE FROM idea_followers WHERE idea_id = ? AND user_id = ?').run(req.params.id, req.user!.id);
      db.prepare('UPDATE ideas SET follower_count = MAX(0, follower_count - 1) WHERE id = ?').run(req.params.id);
      return res.json({ following: false });
    }
    db.prepare('INSERT INTO idea_followers (idea_id, user_id, created_at) VALUES (?, ?, ?)').run(req.params.id, req.user!.id, new Date().toISOString());
    db.prepare('UPDATE ideas SET follower_count = follower_count + 1 WHERE id = ?').run(req.params.id);
    return res.json({ following: true });
  });

  // ================= STUDENT DONATIONS (No Payment Holding, Moderated) =================
  router.get('/donations', (req: AuthenticatedRequest, res) => {
    const isMod = req.user ? isModeratorOrAbove(req.user.role) : false;
    const viewerId = req.user?.id || '';
    const rows = db
      .prepare(
        `SELECT d.*, u.display_name as requester_name
         FROM donation_requests d
         JOIN users u ON u.id = d.requester_id
         ${isMod ? '' : "WHERE d.status IN ('approved', 'fulfilled') OR d.requester_id = ?"}
         ORDER BY d.created_at DESC`
      )
      .all(...(isMod ? [] : [viewerId]));

    return res.json({
      donations: (rows as Record<string, unknown>[]).map((r) => ({ ...r, is_demo: Boolean(r.is_demo) })),
    });
  });

  router.post('/donations', requireAuth, (req: AuthenticatedRequest, res) => {
    if (req.user!.role === 'visitor') return res.status(403).json({ error: 'Visitors cannot submit assistance requests.' });
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

    const id = `don-${crypto.randomUUID().slice(0, 10)}`;
    db.prepare(
      `INSERT INTO donation_requests (id, requester_id, title, category, description, image_url, contact_method, status, is_demo, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`
    ).run(id, req.user!.id, cleanTitle, parsed.data.category.trim(), cleanDesc, cleanImage, parsed.data.contact_method.trim(), new Date().toISOString());
    return res.status(201).json({ id, status: 'pending', message: 'Request sent to moderators for verification before publishing.' });
  });

  router.post('/donations/:id/review', requireModerator, (req: AuthenticatedRequest, res) => {
    const { decision, verification_notes } = z
      .object({ decision: z.enum(['approved', 'rejected', 'fulfilled']), verification_notes: z.string().max(400).default('') })
      .parse(req.body);
    db.prepare('UPDATE donation_requests SET status = ?, verification_notes = ? WHERE id = ?').run(
      decision,
      verification_notes.trim() || null,
      req.params.id
    );
    writeAuditLog(db, req.user!.id, `donation_${decision}`, 'donation_request', req.params.id, { verification_notes });
    return res.json({ ok: true });
  });

  // ================= OPPORTUNITIES, EVENTS & STUDY GROUPS =================
  router.get('/opportunities', (req: AuthenticatedRequest, res) => {
    const isMod = req.user ? isModeratorOrAbove(req.user.role) : false;
    const kind = req.query.kind ? String(req.query.kind) : '';
    const clauses: string[] = [];
    const params: string[] = [];
    if (!isMod || req.query.includePending !== 'true') {
      clauses.push("o.status = 'approved'");
    }
    if (kind) {
      clauses.push('o.kind = ?');
      params.push(kind);
    }
    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db
      .prepare(
        `SELECT o.*, u.display_name as author_name FROM opportunities o JOIN users u ON u.id = o.author_id ${whereSql} ORDER BY o.deadline ASC, o.created_at DESC`
      )
      .all(...params);
    return res.json({ opportunities: rows });
  });

  router.post('/opportunities', requireAuth, (req: AuthenticatedRequest, res) => {
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

    const id = `opp-${crypto.randomUUID().slice(0, 10)}`;
    const status = isModeratorOrAbove(req.user!.role) ? 'approved' : 'pending';
    db.prepare(
      `INSERT INTO opportunities (id, author_id, kind, title, organization, description, image_url, eligibility, deadline, external_url, status, is_demo, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
    ).run(
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
      new Date().toISOString()
    );
    if (status === 'approved') {
      indexSearchEntity(db, 'opportunity', id, cleanTitle || cleanDesc.slice(0, 80) || 'Opportunity', `${parsed.data.organization} ${cleanDesc}`, parsed.data.kind);
    }
    return res.status(201).json({ id, status });
  });

  router.post('/opportunities/:id/review', requireModerator, (req: AuthenticatedRequest, res) => {
    const { decision } = z.object({ decision: z.enum(['approved', 'rejected']) }).parse(req.body);
    const opp = db.prepare('SELECT * FROM opportunities WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
    if (!opp) return res.status(404).json({ error: 'Opportunity not found.' });
    db.prepare('UPDATE opportunities SET status = ? WHERE id = ?').run(decision, req.params.id);
    if (decision === 'approved') {
      indexSearchEntity(db, 'opportunity', req.params.id, String(opp.title), `${opp.organization} ${opp.description}`, String(opp.kind));
    }
    writeAuditLog(db, req.user!.id, `opportunity_${decision}`, 'opportunity', req.params.id, {});
    return res.json({ ok: true });
  });

  router.get('/events', (_req, res) => {
    const rows = db
      .prepare('SELECT e.*, u.display_name as author_name FROM events e JOIN users u ON u.id = e.author_id ORDER BY e.starts_at ASC')
      .all();
    return res.json({ events: rows });
  });

  router.post('/events', requireAuth, (req: AuthenticatedRequest, res) => {
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

    const id = `evt-${crypto.randomUUID().slice(0, 10)}`;
    const isOfficial = isAdminRole(req.user!.role) && parsed.data.kind === 'announcement' ? 1 : 0;
    db.prepare(
      'INSERT INTO events (id, author_id, kind, title, location, starts_at, description, image_url, is_official_notice, is_demo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)'
    ).run(id, req.user!.id, parsed.data.kind, cleanTitle, parsed.data.location.trim(), parsed.data.starts_at, cleanDesc, cleanImage, isOfficial, new Date().toISOString());

    indexSearchEntity(db, 'event', id, cleanTitle || cleanDesc.slice(0, 80) || 'Campus Event', `${parsed.data.location} ${cleanDesc}`, parsed.data.kind);
    return res.status(201).json({ id });
  });

  router.get('/study-groups', (req: AuthenticatedRequest, res) => {
    const viewerId = req.user?.id || '';
    const rows = db
      .prepare(
        `SELECT sg.*, u.display_name as creator_name, p.code as program_code, sub.name as subject_name,
          (SELECT 1 FROM study_group_members m WHERE m.group_id = sg.id AND m.user_id = ?) as is_member
         FROM study_groups sg
         JOIN users u ON u.id = sg.creator_id
         LEFT JOIN programs p ON p.id = sg.program_id
         LEFT JOIN subjects sub ON sub.id = sg.subject_id
         ORDER BY sg.created_at DESC`
      )
      .all(viewerId) as Record<string, unknown>[];

    return res.json({
      study_groups: rows.map((r) => ({ ...r, is_member: Boolean(r.is_member), is_demo: Boolean(r.is_demo) })),
    });
  });

  router.post('/study-groups', requireAuth, (req: AuthenticatedRequest, res) => {
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

    const id = `sg-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO study_groups (id, creator_id, program_id, semester_id, subject_id, name, description, image_url, schedule_text, max_members, member_count, is_demo, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?)`
    ).run(id, req.user!.id, parsed.data.program_id ?? null, parsed.data.semester_id ?? null, parsed.data.subject_id ?? null, parsed.data.name.trim(), cleanDesc, cleanImage, parsed.data.schedule_text.trim(), parsed.data.max_members, now);
    db.prepare('INSERT INTO study_group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)').run(id, req.user!.id, now);
    indexSearchEntity(db, 'study_group', id, parsed.data.name.trim(), cleanDesc, parsed.data.schedule_text);
    return res.status(201).json({ id });
  });

  router.post('/study-groups/:id/toggle-join', requireAuth, (req: AuthenticatedRequest, res) => {
    if (!['super_admin', 'admin', 'community_moderator', 'verified_student', 'verified_teacher'].includes(req.user!.role)) {
      return res.status(403).json({ error: 'Only verified university members can join study groups.' });
    }
    const existing = db.prepare('SELECT 1 FROM study_group_members WHERE group_id = ? AND user_id = ?').get(req.params.id, req.user!.id);
    if (existing) {
      db.prepare('DELETE FROM study_group_members WHERE group_id = ? AND user_id = ?').run(req.params.id, req.user!.id);
      db.prepare('UPDATE study_groups SET member_count = MAX(0, member_count - 1) WHERE id = ?').run(req.params.id);
      return res.json({ joined: false });
    }
    const sg = db.prepare('SELECT member_count, max_members FROM study_groups WHERE id = ?').get(req.params.id) as { member_count: number; max_members: number } | undefined;
    if (!sg) return res.status(404).json({ error: 'Study group not found.' });
    if (sg.member_count >= sg.max_members) return res.status(400).json({ error: 'This study group is already full.' });

    db.prepare('INSERT INTO study_group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)').run(req.params.id, req.user!.id, new Date().toISOString());
    db.prepare('UPDATE study_groups SET member_count = member_count + 1 WHERE id = ?').run(req.params.id);
    return res.json({ joined: true });
  });

  return router;
}
