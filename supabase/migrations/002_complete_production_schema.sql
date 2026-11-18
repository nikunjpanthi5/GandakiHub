-- GandakiHub Complete Production PostgreSQL + Supabase Migration
-- Safe, idempotent migration: upgrades 001_initial_schema.sql OR initializes a fresh PostgreSQL database.
-- Do NOT run destructive DROP statements; preserves all existing records.

-- 1. Required Extensions
CREATE EXTENSION IF NOT EXISTS pg_trgm;
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

-- 2. Enum Types
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role') THEN
    CREATE TYPE user_role AS ENUM (
      'super_admin',
      'admin',
      'community_moderator',
      'verified_student',
      'verified_teacher',
      'future_student',
      'alumni',
      'visitor'
    );
  END IF;
END $$;

-- 3. Core Academic Structure (created before profiles so FK references succeed)
CREATE TABLE IF NOT EXISTS programs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  sort_order INT NOT NULL DEFAULT 0,
  is_archived BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS semesters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id UUID NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  number INT NOT NULL,
  name TEXT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_archived BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(program_id, number)
);
ALTER TABLE semesters ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE TABLE IF NOT EXISTS subjects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id UUID NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  semester_id UUID NOT NULL REFERENCES semesters(id) ON DELETE CASCADE,
  code TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  sort_order INT NOT NULL DEFAULT 0,
  is_archived BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_subjects_sem ON subjects(semester_id, sort_order);

CREATE TABLE IF NOT EXISTS academic_folders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id UUID NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  parent_folder_id UUID REFERENCES academic_folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_archived BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE academic_folders ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE TABLE IF NOT EXISTS resource_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  pdf_only BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INT NOT NULL DEFAULT 0
);

-- 4. Profiles, Credentials, Role History, OTP, Sessions, Rate Limits
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  bio TEXT NOT NULL DEFAULT '',
  role user_role NOT NULL DEFAULT 'visitor',
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  university_email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  external_reason TEXT,
  external_reason_detail TEXT,
  program_id UUID REFERENCES programs(id) ON DELETE SET NULL,
  semester_id UUID REFERENCES semesters(id) ON DELETE SET NULL,
  interests TEXT[] NOT NULL DEFAULT '{}',
  notification_prefs JSONB NOT NULL DEFAULT '{"replies":true,"connections":true,"resources":true,"events":true,"announcements":true}'::jsonb,
  privacy_settings JSONB NOT NULL DEFAULT '{"show_program":true,"allow_connection_requests":true}'::jsonb,
  account_status TEXT NOT NULL DEFAULT 'active' CHECK (account_status IN ('active', 'suspended', 'restricted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- If upgrading from 001_initial_schema.sql where profiles.id referenced auth.users(id), detach safely
-- so username-only admin provisioning and Express Auth work seamlessly without requiring auth.users rows.
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_id_fkey;
ALTER TABLE profiles ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_username_lower ON profiles (lower(username));

-- Isolated auth credentials table (never readable by anon/authenticated PostgREST clients)
CREATE TABLE IF NOT EXISTS user_credentials (
  user_id UUID PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_credentials_email_lower ON user_credentials (lower(email));

CREATE TABLE IF NOT EXISTS user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  role user_role NOT NULL,
  granted_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_roles_user ON user_roles(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS otp_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
  code_hash TEXT NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  resend_after TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_otp_email_purpose ON otp_codes(lower(email), purpose, created_at DESC);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INT NOT NULL,
  window_expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash TEXT NOT NULL UNIQUE,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- 5. Academic Resources & Revisions (Private Supabase Storage Paths Only)
CREATE TABLE IF NOT EXISTS resources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category_id UUID NOT NULL REFERENCES resource_categories(id),
  program_id UUID NOT NULL REFERENCES programs(id),
  semester_id UUID NOT NULL REFERENCES semesters(id),
  subject_id UUID NOT NULL REFERENCES subjects(id),
  folder_id UUID REFERENCES academic_folders(id) ON DELETE SET NULL,
  academic_year TEXT NOT NULL DEFAULT '',
  uploader_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'changes_requested')),
  current_revision_id UUID,
  download_count INT NOT NULL DEFAULT 0,
  upvote_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_resources_hierarchy ON resources(program_id, semester_id, subject_id, category_id, status);

CREATE TABLE IF NOT EXISTS resource_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id UUID NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  revision_number INT NOT NULL,
  storage_object_path TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  sanitized_filename TEXT NOT NULL DEFAULT 'document.pdf',
  file_size BIGINT NOT NULL,
  sha256_hash TEXT NOT NULL,
  mime_type TEXT NOT NULL CHECK (mime_type = 'application/pdf'),
  extracted_text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'changes_requested')),
  reviewer_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  review_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE resource_revisions ADD COLUMN IF NOT EXISTS sanitized_filename TEXT NOT NULL DEFAULT 'document.pdf';
