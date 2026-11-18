import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { DatabaseSync } from 'node:sqlite';
import {
  type AuthenticatedRequest,
  requireAdmin,
  requireAuth,
} from '../authMiddleware.ts';
import { createNotification, indexSearchEntity, removeSearchEntity, writeAuditLog } from '../db.ts';
import { checkTextAgainstDictionary, type ProfanityRule } from '../profanity.ts';
import {
  canPostInCommunity,
  canVoteOrComment,
  isAdminRole,
  isModeratorOrAbove,
} from '../security.ts';
import type { CommentItem } from '../../src/types/index.ts';

function getProfanityRules(db: DatabaseSync): ProfanityRule[] {
  return db.prepare('SELECT * FROM profanity_dictionary').all() as unknown as ProfanityRule[];
}

function canViewCommunity(
  req: AuthenticatedRequest,
  visibility: string,
  communityId: string
): boolean {
  if (visibility === 'public') return true;
  if (!req.user) return false;
  if (isAdminRole(req.user.role)) return true;
  if (visibility === 'university_only') {
    return (
      req.user.university_email_verified ||
      req.user.role === 'verified_student' ||
      req.user.role === 'verified_teacher' ||
      req.user.role === 'community_moderator'
    );
  }
  if (visibility === 'private_approval') {
    const member = req.db!
      .prepare("SELECT status FROM community_members WHERE community_id = ? AND user_id = ? AND status = 'joined'")
      .get(communityId, req.user.id);
    return Boolean(member);
  }
  return false;
}

