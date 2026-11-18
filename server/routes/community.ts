import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import {
  type AuthenticatedRequest,
  requireAdmin,
  requireAuth,
} from '../authMiddleware.ts';
import { type AppDatabase, type DbExecutor, createNotification, writeAuditLog } from '../db.ts';
import { checkTextAgainstDictionary, type ProfanityRule } from '../profanity.ts';
import {
  canPostInCommunity,
  canVoteOrComment,
  isAdminRole,
  isModeratorOrAbove,
  isUuid,
} from '../security.ts';
import type { CommentItem } from '../../src/types/index.ts';

async function getProfanityRules(db: DbExecutor): Promise<ProfanityRule[]> {
  return db.query('SELECT * FROM profanity_dictionary') as unknown as Promise<ProfanityRule[]>;
}

async function canViewCommunity(
  db: DbExecutor,
  req: AuthenticatedRequest,
  visibility: string,
  communityId: string
): Promise<boolean> {
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
    const member = await db.queryOne(
      "SELECT status FROM community_members WHERE community_id = $1 AND user_id = $2 AND status = 'joined'",
      [communityId, req.user.id]
    );
    return Boolean(member);
  }
  return false;
}

export function createCommunityRouter(db: AppDatabase): Router {
  const router = Router();

  router.get('/communities', async (req: AuthenticatedRequest, res, next) => {
    try {
      const includeArchived = req.query.includeArchived === 'true' && req.user && isAdminRole(req.user.role);
      const viewerId = req.user?.id || null;

      const rows = await db.query<Record<string, unknown>>(
        `SELECT c.*,
          (SELECT COUNT(*) FROM community_members cm WHERE cm.community_id = c.id AND cm.status = 'joined') AS member_count,
          (SELECT COUNT(*) FROM posts p WHERE p.community_id = c.id AND p.is_hidden = FALSE AND p.created_at >= NOW() - INTERVAL '7 days') AS recent_posts_count,
          (SELECT status FROM community_members cm2 WHERE cm2.community_id = c.id AND cm2.user_id = $1) AS membership_status,
          (SELECT 1 FROM community_moderators mod WHERE mod.community_id = c.id AND mod.user_id = $1) AS is_moderator
         FROM communities c
         ${includeArchived ? '' : 'WHERE c.is_archived = FALSE'}
         ORDER BY c.kind ASC, member_count DESC, c.name ASC`,
        [viewerId]
      );

      const list = rows.map((c) => ({
        ...c,
        member_count: Number(c.member_count || 0),
        recent_posts_count: Number(c.recent_posts_count || 0),
        is_archived: Boolean(c.is_archived),
        is_member: c.membership_status === 'joined',
        membership_status: (c.membership_status as string) || 'none',
        is_moderator: Boolean(c.is_moderator),
      }));

      return res.json({ communities: list });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/communities', requireAdmin, async (req: AuthenticatedRequest, res, next) => {
    try {
      const parsed = z
        .object({
          name: z.string().min(2).max(80),
          description: z.string().min(5).max(400),
          kind: z.enum(['academic', 'special']).default('special'),
          visibility: z.enum(['public', 'university_only', 'private_approval']).default('public'),
          rules: z.string().max(1000).default('Be respectful and follow campus community guidelines.'),
        })
        .safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid community.' });
      }

      const baseSlug = parsed.data.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'community';
      const existingSlug = await db.queryOne('SELECT id FROM communities WHERE slug = $1', [baseSlug]);
      const slug = existingSlug ? `${baseSlug}-${crypto.randomUUID().slice(0, 4)}` : baseSlug;
      const id = crypto.randomUUID();

      await db.execute(
        'INSERT INTO communities (id, slug, name, description, kind, visibility, rules, is_archived, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, NOW())',
        [id, slug, parsed.data.name.trim(), parsed.data.description.trim(), parsed.data.kind, parsed.data.visibility, parsed.data.rules.trim()]
      );

      await writeAuditLog(db, req.user!.id, 'create_community', 'community', id, parsed.data);
      return res.status(201).json({ id, slug, ...parsed.data });
    } catch (err) {
      return next(err);
    }
  });

  router.patch('/communities/:id', requireAdmin, async (req: AuthenticatedRequest, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Community not found.' });
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
      await db.execute(
        `UPDATE communities SET
          name = COALESCE($1, name),
          description = COALESCE($2, description),
          visibility = COALESCE($3, visibility),
          rules = COALESCE($4, rules),
          is_archived = COALESCE($5, is_archived)
         WHERE id = $6`,
        [
          d.name?.trim() ?? null,
          d.description?.trim() ?? null,
          d.visibility ?? null,
          d.rules?.trim() ?? null,
          d.is_archived ?? null,
          req.params.id,
        ]
      );
      await writeAuditLog(db, req.user!.id, 'update_community', 'community', req.params.id, d);
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/communities/:id/join', requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Community not found.' });
      const comm = await db.queryOne<Record<string, unknown>>(
        'SELECT * FROM communities WHERE id = $1 AND is_archived = FALSE',
        [req.params.id]
      );
      if (!comm) return res.status(404).json({ error: 'Community not found.' });

      if (req.user!.role === 'visitor') {
        return res.status(403).json({ error: 'Visitors have read-only access.' });
      }
      if (
        String(comm.visibility) === 'university_only' &&
        !req.user!.university_email_verified &&
        !isModeratorOrAbove(req.user!.role)
      ) {
        return res.status(403).json({ error: 'Only verified Gandaki University members can join this community.' });
      }

      const existing = await db.queryOne<{ status: string }>(
        'SELECT status FROM community_members WHERE community_id = $1 AND user_id = $2',
        [req.params.id, req.user!.id]
      );

      if (existing) {
        await db.execute('DELETE FROM community_members WHERE community_id = $1 AND user_id = $2', [
          req.params.id,
          req.user!.id,
        ]);
        return res.json({ joined: false, status: 'none' });
      }

      const status = String(comm.visibility) === 'private_approval' ? 'pending' : 'joined';
      await db.execute(
        'INSERT INTO community_members (community_id, user_id, status, created_at) VALUES ($1, $2, $3, NOW())',
        [req.params.id, req.user!.id, status]
      );
      return res.json({ joined: status === 'joined', status });
    } catch (err) {
      return next(err);
    }
  });

  // Posts feed with sorting & visibility permissions
  router.get('/posts', async (req: AuthenticatedRequest, res, next) => {
    try {
      const { community_id, community_slug, sort = 'latest', program_id, subject_id, bookmarked, mine } = req.query as Record<string, string>;
      const viewerId = req.user?.id || null;

      const conditions: string[] = ['p.is_hidden = FALSE', 'c.is_archived = FALSE'];
      const params: unknown[] = [viewerId];

      const addParam = (val: unknown) => {
        params.push(val);
        return `$${params.length}`;
      };

      if (isUuid(community_id)) conditions.push(`p.community_id = ${addParam(community_id)}`);
      if (community_slug) conditions.push(`c.slug = ${addParam(community_slug)}`);
      if (isUuid(program_id)) conditions.push(`p.program_id = ${addParam(program_id)}`);
      if (isUuid(subject_id)) conditions.push(`p.subject_id = ${addParam(subject_id)}`);
      if (mine === 'true' && req.user) conditions.push(`p.author_id = ${addParam(req.user.id)}`);
      if (bookmarked === 'true' && req.user) {
        conditions.push(
          `EXISTS (SELECT 1 FROM bookmarks b WHERE b.user_id = ${addParam(req.user.id)} AND b.target_type = 'post' AND b.target_id = p.id)`
        );
      }
      if (req.user) {
        conditions.push(
          `NOT EXISTS (SELECT 1 FROM user_blocks ub WHERE ub.blocker_id = ${addParam(req.user.id)} AND ub.blocked_id = p.author_id)`
        );
      }

      let orderBy = 'p.is_pinned DESC, p.created_at DESC';
      if (sort === 'top') {
        orderBy = 'p.is_pinned DESC, (p.upvote_count - p.downvote_count) DESC, p.created_at DESC';
      } else if (sort === 'trending') {
        orderBy =
          'p.is_pinned DESC, ((p.upvote_count * 2 + p.comment_count * 3)::float / (1.0 + GREATEST(0, EXTRACT(EPOCH FROM (NOW() - p.created_at)) / 3600.0))) DESC';
      } else if (sort === 'for_you' && isUuid(req.user?.program_id)) {
        const pParam = addParam(req.user!.program_id);
        orderBy = `p.is_pinned DESC, (CASE WHEN p.program_id = ${pParam} THEN 1 ELSE 0 END) DESC, p.created_at DESC`;
      }

      const rows = await db.query<Record<string, unknown>>(
        `SELECT p.*,
          c.slug AS community_slug, c.name AS community_name, c.visibility AS community_visibility, c.kind AS community_kind,
          pr.code AS program_code,
          sem.name AS semester_name,
          sub.name AS subject_name,
          u.display_name AS author_name, u.username AS author_username, u.role AS author_role, u.university_email_verified AS author_verified,
          (SELECT value FROM votes v WHERE v.user_id = $1 AND v.target_type = 'post' AND v.target_id = p.id) AS user_vote,
          (SELECT 1 FROM bookmarks b WHERE b.user_id = $1 AND b.target_type = 'post' AND b.target_id = p.id) AS is_bookmarked
         FROM posts p
         JOIN communities c ON c.id = p.community_id
         JOIN profiles u ON u.id = p.author_id
         LEFT JOIN programs pr ON pr.id = p.program_id
         LEFT JOIN semesters sem ON sem.id = p.semester_id
         LEFT JOIN subjects sub ON sub.id = p.subject_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY ${orderBy}
         LIMIT 60`,
        params
      );

      const visible: Record<string, unknown>[] = [];
      for (const r of rows) {
        if (await canViewCommunity(db, req, String(r.community_visibility), String(r.community_id))) {
          visible.push(r);
        }
      }

      const postIds = visible.map((r) => String(r.id));
      const pollMap = new Map<string, Record<string, unknown>>();
      const optionsByPoll = new Map<string, Array<{ id: string; label: string; vote_count: number }>>();
      const userPollVotes = new Map<string, string>();

      if (postIds.length > 0) {
        const pollRows = await db.query<Record<string, unknown>>(
          'SELECT * FROM polls WHERE post_id = ANY($1::uuid[])',
          [postIds]
        );
        const pollIds = pollRows.map((p) => String(p.id));
        for (const pr of pollRows) {
          pollMap.set(String(pr.post_id), pr);
        }
        if (pollIds.length > 0) {
          const optRows = await db.query<{ id: string; poll_id: string; label: string; vote_count: string | number }>(
            `SELECT po.id, po.poll_id, po.label,
              (SELECT COUNT(*) FROM poll_votes pv WHERE pv.option_id = po.id) AS vote_count
             FROM poll_options po
             WHERE po.poll_id = ANY($1::uuid[])
             ORDER BY po.sort_order ASC`,
            [pollIds]
          );
          for (const opt of optRows) {
            const list = optionsByPoll.get(String(opt.poll_id)) || [];
            list.push({ id: String(opt.id), label: String(opt.label), vote_count: Number(opt.vote_count || 0) });
            optionsByPoll.set(String(opt.poll_id), list);
          }

          if (viewerId) {
            const pvRows = await db.query<{ poll_id: string; option_id: string }>(
              'SELECT poll_id, option_id FROM poll_votes WHERE poll_id = ANY($1::uuid[]) AND user_id = $2',
              [pollIds, viewerId]
            );
            for (const pv of pvRows) {
              userPollVotes.set(String(pv.poll_id), String(pv.option_id));
            }
          }
        }
      }

      const posts = visible.map((r) => {
        const pollRow = pollMap.get(String(r.id));
        let poll = null;
        if (pollRow) {
          const pid = String(pollRow.id);
          const opts = optionsByPoll.get(pid) || [];
          const totalVotes = opts.reduce((acc, o) => acc + o.vote_count, 0);
          poll = {
            id: pid,
            question: String(pollRow.question),
            closes_at: pollRow.closes_at ? new Date(String(pollRow.closes_at)).toISOString() : null,
            total_votes: totalVotes,
            user_option_id: userPollVotes.get(pid) ?? null,
            options: opts.map((o) => ({
              id: o.id,
              label: o.label,
              vote_count: o.vote_count,
              percentage: totalVotes > 0 ? Math.round((o.vote_count / totalVotes) * 100) : 0,
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
          tags: Array.isArray(r.tags) ? r.tags : [],
          is_pinned: Boolean(r.is_pinned),
          upvote_count: Number(r.upvote_count || 0),
          downvote_count: Number(r.downvote_count || 0),
          score: Number(r.upvote_count || 0) - Number(r.downvote_count || 0),
          comment_count: Number(r.comment_count || 0),
          user_vote: Number(r.user_vote || 0),
          is_bookmarked: Boolean(r.is_bookmarked),
          poll,
          created_at: new Date(String(r.created_at)).toISOString(),
          updated_at: new Date(String(r.updated_at)).toISOString(),
        };
      });

      return res.json({ posts });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/posts', requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
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
      if (!parsed.success || !isUuid(parsed.data.community_id)) {
        return res.status(400).json({ error: parsed.success ? 'Invalid community.' : parsed.error.issues[0]?.message || 'Invalid post.' });
      }

      const cleanTitle = parsed.data.title.trim();
      const cleanBody = parsed.data.body.trim();
      const cleanImage = parsed.data.image_url || null;
      if (!cleanTitle && !cleanBody && !cleanImage) {
        return res.status(400).json({ error: 'Please include text, a title, or an image to publish a post.' });
      }

      const comm = await db.queryOne<Record<string, unknown>>(
        'SELECT * FROM communities WHERE id = $1 AND is_archived = FALSE',
        [parsed.data.community_id]
      );
      if (!comm) return res.status(404).json({ error: 'Community not found.' });

      const perm = canPostInCommunity(req.user!.role, comm.kind as 'academic' | 'special', String(comm.slug));
      if (!perm.allowed) return res.status(403).json({ error: perm.reason });
      if (!(await canViewCommunity(db, req, String(comm.visibility), String(comm.id)))) {
        return res.status(403).json({ error: 'You do not have permission to post in this community.' });
      }

      const rules = await getProfanityRules(db);
      const profCheck = checkTextAgainstDictionary(`${cleanTitle} ${cleanBody}`, rules);
      if (profCheck.blocked) {
        return res.status(400).json({
          error: 'Your post contains prohibited abusive language and cannot be published.',
          flagged_terms: profCheck.matches.map((m) => m.term),
        });
      }

      const postId = crypto.randomUUID();
      const cleanTags = Array.from(new Set(parsed.data.tags.map((t) => t.trim()).filter(Boolean)));

      await db.transaction(async (tx) => {
        await tx.execute(
          `INSERT INTO posts (id, community_id, program_id, semester_id, subject_id, author_id, title, body, image_url, flair, tags, is_pinned, is_hidden, upvote_count, downvote_count, comment_count, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::text[], FALSE, FALSE, 1, 0, 0, NOW(), NOW())`,
          [
            postId,
            parsed.data.community_id,
            isUuid(parsed.data.program_id) ? parsed.data.program_id : null,
            isUuid(parsed.data.semester_id) ? parsed.data.semester_id : null,
            isUuid(parsed.data.subject_id) ? parsed.data.subject_id : null,
            req.user!.id,
            cleanTitle,
            cleanBody,
            cleanImage,
            parsed.data.flair?.trim() || null,
            cleanTags,
          ]
        );

        await tx.execute(
          "INSERT INTO votes (user_id, target_type, target_id, value, created_at) VALUES ($1, 'post', $2, 1, NOW())",
          [req.user!.id, postId]
        );

        for (const tagName of cleanTags) {
          const slug = tagName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || tagName.toLowerCase();
          await tx.execute(
            `INSERT INTO tags (id, name, slug, created_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (slug) DO NOTHING`,
            [crypto.randomUUID(), tagName, slug]
          );
          const tagRow = await tx.queryOne<{ id: string }>('SELECT id FROM tags WHERE slug = $1', [slug]);
          if (tagRow) {
            await tx.execute(
              'INSERT INTO post_tags (post_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
              [postId, tagRow.id]
            );
          }
        }

        if (parsed.data.poll) {
          const pollId = crypto.randomUUID();
          await tx.execute(
            'INSERT INTO polls (id, post_id, question, closes_at) VALUES ($1, $2, $3, $4::timestamptz)',
            [pollId, postId, parsed.data.poll.question.trim(), new Date(Date.now() + 14 * 86400 * 1000).toISOString()]
          );
          for (let i = 0; i < parsed.data.poll.options.length; i++) {
            await tx.execute(
              'INSERT INTO poll_options (id, poll_id, label, sort_order) VALUES ($1, $2, $3, $4)',
              [crypto.randomUUID(), pollId, parsed.data.poll.options[i].trim(), i + 1]
            );
          }
        }
      });

      return res.status(201).json({ id: postId, profanity_warning: profCheck.flagged });
    } catch (err) {
      return next(err);
    }
  });

  router.patch('/posts/:id', requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Post not found.' });
      const post = await db.queryOne<Record<string, unknown>>('SELECT * FROM posts WHERE id = $1', [req.params.id]);
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
      if (
        (parsed.data.title !== undefined || parsed.data.body !== undefined || parsed.data.image_url !== undefined) &&
        !isOwner &&
        !isAdminRole(req.user!.role)
      ) {
        return res.status(403).json({ error: 'You can only edit your own posts.' });
      }

      const nextImageUrl: string | null =
        parsed.data.image_url !== undefined
          ? parsed.data.image_url
          : post.image_url
            ? String(post.image_url)
            : null;

      await db.execute(
        `UPDATE posts SET
          title = COALESCE($1, title),
          body = COALESCE($2, body),
          image_url = $3,
          is_pinned = COALESCE($4, is_pinned),
          updated_at = NOW()
         WHERE id = $5`,
        [
          parsed.data.title !== undefined ? parsed.data.title.trim() : null,
          parsed.data.body !== undefined ? parsed.data.body.trim() : null,
          nextImageUrl,
          parsed.data.is_pinned ?? null,
          req.params.id,
        ]
      );

      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });

  router.delete('/posts/:id', requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Post not found.' });
      const post = await db.queryOne<Record<string, unknown>>('SELECT * FROM posts WHERE id = $1', [req.params.id]);
      if (!post) return res.status(404).json({ error: 'Post not found.' });
      const isMod = isAdminRole(req.user!.role) || req.user!.moderated_community_ids.includes(String(post.community_id));
      if (String(post.author_id) !== req.user!.id && !isMod) {
        return res.status(403).json({ error: 'Unauthorized to delete this post.' });
      }
      await db.execute('DELETE FROM posts WHERE id = $1', [req.params.id]);
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });

  // Poll voting
  router.post('/polls/:pollId/vote', requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
      if (req.user!.role === 'visitor') return res.status(403).json({ error: 'Visitors cannot vote in polls.' });
      if (!isUuid(req.params.pollId)) return res.status(404).json({ error: 'Poll not found.' });
      const parsed = z.object({ option_id: z.string().min(1) }).safeParse(req.body);
      if (!parsed.success || !isUuid(parsed.data.option_id)) {
        return res.status(400).json({ error: 'Invalid poll option.' });
      }
      await db.execute(
        `INSERT INTO poll_votes (poll_id, option_id, user_id, created_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (poll_id, user_id) DO UPDATE SET option_id = EXCLUDED.option_id, created_at = NOW()`,
        [req.params.pollId, parsed.data.option_id, req.user!.id]
      );
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });

  // Comments (nested tree)
  router.get('/posts/:postId/comments', async (req: AuthenticatedRequest, res, next) => {
    try {
      if (!isUuid(req.params.postId)) return res.status(404).json({ error: 'Post not found.' });
      const viewerId = req.user?.id || null;
      const rows = await db.query<Record<string, unknown>>(
        `SELECT cm.*, u.display_name AS author_name, u.username AS author_username, u.role AS author_role, u.university_email_verified AS author_verified,
          (SELECT value FROM votes v WHERE v.user_id = $1 AND v.target_type = 'comment' AND v.target_id = cm.id) AS user_vote
         FROM comments cm
         JOIN profiles u ON u.id = cm.author_id
         WHERE cm.post_id = $2 AND cm.is_hidden = FALSE
         ORDER BY cm.created_at ASC`,
        [viewerId, req.params.postId]
      );

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
          upvote_count: Number(r.upvote_count || 0),
          downvote_count: Number(r.downvote_count || 0),
          user_vote: Number(r.user_vote || 0),
          created_at: new Date(String(r.created_at)).toISOString(),
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
    } catch (err) {
      return next(err);
    }
  });

  router.post('/posts/:postId/comments', requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
      if (!isUuid(req.params.postId)) return res.status(404).json({ error: 'Post not found.' });
      const parsed = z
        .object({
          body: z.string().min(1).max(3000),
          parent_comment_id: z.string().nullable().optional(),
        })
        .safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Comment text is required.' });

      const post = await db.queryOne<Record<string, unknown>>(
        'SELECT p.*, c.kind AS community_kind, c.slug AS community_slug FROM posts p JOIN communities c ON c.id = p.community_id WHERE p.id = $1',
        [req.params.postId]
      );
      if (!post) return res.status(404).json({ error: 'Post not found.' });

      if (
        !canVoteOrComment(
          req.user!.role,
          post.community_kind as 'academic' | 'special',
          String(post.community_slug)
        )
      ) {
        return res.status(403).json({ error: 'Your account role does not allow commenting in this community.' });
      }

      const rules = await getProfanityRules(db);
      const profCheck = checkTextAgainstDictionary(parsed.data.body, rules);
      if (profCheck.blocked) {
        return res.status(400).json({ error: 'Comment contains prohibited abusive language.' });
      }

      const id = crypto.randomUUID();
      await db.transaction(async (tx) => {
        await tx.execute(
          'INSERT INTO comments (id, post_id, parent_comment_id, author_id, body, upvote_count, downvote_count, is_hidden, created_at) VALUES ($1, $2, $3, $4, $5, 1, 0, FALSE, NOW())',
          [
            id,
            req.params.postId,
            isUuid(parsed.data.parent_comment_id) ? parsed.data.parent_comment_id : null,
            req.user!.id,
            parsed.data.body.trim(),
          ]
        );
        await tx.execute('UPDATE posts SET comment_count = comment_count + 1 WHERE id = $1', [req.params.postId]);

        if (String(post.author_id) !== req.user!.id) {
          await createNotification(
            tx,
            String(post.author_id),
            'post_reply',
            'New Reply on Your Post',
            `${req.user!.display_name} commented on "${String(post.title).slice(0, 60)}"`,
            `/communities/${post.community_slug}`
          );
        }
      });

      return res.status(201).json({ id });
    } catch (err) {
      return next(err);
    }
  });

  // Unified Voting
  router.post('/votes', requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
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
      if (!parsed.success || !isUuid(parsed.data.target_id)) {
        return res.status(400).json({ error: 'Invalid vote request.' });
      }

      const { target_type, target_id, value } = parsed.data;
      const newVal = await db.transaction(async (tx) => {
        const existing = await tx.queryOne<{ value: number }>(
          'SELECT value FROM votes WHERE user_id = $1 AND target_type = $2 AND target_id = $3',
          [req.user!.id, target_type, target_id]
        );

        const oldVal = existing?.value ?? 0;
        const resolved = value === oldVal ? 0 : value;

        if (resolved === 0) {
          await tx.execute(
            'DELETE FROM votes WHERE user_id = $1 AND target_type = $2 AND target_id = $3',
            [req.user!.id, target_type, target_id]
          );
        } else {
          await tx.execute(
            `INSERT INTO votes (user_id, target_type, target_id, value, created_at)
             VALUES ($1, $2, $3, $4, NOW())
             ON CONFLICT (user_id, target_type, target_id) DO UPDATE SET value = EXCLUDED.value, created_at = NOW()`,
            [req.user!.id, target_type, target_id, resolved]
          );
        }

        const upDelta = (resolved === 1 ? 1 : 0) - (oldVal === 1 ? 1 : 0);
        const downDelta = (resolved === -1 ? 1 : 0) - (oldVal === -1 ? 1 : 0);

        if (target_type === 'post') {
          await tx.execute(
            'UPDATE posts SET upvote_count = GREATEST(0, upvote_count + $1), downvote_count = GREATEST(0, downvote_count + $2) WHERE id = $3',
            [upDelta, downDelta, target_id]
          );
        } else if (target_type === 'comment') {
          await tx.execute(
            'UPDATE comments SET upvote_count = GREATEST(0, upvote_count + $1), downvote_count = GREATEST(0, downvote_count + $2) WHERE id = $3',
            [upDelta, downDelta, target_id]
          );
        } else if (target_type === 'resource') {
          await tx.execute(
            'UPDATE resources SET upvote_count = GREATEST(0, upvote_count + $1) WHERE id = $2',
            [upDelta, target_id]
          );
        } else if (target_type === 'idea') {
          await tx.execute(
            'UPDATE ideas SET upvote_count = GREATEST(0, upvote_count + $1) WHERE id = $2',
            [upDelta, target_id]
          );
        }

        return resolved;
      });

      return res.json({ user_vote: newVal });
    } catch (err) {
      return next(err);
    }
  });

  // Bookmarks
  router.post('/bookmarks/toggle', requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
      const parsed = z
        .object({
          target_type: z.enum(['post', 'resource']),
          target_id: z.string().min(1),
        })
        .safeParse(req.body);
      if (!parsed.success || !isUuid(parsed.data.target_id)) {
        return res.status(400).json({ error: 'Invalid bookmark target.' });
      }

      const existing = await db.queryOne(
        'SELECT 1 FROM bookmarks WHERE user_id = $1 AND target_type = $2 AND target_id = $3',
        [req.user!.id, parsed.data.target_type, parsed.data.target_id]
      );

      if (existing) {
        await db.execute(
          'DELETE FROM bookmarks WHERE user_id = $1 AND target_type = $2 AND target_id = $3',
          [req.user!.id, parsed.data.target_type, parsed.data.target_id]
        );
        return res.json({ bookmarked: false });
      }
      await db.execute(
        'INSERT INTO bookmarks (user_id, target_type, target_id, created_at) VALUES ($1, $2, $3, NOW())',
        [req.user!.id, parsed.data.target_type, parsed.data.target_id]
      );
      return res.json({ bookmarked: true });
    } catch (err) {
      return next(err);
    }
  });

  router.get('/bookmarks', requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
      const [resources, posts] = await Promise.all([
        db.query(
          `SELECT r.id, r.title, sub.name AS subject_name, p.code AS program_code, rc.name AS category_name
           FROM bookmarks b
           JOIN resources r ON r.id = b.target_id
           JOIN subjects sub ON sub.id = r.subject_id
           JOIN programs p ON p.id = r.program_id
           JOIN resource_categories rc ON rc.id = r.category_id
           WHERE b.user_id = $1 AND b.target_type = 'resource' AND r.status = 'approved'
           ORDER BY b.created_at DESC`,
          [req.user!.id]
        ),
        db.query(
          `SELECT p.id, p.title, c.name AS community_name, c.slug AS community_slug
           FROM bookmarks b
           JOIN posts p ON p.id = b.target_id
           JOIN communities c ON c.id = p.community_id
           WHERE b.user_id = $1 AND b.target_type = 'post'
           ORDER BY b.created_at DESC`,
          [req.user!.id]
        ),
      ]);

      return res.json({ resources, posts });
    } catch (err) {
      return next(err);
    }
  });

  // Report content
  router.post('/reports', requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
      if (req.user!.role === 'visitor') {
        return res.status(403).json({ error: 'Sign in with a member account to submit reports.' });
      }
      const parsed = z
        .object({
          target_type: z.enum(['post', 'comment', 'resource', 'confession', 'user']),
          target_id: z.string().min(1),
          reason: z.string().min(3).max(120),
          details: z.string().max(600).default(''),
        })
        .safeParse(req.body);
      if (!parsed.success || !isUuid(parsed.data.target_id)) {
        return res.status(400).json({ error: 'Please provide a valid report target and reason.' });
      }

      const id = crypto.randomUUID();
      await db.transaction(async (tx) => {
        await tx.execute(
          "INSERT INTO reports (id, reporter_id, target_type, target_id, reason, details, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, 'open', NOW())",
          [
            id,
            req.user!.id,
            parsed.data.target_type,
            parsed.data.target_id,
            parsed.data.reason.trim(),
            parsed.data.details.trim(),
          ]
        );
        if (parsed.data.target_type === 'resource') {
          await tx.execute(
            "INSERT INTO resource_reports (id, resource_id, reporter_id, reason, details, status, created_at) VALUES ($1, $2, $3, $4, $5, 'open', NOW())",
            [crypto.randomUUID(), parsed.data.target_id, req.user!.id, parsed.data.reason.trim(), parsed.data.details.trim()]
          );
        }
      });

      return res.status(201).json({ id, message: 'Report submitted for moderator review.' });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}