ALTER TABLE resource_revisions ADD COLUMN IF NOT EXISTS extracted_text TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_revisions_hash ON resource_revisions(sha256_hash);
CREATE INDEX IF NOT EXISTS idx_revisions_resource ON resource_revisions(resource_id, revision_number DESC);

CREATE TABLE IF NOT EXISTS resource_downloads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id UUID NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  user_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS resource_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id UUID NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  reporter_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  reviewed_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  resolution_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6. Communities, Posts, Comments, Votes, Bookmarks, Tags, Polls
CREATE TABLE IF NOT EXISTS communities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'special' CHECK (kind IN ('academic', 'special')),
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'university_only', 'private_approval')),
  rules TEXT NOT NULL DEFAULT '',
  program_id UUID REFERENCES programs(id) ON DELETE SET NULL,
  is_archived BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS community_members (
  community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'joined' CHECK (status IN ('joined', 'pending')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (community_id, user_id)
);

CREATE TABLE IF NOT EXISTS community_moderators (
  community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (community_id, user_id)
);

CREATE TABLE IF NOT EXISTS posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  program_id UUID REFERENCES programs(id) ON DELETE SET NULL,
  semester_id UUID REFERENCES semesters(id) ON DELETE SET NULL,
  subject_id UUID REFERENCES subjects(id) ON DELETE SET NULL,
  author_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  image_url TEXT,
  flair TEXT,
  tags TEXT[] NOT NULL DEFAULT '{}',
  is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
  is_hidden BOOLEAN NOT NULL DEFAULT FALSE,
  upvote_count INT NOT NULL DEFAULT 0,
  downvote_count INT NOT NULL DEFAULT 0,
  comment_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE posts ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
CREATE INDEX IF NOT EXISTS idx_posts_community ON posts(community_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_subject ON posts(subject_id, created_at DESC);

CREATE TABLE IF NOT EXISTS tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS post_tags (
  post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, tag_id)
);

CREATE TABLE IF NOT EXISTS comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  parent_comment_id UUID REFERENCES comments(id) ON DELETE CASCADE,
  author_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  upvote_count INT NOT NULL DEFAULT 0,
  downvote_count INT NOT NULL DEFAULT 0,
  is_hidden BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id, created_at ASC);

CREATE TABLE IF NOT EXISTS votes (
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('post', 'comment', 'resource', 'idea')),
  target_id UUID NOT NULL,
  value SMALLINT NOT NULL CHECK (value IN (-1, 1)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, target_type, target_id)
);

CREATE TABLE IF NOT EXISTS bookmarks (
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('post', 'resource')),
  target_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, target_type, target_id)
);

CREATE TABLE IF NOT EXISTS polls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID NOT NULL UNIQUE REFERENCES posts(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  closes_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS poll_options (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  poll_id UUID NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS poll_votes (
  poll_id UUID NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  option_id UUID NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (poll_id, user_id)
);

-- 7. Connections & Blocking
CREATE TABLE IF NOT EXISTS connection_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  receiver_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (sender_id <> receiver_id)
);

CREATE TABLE IF NOT EXISTS connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_a_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  user_b_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_a_id, user_b_id),
  CHECK (user_a_id < user_b_id)
);

CREATE TABLE IF NOT EXISTS user_blocks (
  blocker_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  blocked_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);