export function createCommunityRouter(db: DatabaseSync): Router {
  const router = Router();

  router.get('/communities', (req: AuthenticatedRequest, res) => {
    const includeArchived = req.query.includeArchived === 'true' && req.user && isAdminRole(req.user.role);
    const viewerId = req.user?.id || '';

    const rows = db
      .prepare(
        `SELECT c.*,
          (SELECT COUNT(*) FROM community_members cm WHERE cm.community_id = c.id AND cm.status = 'joined') as member_count,
          (SELECT COUNT(*) FROM posts p WHERE p.community_id = c.id AND p.is_hidden = 0 AND p.created_at >= datetime('now', '-7 days')) as recent_posts_count,
          (SELECT status FROM community_members cm2 WHERE cm2.community_id = c.id AND cm2.user_id = ?) as membership_status,
          (SELECT 1 FROM community_moderators mod WHERE mod.community_id = c.id AND mod.user_id = ?) as is_moderator
         FROM communities c
         ${includeArchived ? '' : 'WHERE c.is_archived = 0'}
         ORDER BY c.kind ASC, member_count DESC, c.name ASC`
      )
      .all(viewerId, viewerId) as Record<string, unknown>[];

    const list = rows
      .filter((c) => canViewCommunity(req, String(c.visibility), String(c.id)) || String(c.visibility) === 'university_only' || String(c.visibility) === 'private_approval')
      .map((c) => ({
        ...c,
        is_archived: Boolean(c.is_archived),
        is_member: c.membership_status === 'joined',
        membership_status: (c.membership_status as string) || 'none',
        is_moderator: Boolean(c.is_moderator),
      }));

    return res.json({ communities: list });
  });

  router.post('/communities', requireAdmin, (req: AuthenticatedRequest, res) => {
    const parsed = z
      .object({
        name: z.string().min(2).max(80),
        description: z.string().min(5).max(400),
        kind: z.enum(['academic', 'special']).default('special'),
        visibility: z.enum(['public', 'university_only', 'private_approval']).default('public'),
        rules: z.string().max(1000).default('Be respectful and follow campus community guidelines.'),
      })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid community.' });

    const slug = parsed.data.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const id = `comm-${slug}-${crypto.randomUUID().slice(0, 4)}`;
    db.prepare(
      'INSERT INTO communities (id, slug, name, description, kind, visibility, rules, is_archived, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)'
    ).run(id, slug, parsed.data.name.trim(), parsed.data.description.trim(), parsed.data.kind, parsed.data.visibility, parsed.data.rules.trim(), new Date().toISOString());

    indexSearchEntity(db, 'community', id, parsed.data.name.trim(), parsed.data.description.trim(), parsed.data.visibility);
    writeAuditLog(db, req.user!.id, 'create_community', 'community', id, parsed.data);
    return res.status(201).json({ id, slug, ...parsed.data });
  });

  router.patch('/communities/:id', requireAdmin, (req: AuthenticatedRequest, res) => {
    const parsed = z
      .object({
        name: z.string().min(2).max(80).optional(),
        description: z.string().max(400).optional(),
        visibility: z.enum(['public', 'university_only', 'private_approval']).optional(),
        rules: z.string().max(1000).optional(),
        is_archived: z.boolean().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid community update.' });
    const d = parsed.data;
    db.prepare(
      `UPDATE communities SET
        name = COALESCE(?, name),
        description = COALESCE(?, description),
        visibility = COALESCE(?, visibility),
        rules = COALESCE(?, rules),
        is_archived = COALESCE(?, is_archived)
       WHERE id = ?`
    ).run(
      d.name?.trim() ?? null,
      d.description?.trim() ?? null,
      d.visibility ?? null,
      d.rules?.trim() ?? null,
      d.is_archived !== undefined ? (d.is_archived ? 1 : 0) : null,
      req.params.id
    );
    writeAuditLog(db, req.user!.id, 'update_community', 'community', req.params.id, d);
    const comm = db.prepare('SELECT * FROM communities WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
    if (comm) {
      indexSearchEntity(db, 'community', String(comm.id), String(comm.name), String(comm.description || ''), String(comm.visibility || 'public'));
    }
    return res.json({ ok: true });
  });

  router.post('/communities/:id/join', requireAuth, (req: AuthenticatedRequest, res) => {
    const comm = db.prepare('SELECT * FROM communities WHERE id = ? AND is_archived = 0').get(req.params.id) as Record<string, unknown> | undefined;
    if (!comm) return res.status(404).json({ error: 'Community not found.' });

    if (req.user!.role === 'visitor') {
      return res.status(403).json({ error: 'Visitors have read-only access.' });
    }
    if (String(comm.visibility) === 'university_only' && !req.user!.university_email_verified && !isModeratorOrAbove(req.user!.role)) {
      return res.status(403).json({ error: 'Only verified Gandaki University members can join this community.' });
    }

    const existing = db
      .prepare('SELECT status FROM community_members WHERE community_id = ? AND user_id = ?')
      .get(req.params.id, req.user!.id) as { status: string } | undefined;

    if (existing) {
      db.prepare('DELETE FROM community_members WHERE community_id = ? AND user_id = ?').run(req.params.id, req.user!.id);
      return res.json({ joined: false, status: 'none' });
    }

    const status = String(comm.visibility) === 'private_approval' ? 'pending' : 'joined';
    db.prepare('INSERT INTO community_members (community_id, user_id, status, created_at) VALUES (?, ?, ?, ?)').run(
      req.params.id,
      req.user!.id,
      status,
      new Date().toISOString()
    );
    return res.json({ joined: status === 'joined', status });
  });

  // Posts feed with sorting & visibility permissions
  router.get('/posts', (req: AuthenticatedRequest, res) => {
    const { community_id, community_slug, sort = 'latest', program_id, subject_id, bookmarked, mine } = req.query as Record<string, string>;
    const viewerId = req.user?.id || '';

    const conditions: string[] = ['p.is_hidden = 0', 'c.is_archived = 0'];
    const params: (string | number)[] = [];

    if (community_id) {
      conditions.push('p.community_id = ?');
      params.push(community_id);
    }
    if (community_slug) {
      conditions.push('c.slug = ?');
      params.push(community_slug);
    }
    if (program_id) {
      conditions.push('p.program_id = ?');
      params.push(program_id);
    }
    if (subject_id) {
      conditions.push('p.subject_id = ?');
      params.push(subject_id);
    }
    if (mine === 'true' && req.user) {
      conditions.push('p.author_id = ?');
      params.push(req.user.id);
    }
    if (bookmarked === 'true' && req.user) {
      conditions.push("EXISTS (SELECT 1 FROM bookmarks b WHERE b.user_id = ? AND b.target_type = 'post' AND b.target_id = p.id)");
      params.push(req.user.id);
    }
    if (req.user) {
      conditions.push('NOT EXISTS (SELECT 1 FROM user_blocks ub WHERE ub.blocker_id = ? AND ub.blocked_id = p.author_id)');
      params.push(req.user.id);
    }

    let orderBy = 'p.is_pinned DESC, p.created_at DESC';
    if (sort === 'top') {
      orderBy = 'p.is_pinned DESC, (p.upvote_count - p.downvote_count) DESC, p.created_at DESC';
    } else if (sort === 'trending') {
      orderBy = 'p.is_pinned DESC, ((p.upvote_count * 2 + p.comment_count * 3) * 1.0 / (1.0 + (julianday("now") - julianday(p.created_at)) * 24.0)) DESC';
    } else if (sort === 'for_you' && req.user?.program_id) {
      orderBy = `p.is_pinned DESC, (CASE WHEN p.program_id = '${req.user.program_id.replace(/[^a-zA-Z0-9-]/g, '')}' THEN 1 ELSE 0 END) DESC, p.created_at DESC`;
    }

    const rows = db
      .prepare(
        `SELECT p.*,
          c.slug as community_slug, c.name as community_name, c.visibility as community_visibility, c.kind as community_kind,
          pr.code as program_code,
          sem.name as semester_name,
          sub.name as subject_name,
          u.display_name as author_name, u.username as author_username, u.role as author_role, u.university_email_verified as author_verified,
          (SELECT value FROM votes v WHERE v.user_id = ? AND v.target_type = 'post' AND v.target_id = p.id) as user_vote,
          (SELECT 1 FROM bookmarks b WHERE b.user_id = ? AND b.target_type = 'post' AND b.target_id = p.id) as is_bookmarked
         FROM posts p
         JOIN communities c ON c.id = p.community_id
         JOIN users u ON u.id = p.author_id
         LEFT JOIN programs pr ON pr.id = p.program_id
         LEFT JOIN semesters sem ON sem.id = p.semester_id
         LEFT JOIN subjects sub ON sub.id = p.subject_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY ${orderBy}
         LIMIT 60`
      )
      .all(viewerId, viewerId, ...params) as Record<string, unknown>[];

    const visible = rows.filter((r) => canViewCommunity(req, String(r.community_visibility), String(r.community_id)));

    const posts = visible.map((r) => {
      const pollRow = db.prepare('SELECT * FROM polls WHERE post_id = ?').get(String(r.id)) as Record<string, unknown> | undefined;
      let poll = null;
      if (pollRow) {
        const opts = db
          .prepare(
            `SELECT po.id, po.label,
              (SELECT COUNT(*) FROM poll_votes pv WHERE pv.option_id = po.id) as vote_count
             FROM poll_options po WHERE po.poll_id = ? ORDER BY po.sort_order ASC`
          )
          .all(String(pollRow.id)) as Array<{ id: string; label: string; vote_count: number }>;
        const totalVotes = opts.reduce((acc, o) => acc + Number(o.vote_count), 0);
        const userVoteRow = viewerId
          ? (db.prepare('SELECT option_id FROM poll_votes WHERE poll_id = ? AND user_id = ?').get(String(pollRow.id), viewerId) as { option_id: string } | undefined)
          : undefined;
        poll = {
          id: String(pollRow.id),
          question: String(pollRow.question),
          closes_at: pollRow.closes_at ? String(pollRow.closes_at) : null,
          total_votes: totalVotes,
          user_option_id: userVoteRow?.option_id ?? null,
          options: opts.map((o) => ({
            id: o.id,
            label: o.label,
            vote_count: Number(o.vote_count),
            percentage: totalVotes > 0 ? Math.round((Number(o.vote_count) / totalVotes) * 100) : 0,
          })),
        };
      }

      return {
        id: r.id,
        community_id: r.community_id,
        community_slug: r.community_slug,
        community_name: r.community_name,
        program_id: r.program_id,
        program_code: r.program_code,
        semester_id: r.semester_id,
        semester_name: r.semester_name,
        subject_id: r.subject_id,
        subject_name: r.subject_name,
        author_id: r.author_id,
        author_name: r.author_name,
        author_username: r.author_username,
        author_role: r.author_role,
        author_verified: Boolean(r.author_verified),
        title: r.title,
        body: r.body,
        image_url: r.image_url ? String(r.image_url) : null,
        flair: r.flair,
        tags: JSON.parse(String(r.tags_json || '[]')),
        is_pinned: Boolean(r.is_pinned),
        upvote_count: Number(r.upvote_count),
        downvote_count: Number(r.downvote_count),
        score: Number(r.upvote_count) - Number(r.downvote_count),
        comment_count: Number(r.comment_count),
        user_vote: Number(r.user_vote || 0),
        is_bookmarked: Boolean(r.is_bookmarked),
        poll,
        created_at: r.created_at,
        updated_at: r.updated_at,
        is_demo: Boolean(r.is_demo),
      };
    });

    return res.json({ posts });
  });

  router.post('/posts', requireAuth, (req: AuthenticatedRequest, res) => {
    const parsed = z
      .object({
        community_id: z.string().min(1),
        title: z.string().max(200).default(''),
        body: z.string().max(5000).default(''),
        image_url: z
          .string()
          .regex(/^\/api\/media\/images\/[a-zA-Z0-9._-]+$/, 'Invalid image reference.')
          .nullable()
          .optional(),
        flair: z.string().max(40).optional().nullable(),
        tags: z.array(z.string().max(30)).max(5).default([]),
        program_id: z.string().optional().nullable(),
        semester_id: z.string().optional().nullable(),
        subject_id: z.string().optional().nullable(),
        poll: z
          .object({
            question: z.string().min(3).max(200),
            options: z.array(z.string().min(1).max(100)).min(2).max(6),
          })
          .optional()
          .nullable(),
      })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid post.' });

    const cleanTitle = parsed.data.title.trim();
    const cleanBody = parsed.data.body.trim();
    const cleanImage = parsed.data.image_url || null;
    if (!cleanTitle && !cleanBody && !cleanImage) {
      return res.status(400).json({ error: 'Please include text, a title, or an image to publish a post.' });
    }

    const comm = db.prepare('SELECT * FROM communities WHERE id = ? AND is_archived = 0').get(parsed.data.community_id) as Record<string, unknown> | undefined;
    if (!comm) return res.status(404).json({ error: 'Community not found.' });

    const perm = canPostInCommunity(req.user!.role, comm.kind as 'academic' | 'special', String(comm.slug));
    if (!perm.allowed) return res.status(403).json({ error: perm.reason });
    if (!canViewCommunity(req, String(comm.visibility), String(comm.id))) {
      return res.status(403).json({ error: 'You do not have permission to post in this community.' });
    }

    const profCheck = checkTextAgainstDictionary(`${cleanTitle} ${cleanBody}`, getProfanityRules(db));
    if (profCheck.blocked) {
      return res.status(400).json({
        error: 'Your post contains prohibited abusive language and cannot be published.',
        flagged_terms: profCheck.matches.map((m) => m.term),
      });
    }

    const postId = `post-${crypto.randomUUID().slice(0, 10)}`;
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO posts (id, community_id, program_id, semester_id, subject_id, author_id, title, body, image_url, flair, tags_json, is_pinned, upvote_count, downvote_count, comment_count, is_demo, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 0, 0, 0, ?, ?)`
    ).run(
      postId,
      parsed.data.community_id,
      parsed.data.program_id || null,
      parsed.data.semester_id || null,
      parsed.data.subject_id || null,
      req.user!.id,
      cleanTitle,
      cleanBody,
      cleanImage,
      parsed.data.flair?.trim() || null,
      JSON.stringify(parsed.data.tags),
      now,
      now
    );

    // Creator auto-upvotes
    db.prepare('INSERT INTO votes (user_id, target_type, target_id, value, created_at) VALUES (?, ?, ?, 1, ?)').run(
      req.user!.id,
      'post',
      postId,
      now
    );

    if (parsed.data.poll) {
      const pollId = `poll-${crypto.randomUUID().slice(0, 8)}`;
      db.prepare('INSERT INTO polls (id, post_id, question, closes_at) VALUES (?, ?, ?, ?)').run(
        pollId,
        postId,
        parsed.data.poll.question.trim(),
        new Date(Date.now() + 14 * 86400 * 1000).toISOString()
      );
      parsed.data.poll.options.forEach((opt, i) => {
        db.prepare('INSERT INTO poll_options (id, poll_id, label, sort_order) VALUES (?, ?, ?, ?)').run(
          `popt-${crypto.randomUUID().slice(0, 8)}`,
          pollId,
          opt.trim(),
          i + 1
        );
      });
    }

    indexSearchEntity(db, 'post', postId, cleanTitle || cleanBody.slice(0, 80) || 'Image Post', cleanBody, parsed.data.tags.join(' '));
    return res.status(201).json({ id: postId, profanity_warning: profCheck.flagged });
  });

  router.patch('/posts/:id', requireAuth, (req: AuthenticatedRequest, res) => {
    const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
    if (!post) return res.status(404).json({ error: 'Post not found.' });

    const isOwner = String(post.author_id) === req.user!.id;
    const isMod = isAdminRole(req.user!.role) || req.user!.moderated_community_ids.includes(String(post.community_id));

    const parsed = z
      .object({
        title: z.string().max(200).optional(),
        body: z.string().max(5000).optional(),
        image_url: z
          .string()
          .regex(/^\/api\/media\/images\/[a-zA-Z0-9._-]+$/)
          .nullable()
          .optional(),
        is_pinned: z.boolean().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid post update.' });

    if (parsed.data.is_pinned !== undefined && !isMod) {
      return res.status(403).json({ error: 'Only community moderators or admins can pin posts.' });
    }
    if ((parsed.data.title !== undefined || parsed.data.body !== undefined || parsed.data.image_url !== undefined) && !isOwner && !isAdminRole(req.user!.role)) {
      return res.status(403).json({ error: 'You can only edit your own posts.' });
    }

    const nextImageUrl: string | null =
      parsed.data.image_url !== undefined
        ? parsed.data.image_url
        : post.image_url
          ? String(post.image_url)
          : null;

    db.prepare(
      `UPDATE posts SET
        title = COALESCE(?, title),
        body = COALESCE(?, body),
        image_url = ?,
        is_pinned = COALESCE(?, is_pinned),
        updated_at = ?
       WHERE id = ?`
    ).run(
      parsed.data.title !== undefined ? parsed.data.title.trim() : null,
      parsed.data.body !== undefined ? parsed.data.body.trim() : null,
      nextImageUrl,
      parsed.data.is_pinned !== undefined ? (parsed.data.is_pinned ? 1 : 0) : null,
      new Date().toISOString(),
      req.params.id
    );

    const updated = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id) as Record<string, unknown>;
    indexSearchEntity(db, 'post', req.params.id, String(updated.title), String(updated.body), '');
    return res.json({ ok: true });
  });

  router.delete('/posts/:id', requireAuth, (req: AuthenticatedRequest, res) => {
    const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
    if (!post) return res.status(404).json({ error: 'Post not found.' });
    const isMod = isAdminRole(req.user!.role) || req.user!.moderated_community_ids.includes(String(post.community_id));
    if (String(post.author_id) !== req.user!.id && !isMod) {
      return res.status(403).json({ error: 'Unauthorized to delete this post.' });
    }
    db.prepare('DELETE FROM posts WHERE id = ?').run(req.params.id);
    removeSearchEntity(db, 'post', req.params.id);
    return res.json({ ok: true });
  });

  // Poll voting
  router.post('/polls/:pollId/vote', requireAuth, (req: AuthenticatedRequest, res) => {
    if (req.user!.role === 'visitor') return res.status(403).json({ error: 'Visitors cannot vote in polls.' });
    const { option_id } = z.object({ option_id: z.string().min(1) }).parse(req.body);
    db.prepare('INSERT OR REPLACE INTO poll_votes (poll_id, option_id, user_id, created_at) VALUES (?, ?, ?, ?)').run(
      req.params.pollId,
      option_id,
      req.user!.id,
      new Date().toISOString()
    );
    return res.json({ ok: true });
  });

  // Comments (nested tree)
  router.get('/posts/:postId/comments', (req: AuthenticatedRequest, res) => {
    const viewerId = req.user?.id || '';
    const rows = db
      .prepare(
        `SELECT cm.*, u.display_name as author_name, u.username as author_username, u.role as author_role, u.university_email_verified as author_verified,
          (SELECT value FROM votes v WHERE v.user_id = ? AND v.target_type = 'comment' AND v.target_id = cm.id) as user_vote
         FROM comments cm
         JOIN users u ON u.id = cm.author_id
         WHERE cm.post_id = ? AND cm.is_hidden = 0
         ORDER BY cm.created_at ASC`
      )
      .all(viewerId, req.params.postId) as Record<string, unknown>[];

    const map = new Map<string, CommentItem>();
    const roots: CommentItem[] = [];

    for (const r of rows) {
      const item: CommentItem = {
        id: String(r.id),
        post_id: String(r.post_id),
        parent_comment_id: r.parent_comment_id ? String(r.parent_comment_id) : null,
        author_id: String(r.author_id),
        author_name: String(r.author_name),
        author_username: String(r.author_username),
        author_role: r.author_role as CommentItem['author_role'],
        author_verified: Boolean(r.author_verified),
        body: String(r.body),
        upvote_count: Number(r.upvote_count),
        downvote_count: Number(r.downvote_count),
        user_vote: Number(r.user_vote || 0),
        created_at: String(r.created_at),
        replies: [],
      };
      map.set(item.id, item);
    }

    for (const item of map.values()) {
      if (item.parent_comment_id && map.has(item.parent_comment_id)) {
        map.get(item.parent_comment_id)!.replies!.push(item);
      } else {
        roots.push(item);
      }
    }

    return res.json({ comments: roots });
  });

  router.post('/posts/:postId/comments', requireAuth, (req: AuthenticatedRequest, res) => {
    const parsed = z
      .object({
        body: z.string().min(1).max(3000),
        parent_comment_id: z.string().nullable().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Comment text is required.' });

    const post = db
      .prepare(
        'SELECT p.*, c.kind as community_kind, c.slug as community_slug FROM posts p JOIN communities c ON c.id = p.community_id WHERE p.id = ?'
      )
      .get(req.params.postId) as Record<string, unknown> | undefined;
    if (!post) return res.status(404).json({ error: 'Post not found.' });

    if (!canVoteOrComment(req.user!.role, post.community_kind as 'academic' | 'special', String(post.community_slug))) {
      return res.status(403).json({ error: 'Your account role does not allow commenting in this community.' });
    }

    const profCheck = checkTextAgainstDictionary(parsed.data.body, getProfanityRules(db));
    if (profCheck.blocked) {
      return res.status(400).json({ error: 'Comment contains prohibited abusive language.' });
    }

    const id = `cmt-${crypto.randomUUID().slice(0, 10)}`;
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO comments (id, post_id, parent_comment_id, author_id, body, upvote_count, downvote_count, is_hidden, created_at) VALUES (?, ?, ?, ?, ?, 1, 0, 0, ?)'
    ).run(id, req.params.postId, parsed.data.parent_comment_id ?? null, req.user!.id, parsed.data.body.trim(), now);

    db.prepare('UPDATE posts SET comment_count = comment_count + 1 WHERE id = ?').run(req.params.postId);

    if (String(post.author_id) !== req.user!.id) {
      createNotification(
        db,
        String(post.author_id),
        'post_reply',
        'New Reply on Your Post',
        `${req.user!.display_name} commented on "${String(post.title).slice(0, 60)}"`,
        `/communities/${post.community_slug}`
      );
    }

    return res.status(201).json({ id });
  });

  // Unified Voting (prevents duplicate votes via PRIMARY KEY (user_id, target_type, target_id))
  router.post('/votes', requireAuth, (req: AuthenticatedRequest, res) => {
    if (req.user!.role === 'visitor') {
      return res.status(403).json({ error: 'Visitors have read-only access and cannot vote.' });
    }

    const parsed = z
      .object({
        target_type: z.enum(['post', 'comment', 'resource', 'idea']),
        target_id: z.string().min(1),
        value: z.union([z.literal(1), z.literal(-1), z.literal(0)]),
      })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid vote request.' });

    const { target_type, target_id, value } = parsed.data;
    const existing = db
      .prepare('SELECT value FROM votes WHERE user_id = ? AND target_type = ? AND target_id = ?')
      .get(req.user!.id, target_type, target_id) as { value: number } | undefined;

    const oldVal = existing?.value ?? 0;
    const newVal = value === oldVal ? 0 : value; // Clicking active vote toggles off

    if (newVal === 0) {
      db.prepare('DELETE FROM votes WHERE user_id = ? AND target_type = ? AND target_id = ?').run(
        req.user!.id,
        target_type,
        target_id
      );
    } else {
      db.prepare('INSERT OR REPLACE INTO votes (user_id, target_type, target_id, value, created_at) VALUES (?, ?, ?, ?, ?)').run(
        req.user!.id,
        target_type,
        target_id,
        newVal,
        new Date().toISOString()
      );
    }

    const upDelta = (newVal === 1 ? 1 : 0) - (oldVal === 1 ? 1 : 0);
    const downDelta = (newVal === -1 ? 1 : 0) - (oldVal === -1 ? 1 : 0);

    if (target_type === 'post') {
      db.prepare('UPDATE posts SET upvote_count = MAX(0, upvote_count + ?), downvote_count = MAX(0, downvote_count + ?) WHERE id = ?').run(
        upDelta,
        downDelta,
        target_id
      );
    } else if (target_type === 'comment') {
      db.prepare('UPDATE comments SET upvote_count = MAX(0, upvote_count + ?), downvote_count = MAX(0, downvote_count + ?) WHERE id = ?').run(
        upDelta,
        downDelta,
        target_id
      );
    } else if (target_type === 'resource') {
      db.prepare('UPDATE resources SET upvote_count = MAX(0, upvote_count + ?) WHERE id = ?').run(upDelta, target_id);
    } else if (target_type === 'idea') {
      db.prepare('UPDATE ideas SET upvote_count = MAX(0, upvote_count + ?) WHERE id = ?').run(upDelta, target_id);
    }

    return res.json({ user_vote: newVal });
  });

  // Bookmarks
  router.post('/bookmarks/toggle', requireAuth, (req: AuthenticatedRequest, res) => {
    const parsed = z
      .object({
        target_type: z.enum(['post', 'resource']),
        target_id: z.string().min(1),
      })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid bookmark target.' });

    const existing = db
      .prepare('SELECT 1 FROM bookmarks WHERE user_id = ? AND target_type = ? AND target_id = ?')
      .get(req.user!.id, parsed.data.target_type, parsed.data.target_id);

    if (existing) {
      db.prepare('DELETE FROM bookmarks WHERE user_id = ? AND target_type = ? AND target_id = ?').run(
        req.user!.id,
        parsed.data.target_type,
        parsed.data.target_id
      );
      return res.json({ bookmarked: false });
    }
    db.prepare('INSERT INTO bookmarks (user_id, target_type, target_id, created_at) VALUES (?, ?, ?, ?)').run(
      req.user!.id,
      parsed.data.target_type,
      parsed.data.target_id,
      new Date().toISOString()
    );
    return res.json({ bookmarked: true });
  });

  router.get('/bookmarks', requireAuth, (req: AuthenticatedRequest, res) => {
    const resources = db
      .prepare(
        `SELECT r.id, r.title, sub.name as subject_name, p.code as program_code, rc.name as category_name
         FROM bookmarks b
         JOIN resources r ON r.id = b.target_id
         JOIN subjects sub ON sub.id = r.subject_id
         JOIN programs p ON p.id = r.program_id
         JOIN resource_categories rc ON rc.id = r.category_id
         WHERE b.user_id = ? AND b.target_type = 'resource' AND r.status = 'approved'
         ORDER BY b.created_at DESC`
      )
      .all(req.user!.id);

    const posts = db
      .prepare(
        `SELECT p.id, p.title, c.name as community_name, c.slug as community_slug
         FROM bookmarks b
         JOIN posts p ON p.id = b.target_id
         JOIN communities c ON c.id = p.community_id
         WHERE b.user_id = ? AND b.target_type = 'post'
         ORDER BY b.created_at DESC`
      )
      .all(req.user!.id);

    return res.json({ resources, posts });
  });

  // Report content
  router.post('/reports', requireAuth, (req: AuthenticatedRequest, res) => {
    if (req.user!.role === 'visitor') return res.status(403).json({ error: 'Sign in with a member account to submit reports.' });
    const parsed = z
      .object({
        target_type: z.enum(['post', 'comment', 'resource', 'confession', 'user']),
        target_id: z.string().min(1),
        reason: z.string().min(3).max(120),
        details: z.string().max(600).default(''),
      })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Please provide a report reason.' });

    const id = `rep-${crypto.randomUUID().slice(0, 10)}`;
    db.prepare(
      'INSERT INTO reports (id, reporter_id, target_type, target_id, reason, details, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      id,
      req.user!.id,
      parsed.data.target_type,
      parsed.data.target_id,
      parsed.data.reason.trim(),
      parsed.data.details.trim(),
      'open',
      new Date().toISOString()
    );
    return res.status(201).json({ id, message: 'Report submitted for moderator review.' });
  });

  return router;
}
