import crypto from 'node:crypto';
import { Router } from 'express';
import { type AuthenticatedRequest, requireAuth } from '../authMiddleware.ts';
import type { AppDatabase } from '../db.ts';
import { isAdminRole, isUuid } from '../security.ts';
import type { SearchResultItem } from '../../src/types/index.ts';

export function createSearchRouter(db: AppDatabase): Router {
  const router = Router();

  // Universal PostgreSQL FTS (to_tsvector/plainto_tsquery) + pg_trgm search with strict permission & privacy enforcement
  router.get('/search', async (req: AuthenticatedRequest, res, next) => {
    try {
      const q = String(req.query.q || '').trim();
      const typeFilter = String(req.query.type || 'all');
      const programId = String(req.query.program_id || '');
      const semesterId = String(req.query.semester_id || '');
      const subjectId = String(req.query.subject_id || '');
      const categoryId = String(req.query.category_id || '');
      const year = String(req.query.year || '');
      const sort = String(req.query.sort || 'relevance');
      const recordHistory = req.query.track === '1';

      if (!q || q.length < 2) {
        return res.json({ results: [], total: 0, query: q });
      }

      const likePattern = `%${q.toLowerCase()}%`;
      const viewer = req.user;
      const results: SearchResultItem[] = [];

      const shouldQuery = (kind: string) => typeFilter === 'all' || typeFilter === kind;

      // 1. Academic Programs
      if (shouldQuery('program')) {
        const progs = await db.query<Record<string, unknown>>(
          `SELECT id, code, name, description, created_at,
                  similarity(name, $1) AS trgm_score
           FROM programs
           WHERE is_archived = FALSE
             AND (lower(name) LIKE $2 OR lower(code) LIKE $2 OR lower(description) LIKE $2 OR similarity(name, $1) > 0.22)
           LIMIT 12`,
          [q, likePattern]
        );
        for (const p of progs) {
          if (isUuid(programId) && String(p.id) !== programId) continue;
          results.push({
            type: 'program',
            id: String(p.id),
            title: `${p.code} — ${p.name}`,
            snippet: String(p.description || ''),
            subtitle: 'Academic Program',
            link_path: `/academic?program=${p.id}`,
            score: 8 + Number(p.trgm_score || 0) * 10,
            meta: { code: String(p.code), created_at: String(p.created_at) },
          });
        }
      }

      // 2. Academic Semesters
      if (shouldQuery('semester')) {
        const sems = await db.query<Record<string, unknown>>(
          `SELECT sem.*, p.code AS p_code
           FROM semesters sem
           JOIN programs p ON p.id = sem.program_id
           WHERE sem.is_archived = FALSE AND p.is_archived = FALSE
             AND (lower(sem.name) LIKE $1 OR lower(p.code || ' ' || sem.name) LIKE $1)
           LIMIT 12`,
          [likePattern]
        );
        for (const sem of sems) {
          if (isUuid(programId) && String(sem.program_id) !== programId) continue;
          results.push({
            type: 'semester',
            id: String(sem.id),
            title: `${sem.p_code} · ${sem.name}`,
            snippet: `Semester ${sem.number} curriculum and uploaded PDFs`,
            subtitle: `${sem.p_code} · Academic Semester`,
            link_path: `/academic?program=${sem.program_id}&semester=${sem.id}`,
            score: 6,
            meta: { program_id: String(sem.program_id), created_at: String(sem.created_at) },
          });
        }
      }

      // 3. Academic Subjects (reflects Admin renames immediately)
      if (shouldQuery('subject')) {
        const subjs = await db.query<Record<string, unknown>>(
          `SELECT s.*, p.code AS p_code, p.name AS p_name, sem.name AS sem_name,
                  ts_rank(to_tsvector('simple', coalesce(s.code, '') || ' ' || coalesce(s.name, '') || ' ' || coalesce(s.description, '')), plainto_tsquery('simple', $1)) AS fts_rank,
                  similarity(s.name, $1) AS trgm_score
           FROM subjects s
           JOIN programs p ON p.id = s.program_id
           JOIN semesters sem ON sem.id = s.semester_id
           WHERE s.is_archived = FALSE AND p.is_archived = FALSE
             AND (
               to_tsvector('simple', coalesce(s.code, '') || ' ' || coalesce(s.name, '') || ' ' || coalesce(s.description, '')) @@ plainto_tsquery('simple', $1)
               OR lower(s.name) LIKE $2 OR lower(s.description) LIKE $2 OR lower(s.code) LIKE $2 OR lower(p.code || ' ' || s.name) LIKE $2
               OR similarity(s.name, $1) > 0.2
             )
           LIMIT 30`,
          [q, likePattern]
        );

        for (const s of subjs) {
          if (isUuid(programId) && String(s.program_id) !== programId) continue;
          if (isUuid(semesterId) && String(s.semester_id) !== semesterId) continue;
          results.push({
            type: 'subject',
            id: String(s.id),
            title: String(s.name),
            snippet: String(s.description || ''),
            subtitle: `${s.p_code} · ${s.sem_name} · ${s.code || 'Subject'}`,
            link_path: `/academic?program=${s.program_id}&semester=${s.semester_id}&subject=${s.id}`,
            score:
              6 +
              Number(s.fts_rank || 0) * 10 +
              Number(s.trgm_score || 0) * 10 +
              (String(s.name).toLowerCase().includes(q.toLowerCase()) ? 8 : 0),
            meta: { program_id: String(s.program_id), semester_id: String(s.semester_id), created_at: String(s.created_at) },
          });
        }
      }

      // 4. Academic Folders
      if (shouldQuery('folder')) {
        const folders = await db.query<Record<string, unknown>>(
          `SELECT f.*, sub.name AS subject_name, sub.program_id, sub.semester_id, p.code AS p_code
           FROM academic_folders f
           JOIN subjects sub ON sub.id = f.subject_id
           JOIN programs p ON p.id = sub.program_id
           WHERE f.is_archived = FALSE AND sub.is_archived = FALSE
             AND (lower(f.name) LIKE $1 OR similarity(f.name, $2) > 0.25)
           LIMIT 20`,
          [likePattern, q]
        );
        for (const f of folders) {
          if (isUuid(programId) && String(f.program_id) !== programId) continue;
          if (isUuid(semesterId) && String(f.semester_id) !== semesterId) continue;
          results.push({
            type: 'folder',
            id: String(f.id),
            title: String(f.name),
            snippet: `Topic folder inside ${f.subject_name}`,
            subtitle: `${f.p_code} · ${f.subject_name} · Topic Folder`,
            link_path: `/academic?program=${f.program_id}&semester=${f.semester_id}&subject=${f.subject_id}`,
            score: 5,
            meta: { created_at: String(f.created_at) },
          });
        }
      }

      // 5. Approved Academic Resources (NEVER leaks pending or rejected resources!)
      if (shouldQuery('resource')) {
        const resRows = await db.query<Record<string, unknown>>(
          `SELECT r.*, rc.name AS cat_name, p.code AS p_code, sem.name AS sem_name, sub.name AS sub_name,
                  ts_rank(to_tsvector('simple', coalesce(r.title, '') || ' ' || coalesce(r.description, '') || ' ' || coalesce(r.academic_year, '')), plainto_tsquery('simple', $1)) AS fts_rank,
                  similarity(r.title, $1) AS trgm_score
           FROM resources r
           JOIN resource_categories rc ON rc.id = r.category_id
           JOIN programs p ON p.id = r.program_id
           JOIN semesters sem ON sem.id = r.semester_id
           JOIN subjects sub ON sub.id = r.subject_id
           WHERE r.status = 'approved'
             AND (
               to_tsvector('simple', coalesce(r.title, '') || ' ' || coalesce(r.description, '') || ' ' || coalesce(r.academic_year, '')) @@ plainto_tsquery('simple', $1)
               OR lower(r.title) LIKE $2 OR lower(r.description) LIKE $2 OR lower(sub.name) LIKE $2 OR lower(rc.name) LIKE $2
               OR similarity(r.title, $1) > 0.2
             )
           LIMIT 40`,
          [q, likePattern]
        );

        for (const r of resRows) {
          if (isUuid(programId) && String(r.program_id) !== programId) continue;
          if (isUuid(semesterId) && String(r.semester_id) !== semesterId) continue;
          if (isUuid(subjectId) && String(r.subject_id) !== subjectId) continue;
          if (isUuid(categoryId) && String(r.category_id) !== categoryId) continue;
          if (year && String(r.academic_year) !== year) continue;
          results.push({
            type: 'resource',
            id: String(r.id),
            title: String(r.title),
            snippet: String(r.description || ''),
            subtitle: `${r.p_code} · ${r.sem_name} · ${r.sub_name} · ${r.cat_name}`,
            link_path: `/academic?program=${r.program_id}&semester=${r.semester_id}&subject=${r.subject_id}&resource=${r.id}`,
            score:
              5 +
              Number(r.fts_rank || 0) * 10 +
              Number(r.trgm_score || 0) * 8 +
              (sort === 'popular' ? Number(r.download_count || 0) + Number(r.upvote_count || 0) : 0),
            meta: {
              downloads: Number(r.download_count || 0),
              upvotes: Number(r.upvote_count || 0),
              year: String(r.academic_year),
              created_at: new Date(String(r.created_at)).toISOString(),
            },
          });
        }
      }

      // 6. Communities (Respecting visibility)
      if (shouldQuery('community')) {
        const comms = await db.query<Record<string, unknown>>(
          `SELECT *,
                  ts_rank(to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(description, '')), plainto_tsquery('simple', $1)) AS fts_rank,
                  similarity(name, $1) AS trgm_score
           FROM communities
           WHERE is_archived = FALSE
             AND (
               to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(description, '')) @@ plainto_tsquery('simple', $1)
               OR lower(name) LIKE $2 OR lower(description) LIKE $2 OR similarity(name, $1) > 0.2
             )
           LIMIT 20`,
          [q, likePattern]
        );

        for (const c of comms) {
          if (String(c.visibility) === 'private_approval') {
            if (!viewer) continue;
            if (!isAdminRole(viewer.role)) {
              const mem = await db.queryOne(
                "SELECT 1 FROM community_members WHERE community_id = $1 AND user_id = $2 AND status = 'joined'",
                [String(c.id), viewer.id]
              );
              if (!mem) continue;
            }
          }
          results.push({
            type: 'community',
            id: String(c.id),
            title: String(c.name),
            snippet: String(c.description),
            subtitle: `${c.kind === 'academic' ? 'Academic Community' : 'Community'} · ${String(c.visibility).replace('_', ' ')}`,
            link_path: `/communities/${c.slug}`,
            score: 6 + Number(c.fts_rank || 0) * 8 + Number(c.trgm_score || 0) * 8,
            meta: { slug: String(c.slug), created_at: new Date(String(c.created_at)).toISOString() },
          });
        }
      }

      // 7. Posts (Respecting community visibility & blocks)
      if (shouldQuery('post')) {
        const postRows = await db.query<Record<string, unknown>>(
          `SELECT p.*, c.name AS comm_name, c.slug AS comm_slug, c.visibility AS comm_vis, u.display_name AS author_name,
                  ts_rank(to_tsvector('simple', coalesce(p.title, '') || ' ' || coalesce(p.body, '') || ' ' || coalesce(p.flair, '')), plainto_tsquery('simple', $1)) AS fts_rank,
                  similarity(p.title, $1) AS trgm_score
           FROM posts p
           JOIN communities c ON c.id = p.community_id
           JOIN profiles u ON u.id = p.author_id
           WHERE p.is_hidden = FALSE AND c.is_archived = FALSE
             AND (
               to_tsvector('simple', coalesce(p.title, '') || ' ' || coalesce(p.body, '') || ' ' || coalesce(p.flair, '')) @@ plainto_tsquery('simple', $1)
               OR lower(p.title) LIKE $2 OR lower(p.body) LIKE $2 OR array_to_string(p.tags, ' ') ILIKE $2
               OR similarity(p.title, $1) > 0.2
             )
           LIMIT 40`,
          [q, likePattern]
        );

        for (const p of postRows) {
          if (isUuid(programId) && String(p.program_id || '') !== programId) continue;
          if (String(p.comm_vis) === 'university_only' && (!viewer || (!viewer.university_email_verified && !isAdminRole(viewer.role)))) continue;
          if (String(p.comm_vis) === 'private_approval') continue;
          results.push({
            type: 'post',
            id: String(p.id),
            title: String(p.title) || 'Image Post',
            snippet: String(p.body).slice(0, 160),
            subtitle: `${p.comm_name} · Posted by ${p.author_name}`,
            link_path: `/communities/${p.comm_slug}?post=${p.id}`,
            score:
              5 +
              Number(p.fts_rank || 0) * 10 +
              Number(p.trgm_score || 0) * 6 +
              (sort === 'popular' ? Number(p.upvote_count || 0) * 2 : 0),
            meta: {
              upvotes: Number(p.upvote_count || 0),
              comments: Number(p.comment_count || 0),
              created_at: new Date(String(p.created_at)).toISOString(),
            },
          });
        }
      }

      // 8. Comments (Respecting community visibility)
      if (shouldQuery('comment')) {
        const cmtRows = await db.query<Record<string, unknown>>(
          `SELECT cm.id, cm.post_id, cm.body, cm.created_at, p.title AS post_title, c.name AS comm_name, c.slug AS comm_slug, c.visibility AS comm_vis, u.display_name AS author_name
           FROM comments cm
           JOIN posts p ON p.id = cm.post_id
           JOIN communities c ON c.id = p.community_id
           JOIN profiles u ON u.id = cm.author_id
           WHERE cm.is_hidden = FALSE AND p.is_hidden = FALSE AND c.is_archived = FALSE
             AND (
               to_tsvector('simple', coalesce(cm.body, '')) @@ plainto_tsquery('simple', $1)
               OR lower(cm.body) LIKE $2
             )
           LIMIT 25`,
          [q, likePattern]
        );
        for (const cm of cmtRows) {
          if (String(cm.comm_vis) === 'university_only' && (!viewer || (!viewer.university_email_verified && !isAdminRole(viewer.role)))) continue;
          if (String(cm.comm_vis) === 'private_approval') continue;
          results.push({
            type: 'comment',
            id: String(cm.id),
            title: `Comment on "${String(cm.post_title || 'Post')}"`,
            snippet: String(cm.body).slice(0, 160),
            subtitle: `${cm.comm_name} · Reply by ${cm.author_name}`,
            link_path: `/communities/${cm.comm_slug}?post=${cm.post_id}`,
            score: 4,
            meta: { created_at: new Date(String(cm.created_at)).toISOString() },
          });
        }
      }

      // 9. Tags
      if (shouldQuery('tag')) {
        const tagRows = await db.query<Record<string, unknown>>(
          `SELECT t.id, t.name, t.slug, COUNT(pt.post_id) AS post_count
           FROM tags t
           LEFT JOIN post_tags pt ON pt.tag_id = t.id
           WHERE lower(t.name) LIKE $1 OR similarity(t.name, $2) > 0.25
           GROUP BY t.id
           LIMIT 12`,
          [likePattern, q]
        );
        for (const t of tagRows) {
          results.push({
            type: 'tag',
            id: String(t.id),
            title: `#${t.name}`,
            snippet: `${Number(t.post_count || 0)} tagged discussions`,
            subtitle: 'Discussion Tag',
            link_path: '/communities',
            score: 4,
            meta: { slug: String(t.slug) },
          });
        }
      }

      // 10. Public Profiles (never exposes private email or admin accounts!)
      if (shouldQuery('user')) {
        const userRows = await db.query<Record<string, unknown>>(
          `SELECT id, username, display_name, bio, role, university_email_verified, created_at,
                  similarity(display_name, $1) AS trgm_score
           FROM profiles
           WHERE account_status = 'active'
             AND role NOT IN ('admin', 'super_admin')
             AND (lower(display_name) LIKE $2 OR lower(username) LIKE $2 OR lower(bio) LIKE $2 OR similarity(display_name, $1) > 0.22)
           LIMIT 25`,
          [q, likePattern]
        );

        for (const u of userRows) {
          results.push({
            type: 'user',
            id: String(u.id),
            title: String(u.display_name),
            snippet: String(u.bio || ''),
            subtitle: `@${u.username} · ${String(u.role).replace('_', ' ')}`,
            link_path: `/profile/${u.username}`,
            score: 3 + Number(u.trgm_score || 0) * 8,
            meta: {
              username: String(u.username),
              verified: Boolean(u.university_email_verified),
              created_at: new Date(String(u.created_at)).toISOString(),
            },
          });
        }
      }

      // 11. Opportunities, Events, Study Groups, Ideas, Approved Confessions, Public Complaints ONLY
      if (shouldQuery('opportunity')) {
        const opps = await db.query<Record<string, unknown>>(
          `SELECT * FROM opportunities
           WHERE status = 'approved'
             AND (
               to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(organization, '') || ' ' || coalesce(description, '')) @@ plainto_tsquery('simple', $1)
               OR lower(title) LIKE $2 OR lower(organization) LIKE $2 OR lower(description) LIKE $2
             )
           LIMIT 20`,
          [q, likePattern]
        );
        for (const o of opps) {
          results.push({
            type: 'opportunity',
            id: String(o.id),
            title: String(o.title) || 'Opportunity',
            snippet: String(o.description).slice(0, 140),
            subtitle: `${o.kind} · ${o.organization} · Deadline ${o.deadline}`,
            link_path: '/opportunities',
            score: 5,
            meta: { kind: String(o.kind), deadline: String(o.deadline), created_at: new Date(String(o.created_at)).toISOString() },
          });
        }
      }

      if (shouldQuery('event')) {
        const evs = await db.query<Record<string, unknown>>(
          `SELECT * FROM events
           WHERE to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(location, '') || ' ' || coalesce(description, '')) @@ plainto_tsquery('simple', $1)
              OR lower(title) LIKE $2 OR lower(description) LIKE $2 OR lower(location) LIKE $2
           LIMIT 20`,
          [q, likePattern]
        );
        for (const e of evs) {
          results.push({
            type: 'event',
            id: String(e.id),
            title: String(e.title) || 'Campus Event',
            snippet: String(e.description).slice(0, 140),
            subtitle: `${e.kind} · ${e.location}`,
            link_path: '/events',
            score: 5,
            meta: { starts_at: String(e.starts_at), created_at: new Date(String(e.created_at)).toISOString() },
          });
        }
      }

      if (shouldQuery('study_group')) {
        const sgs = await db.query<Record<string, unknown>>(
          `SELECT * FROM study_groups
           WHERE to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(description, '')) @@ plainto_tsquery('simple', $1)
              OR lower(name) LIKE $2 OR lower(description) LIKE $2
           LIMIT 20`,
          [q, likePattern]
        );
        for (const sg of sgs) {
          results.push({
            type: 'study_group',
            id: String(sg.id),
            title: String(sg.name),
            snippet: String(sg.description).slice(0, 140),
            subtitle: `Study Group · ${sg.schedule_text}`,
            link_path: '/study-groups',
            score: 4,
            meta: { members: Number(sg.member_count || 0), created_at: new Date(String(sg.created_at)).toISOString() },
          });
        }
      }

      if (shouldQuery('idea')) {
        const ideas = await db.query<Record<string, unknown>>(
          `SELECT * FROM ideas
           WHERE to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(problem_statement, '') || ' ' || coalesce(proposed_solution, '')) @@ plainto_tsquery('simple', $1)
              OR lower(title) LIKE $2 OR lower(problem_statement) LIKE $2 OR lower(proposed_solution) LIKE $2
           LIMIT 20`,
          [q, likePattern]
        );
        for (const i of ideas) {
          results.push({
            type: 'idea',
            id: String(i.id),
            title: String(i.title) || 'Campus Idea',
            snippet: String(i.problem_statement).slice(0, 140),
            subtitle: `GetIdeas · ${String(i.status).replace(/_/g, ' ')}`,
            link_path: '/ideas',
            score: 4,
            meta: { upvotes: Number(i.upvote_count || 0), created_at: new Date(String(i.created_at)).toISOString() },
          });
        }
      }

      if (shouldQuery('confession')) {
        const confs = await db.query<Record<string, unknown>>(
          `SELECT id, title, body, category, created_at FROM confessions
           WHERE status = 'approved'
             AND (
               to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(body, '')) @@ plainto_tsquery('simple', $1)
               OR lower(title) LIKE $2 OR lower(body) LIKE $2
             )
           LIMIT 20`,
          [q, likePattern]
        );
        for (const c of confs) {
          results.push({
            type: 'confession',
            id: String(c.id),
            title: String(c.title) || 'Campus Confession',
            snippet: String(c.body).slice(0, 140),
            subtitle: `Confessions · ${c.category}`,
            link_path: '/confessions',
            score: 3,
            meta: { category: String(c.category), created_at: new Date(String(c.created_at)).toISOString() },
          });
        }
      }

      // Public complaints ONLY — NEVER expose is_private = TRUE complaints in search!
      if (shouldQuery('complaint')) {
        const comps = await db.query<Record<string, unknown>>(
          `SELECT id, title, body, category, status, created_at FROM complaints
           WHERE is_private = FALSE
             AND (
               to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(body, '') || ' ' || coalesce(category, '')) @@ plainto_tsquery('simple', $1)
               OR lower(title) LIKE $2 OR lower(body) LIKE $2 OR lower(category) LIKE $2
             )
           LIMIT 20`,
          [q, likePattern]
        );
        for (const cm of comps) {
          results.push({
            type: 'complaint',
            id: String(cm.id),
            title: String(cm.title) || 'Public Feedback',
            snippet: String(cm.body).slice(0, 140),
            subtitle: `Public Feedback · ${cm.category} · ${String(cm.status).replace(/_/g, ' ')}`,
            link_path: '/complaints',
            score: 3,
            meta: { status: String(cm.status), created_at: new Date(String(cm.created_at)).toISOString() },
          });
        }
      }

      if (sort === 'newest') {
        results.sort((a, b) => String(b.meta.created_at || '').localeCompare(String(a.meta.created_at || '')));
      } else {
        results.sort((a, b) => b.score - a.score);
      }

      if (recordHistory) {
        await db.execute(
          'INSERT INTO search_events (id, query_normalized, display_query, user_id, result_count, cleared_by_user, created_at) VALUES ($1, $2, $3, $4, $5, FALSE, NOW())',
          [crypto.randomUUID(), q.toLowerCase(), q, viewer?.id ?? null, results.length]
        );
      }

      return res.json({ results: results.slice(0, 60), total: results.length, query: q });
    } catch (err) {
      return next(err);
    }
  });

  // Live Autocomplete Suggestions
  router.get('/search/suggestions', async (req, res, next) => {
    try {
      const q = String(req.query.q || '').trim().toLowerCase();
      if (!q || q.length < 2) return res.json({ suggestions: [] });
      const like = `%${q}%`;

      const [subjects, resources, communities, posts, users] = await Promise.all([
        db.query<Record<string, unknown>>(
          `SELECT s.id, s.name, p.code AS p_code, sem.name AS sem_name, s.program_id, s.semester_id
           FROM subjects s JOIN programs p ON p.id = s.program_id JOIN semesters sem ON sem.id = s.semester_id
           WHERE s.is_archived = FALSE AND (lower(s.name) LIKE $1 OR similarity(s.name, $2) > 0.25)
           LIMIT 4`,
          [like, q]
        ),
        db.query<Record<string, unknown>>(
          `SELECT r.id, r.title, rc.name AS cat_name, r.program_id, r.semester_id, r.subject_id
           FROM resources r JOIN resource_categories rc ON rc.id = r.category_id
           WHERE r.status = 'approved' AND lower(r.title) LIKE $1 LIMIT 4`,
          [like]
        ),
        db.query<Record<string, unknown>>(
          "SELECT id, name, slug FROM communities WHERE is_archived = FALSE AND visibility <> 'private_approval' AND lower(name) LIKE $1 LIMIT 3",
          [like]
        ),
        db.query<Record<string, unknown>>(
          "SELECT p.id, p.title, c.slug AS comm_slug FROM posts p JOIN communities c ON c.id = p.community_id WHERE p.is_hidden = FALSE AND c.visibility = 'public' AND lower(p.title) LIKE $1 LIMIT 3",
          [like]
        ),
        db.query<Record<string, unknown>>(
          "SELECT id, username, display_name FROM profiles WHERE account_status = 'active' AND role NOT IN ('admin', 'super_admin') AND (lower(display_name) LIKE $1 OR lower(username) LIKE $1) LIMIT 3",
          [like]
        ),
      ]);

      const suggestions = [
        ...subjects.map((s) => ({
          group: 'Subjects',
          label: String(s.name),
          sublabel: `${s.p_code} · ${s.sem_name}`,
          link_path: `/academic?program=${s.program_id}&semester=${s.semester_id}&subject=${s.id}`,
        })),
        ...resources.map((r) => ({
          group: 'Documents',
          label: String(r.title),
          sublabel: String(r.cat_name),
          link_path: `/academic?program=${r.program_id}&semester=${r.semester_id}&subject=${r.subject_id}&resource=${r.id}`,
        })),
        ...communities.map((c) => ({
          group: 'Communities',
          label: String(c.name),
          sublabel: 'Community',
          link_path: `/communities/${c.slug}`,
        })),
        ...posts.map((p) => ({
          group: 'Discussions',
          label: String(p.title),
          sublabel: 'Discussion',
          link_path: `/communities/${p.comm_slug}?post=${p.id}`,
        })),
        ...users.map((u) => ({
          group: 'People',
          label: String(u.display_name),
          sublabel: `@${u.username}`,
          link_path: `/profile/${u.username}`,
        })),
      ];

      return res.json({ suggestions });
    } catch (err) {
      return next(err);
    }
  });

  // Personal Search History (never shared across users)
  router.get('/search/history', requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
      const rows = await db.query(
        `SELECT MAX(display_query) AS query, MAX(created_at) AS last_searched
         FROM search_events
         WHERE user_id = $1 AND cleared_by_user = FALSE
         GROUP BY query_normalized
         ORDER BY MAX(created_at) DESC
         LIMIT 8`,
        [req.user!.id]
      );
      return res.json({ history: rows });
    } catch (err) {
      return next(err);
    }
  });

  router.delete('/search/history', requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
      await db.execute('UPDATE search_events SET cleared_by_user = TRUE WHERE user_id = $1', [req.user!.id]);
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });

  // Genuine Database-Computed Trending Engine
  router.get('/trending', async (req, res, next) => {
    try {
      const intervalStr = req.query.window === 'week' ? '7 days' : '1 day';

      const [trendingSearches, trendingCommunities, popularResources, trendingDiscussions, upcomingEvents] =
        await Promise.all([
          db.query<{ query: string; count: string | number; recent_count: string | number; prior_count: string | number }>(
            `SELECT MAX(display_query) AS query,
                    COUNT(*) AS count,
                    SUM(CASE WHEN created_at >= NOW() - $1::interval THEN 1 ELSE 0 END) AS recent_count,
                    SUM(CASE WHEN created_at < NOW() - $1::interval THEN 1 ELSE 0 END) AS prior_count
             FROM search_events
             WHERE created_at >= NOW() - INTERVAL '14 days'
             GROUP BY query_normalized
             HAVING SUM(CASE WHEN created_at >= NOW() - $1::interval THEN 1 ELSE 0 END) > 0
             ORDER BY recent_count DESC, count DESC
             LIMIT 8`,
            [intervalStr]
          ),
          db.query(
            `SELECT c.id, c.slug, c.name, c.description, c.kind, c.visibility,
              (SELECT COUNT(*) FROM community_members cm WHERE cm.community_id = c.id AND cm.status = 'joined') AS member_count,
              (SELECT COUNT(*) FROM posts p WHERE p.community_id = c.id AND p.is_hidden = FALSE AND p.created_at >= NOW() - $1::interval) AS recent_posts,
              (SELECT COALESCE(SUM(p.upvote_count + p.comment_count), 0) FROM posts p WHERE p.community_id = c.id AND p.is_hidden = FALSE) AS engagement_score
             FROM communities c
             WHERE c.is_archived = FALSE AND c.visibility <> 'private_approval'
             ORDER BY recent_posts DESC, engagement_score DESC, member_count DESC
             LIMIT 6`,
            [intervalStr]
          ),
          db.query(
            `SELECT r.id, r.title, r.download_count, r.upvote_count, r.program_id, r.semester_id, r.subject_id,
                    p.code AS program_code, sub.name AS subject_name, rc.name AS category_name
             FROM resources r
             JOIN programs p ON p.id = r.program_id
             JOIN subjects sub ON sub.id = r.subject_id
             JOIN resource_categories rc ON rc.id = r.category_id
             WHERE r.status = 'approved'
             ORDER BY (r.download_count * 2 + r.upvote_count) DESC
             LIMIT 6`
          ),
          db.query(
            `SELECT p.id, p.title, p.upvote_count, p.comment_count, p.created_at, c.name AS community_name, c.slug AS community_slug
             FROM posts p
             JOIN communities c ON c.id = p.community_id
             WHERE p.is_hidden = FALSE AND c.visibility = 'public'
             ORDER BY (p.upvote_count * 2 + p.comment_count * 3) DESC, p.created_at DESC
             LIMIT 5`
          ),
          db.query(
            "SELECT id, title, kind, location, starts_at FROM events WHERE created_at >= NOW() - INTERVAL '90 days' ORDER BY starts_at ASC LIMIT 4"
          ),
        ]);

      const formattedSearches = trendingSearches.map((s) => {
        const recent = Number(s.recent_count || 0);
        const prior = Number(s.prior_count || 0);
        return {
          query: s.query,
          count: recent,
          growth_pct: prior > 0 ? Math.round(((recent - prior) / prior) * 100) : 100,
        };
      });

      return res.json({
        trending_searches: formattedSearches,
        trending_communities: trendingCommunities,
        popular_resources: popularResources,
        trending_discussions: trendingDiscussions,
        upcoming_events: upcomingEvents,
      });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}