-- 8. Confessions (NO author_id column) + Isolated Identity Vault
CREATE TABLE IF NOT EXISTS confessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  image_url TEXT,
  category TEXT NOT NULL DEFAULT 'Campus Life',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reaction_support INT NOT NULL DEFAULT 0,
  reaction_relate INT NOT NULL DEFAULT 0,
  comment_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE confessions ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE confessions ADD COLUMN IF NOT EXISTS comment_count INT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS confession_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  confession_id UUID NOT NULL REFERENCES confessions(id) ON DELETE CASCADE,
  alias_label TEXT NOT NULL DEFAULT 'Anonymous Student',
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS confession_identity_vault (
  confession_id UUID PRIMARY KEY REFERENCES confessions(id) ON DELETE CASCADE,
  author_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 9. Special Channels: Complaints, Ideas, Donations, Opportunities, Events, Study Groups
CREATE TABLE IF NOT EXISTS complaints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submitter_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  is_private BOOLEAN NOT NULL DEFAULT FALSE,
  category TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  image_url TEXT,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'under_review', 'in_progress', 'resolved', 'rejected')),
  assigned_handler_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  handler_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE TABLE IF NOT EXISTS ideas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  problem_statement TEXT NOT NULL DEFAULT '',
  proposed_solution TEXT NOT NULL DEFAULT '',
  image_url TEXT,
  collaborators_needed TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new_idea' CHECK (status IN ('new_idea', 'under_discussion', 'looking_for_collaborators', 'in_progress', 'completed')),
  upvote_count INT NOT NULL DEFAULT 0,
  follower_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS idea_followers (
  idea_id UUID NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (idea_id, user_id)
);

