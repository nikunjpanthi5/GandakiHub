import crypto from 'node:crypto';
import { Router } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { type AuthenticatedRequest, requireAuth } from '../authMiddleware.ts';
import type { SearchResultItem } from '../../src/types/index.ts';

function sanitizeFtsQuery(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/["'*(){}[\]:^~+-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 1)
    .slice(0, 8);
  if (cleaned.length === 0) return '';
  return cleaned.map((w) => `"${w}"*`).join(' OR ');
}

export function createSearchRouter(db: DatabaseSync): Router {
  const router = Router();

  // Universal permission-aware search across all academic & community content
  router.get('/search', (req: AuthenticatedRequest, res) => {
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

    const ftsQuery = sanitizeFtsQuery(q);
    const likePattern = `%${q.toLowerCase()}%`;
    const viewer = req.user;
    const results: SearchResultItem[] = [];

    // Helper: check FTS match or fallback LIKE match
    const ftsScores = new Map<string, number>();
    if (ftsQuery) {
      try {
        const ftsRows = db
          .prepare('SELECT entity_type, entity_id, bm25(search_index, 4.0, 2.0, 1.0) as rank FROM search_index WHERE search_index MATCH ? LIMIT 200')
          .all(ftsQuery) as Array<{ entity_type: string; entity_id: string; rank: number }>;
        for (const r of ftsRows) {
          ftsScores.set(`${r.entity_type}:${r.entity_id}`, Math.abs(Number(r.rank)) + 10);
        }
      } catch {
        // Fallback to LIKE queries if query syntax is unusual
      }
    }

    // 1. Academic Subjects
    if (typeFilter === 'all' || typeFilter === 'subject') {
      const subjs = db
        .prepare(
          `SELECT s.*, p.code as p_code, p.name as p_name, sem.name as sem_name
           FROM subjects s
           JOIN programs p ON p.id = s.program_id
           JOIN semesters sem ON sem.id = s.semester_id
           WHERE s.is_archived = 0 AND p.is_archived = 0
             AND (lower(s.name) LIKE ? OR lower(s.description) LIKE ? OR lower(s.code) LIKE ? OR lower(p.code || ' ' || s.name) LIKE ?)`
        )
        .all(likePattern, likePattern, likePattern, likePattern) as Record<string, unknown>[];

      for (const s of subjs) {
        if (programId && String(s.program_id) !== programId) continue;
        if (semesterId && String(s.semester_id) !== semesterId) continue;
        results.push({
          type: 'subject',
          id: String(s.id),
          title: String(s.name),
          snippet: String(s.description || ''),
          subtitle: `${s.p_code} · ${s.sem_name} · ${s.code || 'Subject'}`,
          link_path: `/academic?program=${s.program_id}&semester=${s.semester_id}&subject=${s.id}`,
          score: (ftsScores.get(`subject:${s.id}`) || 5) + (String(s.name).toLowerCase().includes(q.toLowerCase()) ? 8 : 0),
          meta: { program_id: String(s.program_id), semester_id: String(s.semester_id) },
        });
      }
    }

    // 2. Approved Academic Resources (NEVER leaks pending or rejected resources!)
    if (typeFilter === 'all' || typeFilter === 'resource') {
      const resRows = db
        .prepare(
          `SELECT r.*, rc.name as cat_name, p.code as p_code, sem.name as sem_name, sub.name as sub_name, u.display_name as uploader_name
           FROM resources r
           JOIN resource_categories rc ON rc.id = r.category_id
           JOIN programs p ON p.id = r.program_id
           JOIN semesters sem ON sem.id = r.semester_id
           JOIN subjects sub ON sub.id = r.subject_id
           JOIN users u ON u.id = r.uploader_id
           WHERE r.status = 'approved'
             AND (lower(r.title) LIKE ? OR lower(r.description) LIKE ? OR lower(sub.name) LIKE ? OR lower(rc.name) LIKE ?)`
        )
        .all(likePattern, likePattern, likePattern, likePattern) as Record<string, unknown>[];

      for (const r of resRows) {
        if (programId && String(r.program_id) !== programId) continue;
        if (semesterId && String(r.semester_id) !== semesterId) continue;
        if (subjectId && String(r.subject_id) !== subjectId) continue;
        if (categoryId && String(r.category_id) !== categoryId) continue;
        if (year && String(r.academic_year) !== year) continue;
        results.push({
          type: 'resource',
          id: String(r.id),
          title: String(r.title),
          snippet: String(r.description || ''),
          subtitle: `${r.p_code} · ${r.sem_name} · ${r.sub_name} · ${r.cat_name}`,
          link_path: `/academic?program=${r.program_id}&semester=${r.semester_id}&subject=${r.subject_id}&resource=${r.id}`,
          score:
            (ftsScores.get(`resource:${r.id}`) || 4) +
            (sort === 'popular' ? Number(r.download_count) + Number(r.upvote_count) : 0),
          meta: { downloads: Number(r.download_count), upvotes: Number(r.upvote_count), year: String(r.academic_year), created_at: String(r.created_at) },
        });
      }
    }

    // 3. Communities (Respecting visibility)
    if (typeFilter === 'all' || typeFilter === 'community') {
      const comms = db
        .prepare('SELECT * FROM communities WHERE is_archived = 0 AND (lower(name) LIKE ? OR lower(description) LIKE ?)')
        .all(likePattern, likePattern) as Record<string, unknown>[];

      for (const c of comms) {
        if (String(c.visibility) === 'private_approval') {
          if (!viewer) continue;
          const mem = db
            .prepare("SELECT 1 FROM community_members WHERE community_id = ? AND user_id = ? AND status = 'joined'")
            .get(String(c.id), viewer.id);
          if (!mem) continue;
        }
        results.push({
          type: 'community',
          id: String(c.id),
          title: String(c.name),
          snippet: String(c.description),
          subtitle: `${c.kind === 'academic' ? 'Academic Community' : 'Community'} · ${String(c.visibility).replace('_', ' ')}`,
          link_path: `/communities/${c.slug}`,
          score: ftsScores.get(`community:${c.id}`) || 6,
          meta: { slug: String(c.slug) },
        });
      }
    }

    // 4. Posts (Respecting community visibility & blocks)
    if (typeFilter === 'all' || typeFilter === 'post') {
      const postRows = db
        .prepare(
          `SELECT p.*, c.name as comm_name, c.slug as comm_slug, c.visibility as comm_vis, u.display_name as author_name
           FROM posts p
           JOIN communities c ON c.id = p.community_id
           JOIN users u ON u.id = p.author_id
           WHERE p.is_hidden = 0 AND c.is_archived = 0
             AND (lower(p.title) LIKE ? OR lower(p.body) LIKE ? OR lower(p.tags_json) LIKE ?)`
        )
        .all(likePattern, likePattern, likePattern) as Record<string, unknown>[];

      for (const p of postRows) {
        if (programId && String(p.program_id || '') !== programId) continue;
        if (String(p.comm_vis) === 'university_only' && (!viewer || !viewer.university_email_verified)) continue;
        if (String(p.comm_vis) === 'private_approval') continue;
        results.push({
          type: 'post',
          id: String(p.id),
          title: String(p.title),
          snippet: String(p.body).slice(0, 160),
          subtitle: `${p.comm_name} · Posted by ${p.author_name}`,
          link_path: `/communities/${p.comm_slug}?post=${p.id}`,
          score: (ftsScores.get(`post:${p.id}`) || 4) + (sort === 'popular' ? Number(p.upvote_count) * 2 : 0),
          meta: { upvotes: Number(p.upvote_count), comments: Number(p.comment_count), created_at: String(p.created_at) },
        });
      }
    }

    // 5. Public Profiles (never exposes private email!)
    if (typeFilter === 'all' || typeFilter === 'user') {
      const userRows = db
        .prepare(
          `SELECT id, username, display_name, bio, role, university_email_verified
           FROM users
           WHERE account_status = 'active'
             AND role NOT IN ('admin', 'super_admin')
             AND (lower(display_name) LIKE ? OR lower(username) LIKE ? OR lower(bio) LIKE ?)`
        )
        .all(likePattern, likePattern, likePattern) as Record<string, unknown>[];

      for (const u of userRows) {
        results.push({
          type: 'user',
          id: String(u.id),
          title: String(u.display_name),
          snippet: String(u.bio || ''),
          subtitle: `@${u.username} · ${String(u.role).replace('_', ' ')}`,
          link_path: `/profile/${u.username}`,
          score: ftsScores.get(`user:${u.id}`) || 3,
          meta: { username: String(u.username), verified: Boolean(u.university_email_verified) },
        });
      }
    }

    // 6. Opportunities, Events, Study Groups, Ideas, Approved Public Confessions, Public Complaints ONLY
    if (typeFilter === 'all' || typeFilter === 'opportunity') {
      const opps = db
        .prepare("SELECT * FROM opportunities WHERE status = 'approved' AND (lower(title) LIKE ? OR lower(organization) LIKE ? OR lower(description) LIKE ?)")
        .all(likePattern, likePattern, likePattern) as Record<string, unknown>[];
      for (const o of opps) {
        results.push({
          type: 'opportunity',
          id: String(o.id),
          title: String(o.title),
          snippet: String(o.description).slice(0, 140),
          subtitle: `${o.kind} · ${o.organization} · Deadline ${o.deadline}`,
          link_path: '/opportunities',
          score: 5,
          meta: { kind: String(o.kind), deadline: String(o.deadline) },
        });
      }
    }

    if (typeFilter === 'all' || typeFilter === 'event') {
      const evs = db
        .prepare('SELECT * FROM events WHERE lower(title) LIKE ? OR lower(description) LIKE ? OR lower(location) LIKE ?')
        .all(likePattern, likePattern, likePattern) as Record<string, unknown>[];
      for (const e of evs) {
        results.push({
          type: 'event',
          id: String(e.id),
          title: String(e.title),
          snippet: String(e.description).slice(0, 140),
          subtitle: `${e.kind} · ${e.location}`,
          link_path: '/events',
          score: 5,
          meta: { starts_at: String(e.starts_at) },
        });
      }
    }

    if (typeFilter === 'all' || typeFilter === 'study_group') {
      const sgs = db
        .prepare('SELECT * FROM study_groups WHERE lower(name) LIKE ? OR lower(description) LIKE ?')
        .all(likePattern, likePattern) as Record<string, unknown>[];
      for (const sg of sgs) {
        results.push({
          type: 'study_group',
          id: String(sg.id),
          title: String(sg.name),
          snippet: String(sg.description).slice(0, 140),
          subtitle: `Study Group · ${sg.schedule_text}`,
          link_path: '/study-groups',
          score: 4,
          meta: { members: Number(sg.member_count) },
        });
      }
    }

    if (typeFilter === 'all' || typeFilter === 'idea') {
      const ideas = db
        .prepare('SELECT * FROM ideas WHERE lower(title) LIKE ? OR lower(problem_statement) LIKE ? OR lower(proposed_solution) LIKE ?')
        .all(likePattern, likePattern, likePattern) as Record<string, unknown>[];
      for (const i of ideas) {
        results.push({
          type: 'idea',
          id: String(i.id),
          title: String(i.title),
          snippet: String(i.problem_statement).slice(0, 140),
          subtitle: `GetIdeas · ${String(i.status).replace(/_/g, ' ')}`,
          link_path: '/ideas',
          score: 4,
          meta: { upvotes: Number(i.upvote_count) },
        });
      }
    }

    if (typeFilter === 'all' || typeFilter === 'confession') {
      const confs = db
        .prepare("SELECT id, title, body, category, created_at FROM confessions WHERE status = 'approved' AND (lower(title) LIKE ? OR lower(body) LIKE ?)")
        .all(likePattern, likePattern) as Record<string, unknown>[];
      for (const c of confs) {
        results.push({
          type: 'confession',
          id: String(c.id),
          title: String(c.title),
          snippet: String(c.body).slice(0, 140),
          subtitle: `Confessions · ${c.category}`,
          link_path: '/confessions',
          score: 3,
          meta: { category: String(c.category) },
        });
      }
    }

    // Public complaints ONLY — NEVER expose is_private = 1 complaints in search!
    if (typeFilter === 'all' || typeFilter === 'complaint') {
      const comps = db
        .prepare('SELECT id, title, body, category, status, created_at FROM complaints WHERE is_private = 0 AND (lower(title) LIKE ? OR lower(body) LIKE ? OR lower(category) LIKE ?)')
        .all(likePattern, likePattern, likePattern) as Record<string, unknown>[];
      for (const cm of comps) {
        results.push({
          type: 'complaint',
          id: String(cm.id),
          title: String(cm.title),
          snippet: String(cm.body).slice(0, 140),
          subtitle: `Public Feedback · ${cm.category} · ${String(cm.status).replace(/_/g, ' ')}`,
          link_path: '/complaints',
          score: 3,
          meta: { status: String(cm.status) },
        });
      }
    }

    if (sort === 'newest') {
      results.sort((a, b) => String(b.meta.created_at || '').localeCompare(String(a.meta.created_at || '')));
    } else {
      results.sort((a, b) => b.score - a.score);
    }

    if (recordHistory) {
      db.prepare(
        'INSERT INTO search_events (id, query_normalized, display_query, user_id, result_count, cleared_by_user, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)'
      ).run(crypto.randomUUID(), q.toLowerCase(), q, viewer?.id ?? null, results.length, new Date().toISOString());
    }

    return res.json({ results: results.slice(0, 60), total: results.length, query: q });
  });

  // Live Autocomplete Suggestions
  router.get('/search/suggestions', (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    if (!q || q.length < 2) return res.json({ suggestions: [] });
    const like = `%${q}%`;

    const subjects = db
      .prepare(
        `SELECT s.id, s.name, p.code as p_code, sem.name as sem_name, s.program_id, s.semester_id
         FROM subjects s JOIN programs p ON p.id = s.program_id JOIN semesters sem ON sem.id = s.semester_id
         WHERE s.is_archived = 0 AND lower(s.name) LIKE ? LIMIT 4`
      )
      .all(like) as Record<string, unknown>[];

    const resources = db
      .prepare(
        `SELECT r.id, r.title, rc.name as cat_name, r.program_id, r.semester_id, r.subject_id
         FROM resources r JOIN resource_categories rc ON rc.id = r.category_id
         WHERE r.status = 'approved' AND lower(r.title) LIKE ? LIMIT 4`
      )
      .all(like) as Record<string, unknown>[];

    const communities = db
      .prepare("SELECT id, name, slug FROM communities WHERE is_archived = 0 AND visibility != 'private_approval' AND lower(name) LIKE ? LIMIT 3")
      .all(like) as Record<string, unknown>[];

    const posts = db
      .prepare("SELECT p.id, p.title, c.slug as comm_slug FROM posts p JOIN communities c ON c.id = p.community_id WHERE p.is_hidden = 0 AND c.visibility = 'public' AND lower(p.title) LIKE ? LIMIT 3")
      .all(like) as Record<string, unknown>[];

    const users = db
      .prepare("SELECT id, username, display_name FROM users WHERE account_status = 'active' AND role NOT IN ('admin', 'super_admin') AND (lower(display_name) LIKE ? OR lower(username) LIKE ?) LIMIT 3")
      .all(like, like) as Record<string, unknown>[];

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
  });

  // Personal Search History (never shared across users)
  router.get('/search/history', requireAuth, (req: AuthenticatedRequest, res) => {
    const rows = db
      .prepare(
        `SELECT display_query as query, MAX(created_at) as last_searched
         FROM search_events
         WHERE user_id = ? AND cleared_by_user = 0
         GROUP BY query_normalized
         ORDER BY last_searched DESC
         LIMIT 8`
      )
      .all(req.user!.id);
    return res.json({ history: rows });
  });

  router.delete('/search/history', requireAuth, (req: AuthenticatedRequest, res) => {
    db.prepare('UPDATE search_events SET cleared_by_user = 1 WHERE user_id = ?').run(req.user!.id);
    return res.json({ ok: true });
  });

  // Genuine Database-Computed Trending Engine
  router.get('/trending', (req, res) => {
    const windowParam = req.query.window === 'week' ? '-7 days' : '-1 day';

    // Trending Searches computed from aggregated search_events (never exposes user_ids)
    const trendingSearches = db
      .prepare(
        `SELECT MAX(display_query) as query,
                COUNT(*) as count,
                SUM(CASE WHEN created_at >= datetime('now', ?) THEN 1 ELSE 0 END) as recent_count,
                SUM(CASE WHEN created_at < datetime('now', ?) THEN 1 ELSE 0 END) as prior_count
         FROM search_events
         WHERE created_at >= datetime('now', '-14 days')
         GROUP BY query_normalized
         HAVING recent_count > 0
         ORDER BY recent_count DESC, count DESC
         LIMIT 8`
      )
      .all(windowParam, windowParam) as Array<{ query: string; count: number; recent_count: number; prior_count: number }>;

    const formattedSearches = trendingSearches.map((s) => ({
      query: s.query,
      count: Number(s.recent_count),
      growth_pct: s.prior_count > 0 ? Math.round(((s.recent_count - s.prior_count) / s.prior_count) * 100) : 100,
    }));

    // Trending Communities from genuine activity (recent posts + comments + members)
    const trendingCommunities = db
      .prepare(
        `SELECT c.id, c.slug, c.name, c.description, c.kind, c.visibility,
          (SELECT COUNT(*) FROM community_members cm WHERE cm.community_id = c.id AND cm.status = 'joined') as member_count,
          (SELECT COUNT(*) FROM posts p WHERE p.community_id = c.id AND p.is_hidden = 0 AND p.created_at >= datetime('now', ?)) as recent_posts,
          (SELECT COALESCE(SUM(p.upvote_count + p.comment_count), 0) FROM posts p WHERE p.community_id = c.id AND p.is_hidden = 0) as engagement_score
         FROM communities c
         WHERE c.is_archived = 0 AND c.visibility != 'private_approval'
         ORDER BY recent_posts DESC, engagement_score DESC, member_count DESC
         LIMIT 6`
      )
      .all(windowParam);

    // Most downloaded / popular academic resources
    const popularResources = db
      .prepare(
        `SELECT r.id, r.title, r.download_count, r.upvote_count, r.program_id, r.semester_id, r.subject_id,
                p.code as program_code, sub.name as subject_name, rc.name as category_name
         FROM resources r
         JOIN programs p ON p.id = r.program_id
         JOIN subjects sub ON sub.id = r.subject_id
         JOIN resource_categories rc ON rc.id = r.category_id
         WHERE r.status = 'approved'
         ORDER BY (r.download_count * 2 + r.upvote_count) DESC
         LIMIT 6`
      )
      .all();

    // Trending discussions
    const trendingDiscussions = db
      .prepare(
        `SELECT p.id, p.title, p.upvote_count, p.comment_count, p.created_at, c.name as community_name, c.slug as community_slug
         FROM posts p
         JOIN communities c ON c.id = p.community_id
         WHERE p.is_hidden = 0 AND c.visibility = 'public'
         ORDER BY (p.upvote_count * 2 + p.comment_count * 3) DESC, p.created_at DESC
         LIMIT 5`
      )
      .all();

    // Upcoming events
    const upcomingEvents = db
      .prepare("SELECT id, title, kind, location, starts_at FROM events WHERE starts_at >= datetime('now', '-1 day') ORDER BY starts_at ASC LIMIT 4")
      .all();

    return res.json({
      trending_searches: formattedSearches,
      trending_communities: trendingCommunities,
      popular_resources: popularResources,
      trending_discussions: trendingDiscussions,
      upcoming_events: upcomingEvents,
    });
  });

  return router;
}
