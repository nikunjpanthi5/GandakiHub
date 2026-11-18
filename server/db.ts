import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

let dbInstance: DatabaseSync | null = null;

export function getDatabasePath(): string {
  return process.env.DATABASE_PATH || path.resolve(process.cwd(), 'data', 'gandakihub.db');
}

export function getStorageDir(): string {
  return process.env.PRIVATE_STORAGE_DIR || path.resolve(process.cwd(), 'storage', 'private_pdfs');
}

export function getMediaDir(): string {
  if (process.env.MEDIA_STORAGE_DIR) return process.env.MEDIA_STORAGE_DIR;
  if (process.env.PRIVATE_STORAGE_DIR) return path.join(process.env.PRIVATE_STORAGE_DIR, 'post_images');
  return path.resolve(process.cwd(), 'storage', 'post_images');
}

export function getDb(): DatabaseSync {
  if (dbInstance) return dbInstance;

  const dbPath = getDatabasePath();
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  fs.mkdirSync(getStorageDir(), { recursive: true });
  fs.mkdirSync(getMediaDir(), { recursive: true });

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  initSchema(db);
  dbInstance = db;
  return db;
}

export function resetDbForTests(db: DatabaseSync): void {
  initSchema(db);
}

export function initSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      avatar_url TEXT,
      bio TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'visitor',
      email_verified INTEGER NOT NULL DEFAULT 0,
      university_email_verified INTEGER NOT NULL DEFAULT 0,
      external_reason TEXT,
      external_reason_detail TEXT,
      program_id TEXT,
      semester_id TEXT,
      interests_json TEXT NOT NULL DEFAULT '[]',
      notification_prefs_json TEXT NOT NULL DEFAULT '{"replies":true,"connections":true,"resources":true,"events":true,"announcements":true}',
      privacy_settings_json TEXT NOT NULL DEFAULT '{"show_program":true,"allow_connection_requests":true}',
      account_status TEXT NOT NULL DEFAULT 'active',
      is_demo INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users(lower(email));
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower ON users(lower(username));

    CREATE TABLE IF NOT EXISTS otp_codes (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      purpose TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      resend_after TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_otp_email_purpose ON otp_codes(email, purpose);

    CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      window_expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS programs (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS semesters (
      id TEXT PRIMARY KEY,
      program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
      number INTEGER NOT NULL,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE(program_id, number)
    );

    CREATE TABLE IF NOT EXISTS subjects (
      id TEXT PRIMARY KEY,
      program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
      semester_id TEXT NOT NULL REFERENCES semesters(id) ON DELETE CASCADE,
      code TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_subjects_sem ON subjects(semester_id, sort_order);

    CREATE TABLE IF NOT EXISTS academic_folders (
      id TEXT PRIMARY KEY,
      subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      parent_folder_id TEXT REFERENCES academic_folders(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS resource_categories (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      pdf_only INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS resources (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      category_id TEXT NOT NULL REFERENCES resource_categories(id),
      program_id TEXT NOT NULL REFERENCES programs(id),
      semester_id TEXT NOT NULL REFERENCES semesters(id),
      subject_id TEXT NOT NULL REFERENCES subjects(id),
      folder_id TEXT REFERENCES academic_folders(id) ON DELETE SET NULL,
      academic_year TEXT NOT NULL DEFAULT '',
      uploader_id TEXT NOT NULL REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'pending',
      current_revision_id TEXT,
      download_count INTEGER NOT NULL DEFAULT 0,
      upvote_count INTEGER NOT NULL DEFAULT 0,
      is_demo INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_resources_hierarchy ON resources(program_id, semester_id, subject_id, category_id, status);

    CREATE TABLE IF NOT EXISTS resource_revisions (
      id TEXT PRIMARY KEY,
      resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
      revision_number INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      sanitized_filename TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      sha256_hash TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      extracted_text TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      reviewer_id TEXT REFERENCES users(id),
      review_notes TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_revisions_hash ON resource_revisions(sha256_hash);

    CREATE TABLE IF NOT EXISTS resource_downloads (
      id TEXT PRIMARY KEY,
      resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS communities (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'special',
      visibility TEXT NOT NULL DEFAULT 'public',
      rules TEXT NOT NULL DEFAULT '',
      program_id TEXT REFERENCES programs(id) ON DELETE SET NULL,
      is_archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS community_members (
      community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'joined',
      created_at TEXT NOT NULL,
      PRIMARY KEY (community_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS community_moderators (
      community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      assigned_at TEXT NOT NULL,
      PRIMARY KEY (community_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY,
      community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
      program_id TEXT REFERENCES programs(id) ON DELETE SET NULL,
      semester_id TEXT REFERENCES semesters(id) ON DELETE SET NULL,
      subject_id TEXT REFERENCES subjects(id) ON DELETE SET NULL,
      author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      flair TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]',
      is_pinned INTEGER NOT NULL DEFAULT 0,
      is_hidden INTEGER NOT NULL DEFAULT 0,
      upvote_count INTEGER NOT NULL DEFAULT 0,
      downvote_count INTEGER NOT NULL DEFAULT 0,
      comment_count INTEGER NOT NULL DEFAULT 0,
      is_demo INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_posts_community ON posts(community_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      parent_comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
      author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      upvote_count INTEGER NOT NULL DEFAULT 0,
      downvote_count INTEGER NOT NULL DEFAULT 0,
      is_hidden INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id, created_at ASC);

    CREATE TABLE IF NOT EXISTS votes (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      value INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, target_type, target_id)
    );

    CREATE TABLE IF NOT EXISTS bookmarks (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, target_type, target_id)
    );

    CREATE TABLE IF NOT EXISTS polls (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL UNIQUE REFERENCES posts(id) ON DELETE CASCADE,
      question TEXT NOT NULL,
      closes_at TEXT
    );

    CREATE TABLE IF NOT EXISTS poll_options (
      id TEXT PRIMARY KEY,
      poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS poll_votes (
      poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
      option_id TEXT NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (poll_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS connection_requests (
      id TEXT PRIMARY KEY,
      sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      receiver_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS connections (
      id TEXT PRIMARY KEY,
      user_a_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_b_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      UNIQUE(user_a_id, user_b_id)
    );

    CREATE TABLE IF NOT EXISTS user_blocks (
      blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (blocker_id, blocked_id)
    );

    -- Confessions intentionally have NO author_id column!
    CREATE TABLE IF NOT EXISTS confessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'Campus Life',
      status TEXT NOT NULL DEFAULT 'pending',
      reaction_support INTEGER NOT NULL DEFAULT 0,
      reaction_relate INTEGER NOT NULL DEFAULT 0,
      comment_count INTEGER NOT NULL DEFAULT 0,
      is_demo INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS confession_comments (
      id TEXT PRIMARY KEY,
      confession_id TEXT NOT NULL REFERENCES confessions(id) ON DELETE CASCADE,
      alias_label TEXT NOT NULL DEFAULT 'Anonymous Student',
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    -- Isolated identity vault: only accessible by super_admin with mandatory audit logging
    CREATE TABLE IF NOT EXISTS confession_identity_vault (
      confession_id TEXT PRIMARY KEY REFERENCES confessions(id) ON DELETE CASCADE,
      author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS complaints (
      id TEXT PRIMARY KEY,
      submitter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      is_private INTEGER NOT NULL DEFAULT 0,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'submitted',
      assigned_handler_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      handler_notes TEXT,
      is_demo INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ideas (
      id TEXT PRIMARY KEY,
      author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      problem_statement TEXT NOT NULL,
      proposed_solution TEXT NOT NULL,
      collaborators_needed TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'new_idea',
      upvote_count INTEGER NOT NULL DEFAULT 0,
      follower_count INTEGER NOT NULL DEFAULT 0,
      is_demo INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS idea_followers (
      idea_id TEXT NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (idea_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS donation_requests (
      id TEXT PRIMARY KEY,
      requester_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      contact_method TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      verification_notes TEXT,
      is_demo INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS opportunities (
      id TEXT PRIMARY KEY,
      author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      organization TEXT NOT NULL,
      description TEXT NOT NULL,
      eligibility TEXT NOT NULL DEFAULT '',
      deadline TEXT NOT NULL,
      external_url TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      is_demo INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL DEFAULT 'event',
      title TEXT NOT NULL,
      location TEXT NOT NULL,
      starts_at TEXT NOT NULL,
      ends_at TEXT,
      description TEXT NOT NULL,
      is_official_notice INTEGER NOT NULL DEFAULT 0,
      is_demo INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS study_groups (
      id TEXT PRIMARY KEY,
      creator_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      program_id TEXT REFERENCES programs(id) ON DELETE SET NULL,
      semester_id TEXT REFERENCES semesters(id) ON DELETE SET NULL,
      subject_id TEXT REFERENCES subjects(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      schedule_text TEXT NOT NULL,
      max_members INTEGER NOT NULL DEFAULT 15,
      member_count INTEGER NOT NULL DEFAULT 1,
      is_demo INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS study_group_members (
      group_id TEXT NOT NULL REFERENCES study_groups(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      joined_at TEXT NOT NULL,
      PRIMARY KEY (group_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS profanity_dictionary (
      id TEXT PRIMARY KEY,
      term TEXT NOT NULL UNIQUE,
      normalized_term TEXT NOT NULL,
      language TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'medium',
      context_exception_note TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      resolution_notes TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      link_path TEXT NOT NULL DEFAULT '/',
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read, created_at DESC);

    CREATE TABLE IF NOT EXISTS search_events (
      id TEXT PRIMARY KEY,
      query_normalized TEXT NOT NULL,
      display_query TEXT NOT NULL,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      result_count INTEGER NOT NULL DEFAULT 0,
      cleared_by_user INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_search_events_time ON search_events(created_at DESC, query_normalized);

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_logs(created_at DESC);

    CREATE TABLE IF NOT EXISTS platform_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- FTS5 search index for fast full-text ranking across public searchable entities
    CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
      entity_type,
      entity_id UNINDEXED,
      title,
      body,
      meta_text,
      tokenize = 'unicode61 remove_diacritics 1'
    );
  `);

  const ensureColumn = (table: string, column: string, definition: string) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  };

  for (const tbl of [
    'posts',
    'confessions',
    'complaints',
    'ideas',
    'donation_requests',
    'opportunities',
    'events',
    'study_groups',
  ]) {
    ensureColumn(tbl, 'image_url', 'TEXT');
  }
}

export function indexSearchEntity(
  db: DatabaseSync,
  entityType: string,
  entityId: string,
  title: string,
  body: string,
  metaText: string
): void {
  db.prepare('DELETE FROM search_index WHERE entity_type = ? AND entity_id = ?').run(
    entityType,
    entityId
  );
  db.prepare(
    'INSERT INTO search_index (entity_type, entity_id, title, body, meta_text) VALUES (?, ?, ?, ?, ?)'
  ).run(entityType, entityId, title, body, metaText);
}

export function removeSearchEntity(db: DatabaseSync, entityType: string, entityId: string): void {
  db.prepare('DELETE FROM search_index WHERE entity_type = ? AND entity_id = ?').run(
    entityType,
    entityId
  );
}

export function writeAuditLog(
  db: DatabaseSync,
  actorId: string | null,
  action: string,
  targetType: string,
  targetId: string,
  metadata: Record<string, unknown> = {}
): void {
  db.prepare(
    'INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(
    crypto.randomUUID(),
    actorId,
    action,
    targetType,
    targetId,
    JSON.stringify(metadata),
    new Date().toISOString()
  );
}

export function createNotification(
  db: DatabaseSync,
  userId: string,
  kind: string,
  title: string,
  body: string,
  linkPath: string
): void {
  db.prepare(
    'INSERT INTO notifications (id, user_id, kind, title, body, link_path, is_read, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)'
  ).run(crypto.randomUUID(), userId, kind, title, body, linkPath, new Date().toISOString());
}