CREATE TABLE IF NOT EXISTS donation_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  image_url TEXT,
  contact_method TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'fulfilled', 'rejected')),
  verification_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS opportunities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('internship', 'job', 'scholarship', 'competition', 'research', 'workshop')),
  title TEXT NOT NULL DEFAULT '',
  organization TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  image_url TEXT,
  eligibility TEXT NOT NULL DEFAULT '',
  deadline TEXT NOT NULL,
  external_url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'event' CHECK (kind IN ('event', 'seminar', 'announcement')),
  title TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT,
  description TEXT NOT NULL DEFAULT '',
  image_url TEXT,
  is_official_notice BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS study_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  program_id UUID REFERENCES programs(id) ON DELETE SET NULL,
  semester_id UUID REFERENCES semesters(id) ON DELETE SET NULL,
  subject_id UUID REFERENCES subjects(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  image_url TEXT,
  schedule_text TEXT NOT NULL,
  max_members INT NOT NULL DEFAULT 15,
  member_count INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS study_group_members (
  group_id UUID NOT NULL REFERENCES study_groups(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (group_id, user_id)
);

-- 10. Governance, Moderation, Search, Notifications, Settings
CREATE TABLE IF NOT EXISTS profanity_dictionary (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  term TEXT NOT NULL UNIQUE,
  normalized_term TEXT NOT NULL,
  language TEXT NOT NULL CHECK (language IN ('en', 'ne_devanagari', 'ne_romanized')),
  severity TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high')),
  context_exception_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL,
  target_id UUID NOT NULL,
  reason TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  reviewed_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  resolution_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS moderation_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  submitted_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'changes_requested')),
  reviewer_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  UNIQUE(entity_type, entity_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  link_path TEXT NOT NULL DEFAULT '/',
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read, created_at DESC);

CREATE TABLE IF NOT EXISTS search_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  query_normalized TEXT NOT NULL,
  display_query TEXT NOT NULL,
  user_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  result_count INT NOT NULL DEFAULT 0,
  cleared_by_user BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_search_events_time ON search_events(created_at DESC, query_normalized);

CREATE TABLE IF NOT EXISTS search_suggestions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  term TEXT NOT NULL UNIQUE,
  category_group TEXT NOT NULL DEFAULT 'Topics',
  link_path TEXT NOT NULL DEFAULT '/explore',
  weight INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_logs(created_at DESC);

CREATE TABLE IF NOT EXISTS platform_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 11. PostgreSQL Full-Text Search (GIN) + Trigram (pg_trgm) Indexes
CREATE INDEX IF NOT EXISTS idx_programs_trgm ON programs USING GIN (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_semesters_trgm ON semesters USING GIN (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_subjects_name_trgm ON subjects USING GIN (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_folders_name_trgm ON academic_folders USING GIN (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_resources_title_trgm ON resources USING GIN (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_communities_name_trgm ON communities USING GIN (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_posts_title_trgm ON posts USING GIN (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_profiles_display_trgm ON profiles USING GIN (display_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_profiles_username_trgm ON profiles USING GIN (username gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_tags_name_trgm ON tags USING GIN (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_subjects_fts ON subjects USING GIN (to_tsvector('simple', coalesce(code, '') || ' ' || coalesce(name, '') || ' ' || coalesce(description, '')));
CREATE INDEX IF NOT EXISTS idx_resources_fts ON resources USING GIN (to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(description, '') || ' ' || coalesce(academic_year, '')));
CREATE INDEX IF NOT EXISTS idx_communities_fts ON communities USING GIN (to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(description, '')));
CREATE INDEX IF NOT EXISTS idx_posts_fts ON posts USING GIN (to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(body, '') || ' ' || coalesce(flair, '')));
CREATE INDEX IF NOT EXISTS idx_comments_fts ON comments USING GIN (to_tsvector('simple', coalesce(body, '')));
CREATE INDEX IF NOT EXISTS idx_ideas_fts ON ideas USING GIN (to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(problem_statement, '') || ' ' || coalesce(proposed_solution, '')));
CREATE INDEX IF NOT EXISTS idx_opportunities_fts ON opportunities USING GIN (to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(organization, '') || ' ' || coalesce(description, '')));
CREATE INDEX IF NOT EXISTS idx_events_fts ON events USING GIN (to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(location, '') || ' ' || coalesce(description, '')));
CREATE INDEX IF NOT EXISTS idx_study_groups_fts ON study_groups USING GIN (to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(description, '')));
CREATE INDEX IF NOT EXISTS idx_confessions_fts ON confessions USING GIN (to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(body, '')));
CREATE INDEX IF NOT EXISTS idx_complaints_fts ON complaints USING GIN (to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(body, '') || ' ' || coalesce(category, '')));

-- 12. Security Helper Functions & Triggers
CREATE OR REPLACE FUNCTION public.app_actor_id()
RETURNS UUID
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v TEXT;
BEGIN
  v := COALESCE(
    NULLIF(current_setting('app.current_user_id', true), ''),
    NULLIF(current_setting('request.jwt.claim.sub', true), '')
  );
  IF v IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN v::uuid;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.app_actor_role()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role::text FROM public.profiles WHERE id = public.app_actor_id() LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.app_is_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(public.app_actor_role() IN ('super_admin', 'admin'), FALSE);
$$;

CREATE OR REPLACE FUNCTION public.app_is_moderator()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(public.app_actor_role() IN ('super_admin', 'admin', 'community_moderator'), FALSE);
$$;

CREATE OR REPLACE FUNCTION public.app_is_super_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(public.app_actor_role() = 'super_admin', FALSE);
$$;

-- Enforce that users CANNOT change their own role, verification flags, or account_status
CREATE OR REPLACE FUNCTION public.enforce_profile_privilege_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF COALESCE(current_setting('app.trusted_server', true), '') <> 'true' THEN
    IF NEW.role IS DISTINCT FROM OLD.role THEN
      RAISE EXCEPTION 'Unauthorized: users cannot modify account roles.';
    END IF;
    IF NEW.account_status IS DISTINCT FROM OLD.account_status THEN
      RAISE EXCEPTION 'Unauthorized: users cannot modify account status.';
    END IF;
    IF NEW.email_verified IS DISTINCT FROM OLD.email_verified
       OR NEW.university_email_verified IS DISTINCT FROM OLD.university_email_verified THEN
      RAISE EXCEPTION 'Unauthorized: verification flags are server-controlled.';
    END IF;
  END IF;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_profiles_privilege_guard ON profiles;
CREATE TRIGGER trg_profiles_privilege_guard
  BEFORE UPDATE ON profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_profile_privilege_guard();

-- Prevent audit_logs tampering (append-only)
CREATE OR REPLACE FUNCTION public.prevent_audit_log_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only and cannot be modified or deleted.';
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_logs_immutable ON audit_logs;
CREATE TRIGGER trg_audit_logs_immutable
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_audit_log_mutation();

-- 13. Comprehensive Row Level Security (RLS) on All Tables
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE otp_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE programs ENABLE ROW LEVEL SECURITY;
ALTER TABLE semesters ENABLE ROW LEVEL SECURITY;
ALTER TABLE subjects ENABLE ROW LEVEL SECURITY;
ALTER TABLE academic_folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE resource_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE resource_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE resource_downloads ENABLE ROW LEVEL SECURITY;
ALTER TABLE resource_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE communities ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_moderators ENABLE ROW LEVEL SECURITY;
ALTER TABLE posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE post_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookmarks ENABLE ROW LEVEL SECURITY;
ALTER TABLE polls ENABLE ROW LEVEL SECURITY;
ALTER TABLE poll_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE poll_votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE connection_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE confessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE confession_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE confession_identity_vault ENABLE ROW LEVEL SECURITY;
ALTER TABLE complaints ENABLE ROW LEVEL SECURITY;
ALTER TABLE ideas ENABLE ROW LEVEL SECURITY;
ALTER TABLE idea_followers ENABLE ROW LEVEL SECURITY;
ALTER TABLE donation_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE opportunities ENABLE ROW LEVEL SECURITY;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE study_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE study_group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE profanity_dictionary ENABLE ROW LEVEL SECURITY;
ALTER TABLE reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE moderation_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE search_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE search_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_settings ENABLE ROW LEVEL SECURITY;

-- Drop old policies cleanly before recreating idempotently
DO $$
DECLARE
  pol RECORD;
BEGIN
  FOR pol IN SELECT schemaname, tablename, policyname FROM pg_policies WHERE schemaname = 'public' LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', pol.policyname, pol.schemaname, pol.tablename);
  END LOOP;
END $$;

-- Profiles: active non-admin profiles readable; users can update own profile fields (trigger blocks role/status changes)
CREATE POLICY "Public profiles readable" ON profiles
  FOR SELECT USING (
    (account_status = 'active' AND role NOT IN ('admin', 'super_admin'))
    OR id = public.app_actor_id()
    OR public.app_is_admin()
  );
CREATE POLICY "Own profile update" ON profiles
  FOR UPDATE USING (id = public.app_actor_id() OR public.app_is_admin())
  WITH CHECK (id = public.app_actor_id() OR public.app_is_admin());

-- Strict server-only tables (no client PostgREST read/write)
CREATE POLICY "Server only credentials" ON user_credentials FOR ALL USING (FALSE);
CREATE POLICY "Server only otp" ON otp_codes FOR ALL USING (FALSE);
CREATE POLICY "Server only rate_limits" ON rate_limits FOR ALL USING (FALSE);
CREATE POLICY "Server only sessions" ON sessions FOR ALL USING (FALSE);

CREATE POLICY "User roles viewable by owner or admin" ON user_roles
  FOR SELECT USING (user_id = public.app_actor_id() OR public.app_is_admin());

-- Academic hierarchy: readable by all, editable only by Admins
CREATE POLICY "Academic programs readable" ON programs FOR SELECT USING (TRUE);
CREATE POLICY "Academic programs admin write" ON programs FOR ALL USING (public.app_is_admin()) WITH CHECK (public.app_is_admin());
CREATE POLICY "Academic semesters readable" ON semesters FOR SELECT USING (TRUE);
CREATE POLICY "Academic semesters admin write" ON semesters FOR ALL USING (public.app_is_admin()) WITH CHECK (public.app_is_admin());
CREATE POLICY "Academic subjects readable" ON subjects FOR SELECT USING (TRUE);
CREATE POLICY "Academic subjects admin write" ON subjects FOR ALL USING (public.app_is_admin()) WITH CHECK (public.app_is_admin());
CREATE POLICY "Academic folders readable" ON academic_folders FOR SELECT USING (TRUE);
CREATE POLICY "Academic folders admin write" ON academic_folders FOR ALL USING (public.app_is_admin()) WITH CHECK (public.app_is_admin());
CREATE POLICY "Categories readable" ON resource_categories FOR SELECT USING (TRUE);
CREATE POLICY "Categories admin write" ON resource_categories FOR ALL USING (public.app_is_admin()) WITH CHECK (public.app_is_admin());

-- Resources & Revisions: approved public; pending/rejected only uploader or moderator/admin; uploaders cannot self-approve
CREATE POLICY "Resources readable" ON resources
  FOR SELECT USING (status = 'approved' OR uploader_id = public.app_actor_id() OR public.app_is_moderator());
CREATE POLICY "Resources insert own pending" ON resources
  FOR INSERT WITH CHECK (uploader_id = public.app_actor_id() AND (status = 'pending' OR public.app_is_admin()));
CREATE POLICY "Resources update owner or mod" ON resources
  FOR UPDATE USING (uploader_id = public.app_actor_id() OR public.app_is_moderator())
  WITH CHECK (
    (public.app_is_moderator() AND uploader_id <> public.app_actor_id())
    OR public.app_is_admin()
    OR (uploader_id = public.app_actor_id() AND status = 'pending')
  );

CREATE POLICY "Revisions readable" ON resource_revisions
  FOR SELECT USING (
    status = 'approved'
    OR EXISTS (SELECT 1 FROM resources r WHERE r.id = resource_id AND r.uploader_id = public.app_actor_id())
    OR public.app_is_moderator()
  );

CREATE POLICY "Downloads admin or owner" ON resource_downloads
  FOR SELECT USING (user_id = public.app_actor_id() OR public.app_is_admin());
CREATE POLICY "Resource reports owner or mod" ON resource_reports
  FOR SELECT USING (reporter_id = public.app_actor_id() OR public.app_is_moderator());

-- Communities & Posts
CREATE POLICY "Communities readable" ON communities
  FOR SELECT USING (
    visibility <> 'private_approval'
    OR EXISTS (SELECT 1 FROM community_members cm WHERE cm.community_id = id AND cm.user_id = public.app_actor_id() AND cm.status = 'joined')
    OR public.app_is_admin()
  );
CREATE POLICY "Community members self or mod" ON community_members
  FOR SELECT USING (user_id = public.app_actor_id() OR public.app_is_moderator());
CREATE POLICY "Community moderators readable" ON community_moderators FOR SELECT USING (TRUE);

CREATE POLICY "Posts readable respecting community visibility" ON posts
  FOR SELECT USING (
    is_hidden = FALSE AND EXISTS (
      SELECT 1 FROM communities c WHERE c.id = community_id AND c.is_archived = FALSE AND (
        c.visibility = 'public'
        OR (c.visibility = 'university_only' AND (public.app_is_admin() OR EXISTS (SELECT 1 FROM profiles p WHERE p.id = public.app_actor_id() AND p.university_email_verified = TRUE)))
        OR (c.visibility = 'private_approval' AND EXISTS (SELECT 1 FROM community_members cm WHERE cm.community_id = c.id AND cm.user_id = public.app_actor_id() AND cm.status = 'joined'))
      )
    )
  );
CREATE POLICY "Posts insert by author" ON posts FOR INSERT WITH CHECK (author_id = public.app_actor_id());
CREATE POLICY "Posts update by author or mod" ON posts FOR UPDATE USING (author_id = public.app_actor_id() OR public.app_is_moderator());

CREATE POLICY "Tags readable" ON tags FOR SELECT USING (TRUE);
CREATE POLICY "Post tags readable" ON post_tags FOR SELECT USING (TRUE);
CREATE POLICY "Comments readable" ON comments FOR SELECT USING (is_hidden = FALSE OR public.app_is_moderator());
CREATE POLICY "Own votes only" ON votes FOR ALL USING (user_id = public.app_actor_id()) WITH CHECK (user_id = public.app_actor_id());
CREATE POLICY "Own bookmarks only" ON bookmarks FOR ALL USING (user_id = public.app_actor_id()) WITH CHECK (user_id = public.app_actor_id());
CREATE POLICY "Polls readable" ON polls FOR SELECT USING (TRUE);
CREATE POLICY "Poll options readable" ON poll_options FOR SELECT USING (TRUE);
CREATE POLICY "Own poll votes" ON poll_votes FOR ALL USING (user_id = public.app_actor_id()) WITH CHECK (user_id = public.app_actor_id());

-- Connections, Requests, Blocks: strictly private to participants
CREATE POLICY "Own connection requests" ON connection_requests
  FOR ALL USING (sender_id = public.app_actor_id() OR receiver_id = public.app_actor_id());
CREATE POLICY "Own connections only" ON connections
  FOR SELECT USING (user_a_id = public.app_actor_id() OR user_b_id = public.app_actor_id());
CREATE POLICY "Own blocks only" ON user_blocks
  FOR ALL USING (blocker_id = public.app_actor_id()) WITH CHECK (blocker_id = public.app_actor_id());

-- Confessions & Identity Vault
CREATE POLICY "Approved confessions readable" ON confessions
  FOR SELECT USING (status = 'approved' OR public.app_is_moderator());
CREATE POLICY "Approved confession comments readable" ON confession_comments
  FOR SELECT USING (EXISTS (SELECT 1 FROM confessions c WHERE c.id = confession_id AND (c.status = 'approved' OR public.app_is_moderator())));
CREATE POLICY "Identity vault Super Admin only" ON confession_identity_vault
  FOR SELECT USING (public.app_is_super_admin());

-- Complaints: strict isolation for private complaints
CREATE POLICY "Private complaints restricted" ON complaints
  FOR SELECT USING (
    NOT is_private
    OR submitter_id = public.app_actor_id()
    OR assigned_handler_id = public.app_actor_id()
    OR public.app_is_moderator()
  );
CREATE POLICY "Complaints insert own" ON complaints
  FOR INSERT WITH CHECK (submitter_id = public.app_actor_id());

-- Ideas, Donations, Opportunities, Events, Study Groups
CREATE POLICY "Ideas readable" ON ideas FOR SELECT USING (TRUE);
CREATE POLICY "Idea followers readable" ON idea_followers FOR SELECT USING (user_id = public.app_actor_id() OR public.app_is_admin());
CREATE POLICY "Donations approved or own" ON donation_requests
  FOR SELECT USING (status IN ('approved', 'fulfilled') OR requester_id = public.app_actor_id() OR public.app_is_moderator());
CREATE POLICY "Opportunities approved or mod" ON opportunities
  FOR SELECT USING (status = 'approved' OR author_id = public.app_actor_id() OR public.app_is_moderator());
CREATE POLICY "Events readable" ON events FOR SELECT USING (TRUE);
CREATE POLICY "Study groups readable" ON study_groups FOR SELECT USING (TRUE);
CREATE POLICY "Study group members self or mod" ON study_group_members
  FOR SELECT USING (user_id = public.app_actor_id() OR public.app_is_moderator());

-- Governance, Moderation, Search, Notifications, Settings
CREATE POLICY "Profanity moderators only" ON profanity_dictionary FOR SELECT USING (public.app_is_moderator());
CREATE POLICY "Reports owner or mod" ON reports FOR SELECT USING (reporter_id = public.app_actor_id() OR public.app_is_moderator());
CREATE POLICY "Moderation queue mod only" ON moderation_queue FOR SELECT USING (public.app_is_moderator());
CREATE POLICY "Own notifications only" ON notifications FOR ALL USING (user_id = public.app_actor_id());
CREATE POLICY "Own search events only" ON search_events FOR SELECT USING (user_id = public.app_actor_id() OR public.app_is_admin());
CREATE POLICY "Search suggestions readable" ON search_suggestions FOR SELECT USING (TRUE);
CREATE POLICY "Audit logs admin read only" ON audit_logs FOR SELECT USING (public.app_is_admin());
CREATE POLICY "Settings admin read and super_admin write" ON platform_settings
  FOR SELECT USING (public.app_is_admin());
CREATE POLICY "Settings super_admin modify" ON platform_settings
  FOR ALL USING (public.app_is_super_admin()) WITH CHECK (public.app_is_super_admin());
