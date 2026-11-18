-- GandakiHub PostgreSQL + Supabase Migration
-- Enables UUID generation, pg_trgm trigram search, and Row Level Security (RLS)

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 1. User Roles Enum & Profiles
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

CREATE TABLE profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  bio TEXT NOT NULL DEFAULT '',
  role user_role NOT NULL DEFAULT 'visitor',
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  university_email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  external_reason TEXT,
  external_reason_detail TEXT,
  program_id UUID,
  semester_id UUID,
  interests TEXT[] NOT NULL DEFAULT '{}',
  notification_prefs JSONB NOT NULL DEFAULT '{"replies":true,"connections":true,"resources":true,"events":true,"announcements":true}',
  privacy_settings JSONB NOT NULL DEFAULT '{"show_program":true,"allow_connection_requests":true}',
  account_status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Dynamic Academic Structure
CREATE TABLE programs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  sort_order INT NOT NULL DEFAULT 0,
  is_archived BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE semesters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id UUID NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  number INT NOT NULL,
  name TEXT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_archived BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE(program_id, number)
);

CREATE TABLE subjects (
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

CREATE TABLE academic_folders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id UUID NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  parent_folder_id UUID REFERENCES academic_folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_archived BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE resource_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  pdf_only BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INT NOT NULL DEFAULT 0
);

-- 3. Academic Resources & Revisions (Private Bucket Storage Paths)
CREATE TABLE resources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category_id UUID NOT NULL REFERENCES resource_categories(id),
  program_id UUID NOT NULL REFERENCES programs(id),
  semester_id UUID NOT NULL REFERENCES semesters(id),
  subject_id UUID NOT NULL REFERENCES subjects(id),
  folder_id UUID REFERENCES academic_folders(id) ON DELETE SET NULL,
  academic_year TEXT NOT NULL DEFAULT '',
  uploader_id UUID NOT NULL REFERENCES profiles(id),
  status TEXT NOT NULL DEFAULT 'pending',
  current_revision_id UUID,
  download_count INT NOT NULL DEFAULT 0,
  upvote_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE resource_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id UUID NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  revision_number INT NOT NULL,
  storage_object_path TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  file_size BIGINT NOT NULL,
  sha256_hash TEXT NOT NULL,
  mime_type TEXT NOT NULL CHECK (mime_type = 'application/pdf'),
  status TEXT NOT NULL DEFAULT 'pending',
  reviewer_id UUID REFERENCES profiles(id),
  review_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Communities, Posts, Comments, Polls, Votes
CREATE TABLE communities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'special',
  visibility TEXT NOT NULL DEFAULT 'public',
  rules TEXT NOT NULL DEFAULT '',
  program_id UUID REFERENCES programs(id) ON DELETE SET NULL,
  is_archived BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  program_id UUID REFERENCES programs(id),
  semester_id UUID REFERENCES semesters(id),
  subject_id UUID REFERENCES subjects(id),
  author_id UUID NOT NULL REFERENCES profiles(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  flair TEXT,
  tags TEXT[] NOT NULL DEFAULT '{}',
  is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
  is_hidden BOOLEAN NOT NULL DEFAULT FALSE,
  upvote_count INT NOT NULL DEFAULT 0,
  downvote_count INT NOT NULL DEFAULT 0,
  comment_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. Confessions & Isolated Identity Vault
CREATE TABLE confessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Campus Life',
  status TEXT NOT NULL DEFAULT 'pending',
  reaction_support INT NOT NULL DEFAULT 0,
  reaction_relate INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE confession_identity_vault (
  confession_id UUID PRIMARY KEY REFERENCES confessions(id) ON DELETE CASCADE,
  author_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6. Private Complaints, Connections, Search Trends, Audit Logs
CREATE TABLE complaints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submitter_id UUID NOT NULL REFERENCES profiles(id),
  is_private BOOLEAN NOT NULL DEFAULT FALSE,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'submitted',
  assigned_handler_id UUID REFERENCES profiles(id),
  handler_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_a_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  user_b_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_a_id, user_b_id)
);

CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID REFERENCES profiles(id),
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Search Indexes (GIN + Trigram)
CREATE INDEX idx_subjects_name_trgm ON subjects USING GIN (name gin_trgm_ops);
CREATE INDEX idx_resources_fts ON resources USING GIN (to_tsvector('english', title || ' ' || description));
CREATE INDEX idx_posts_fts ON posts USING GIN (to_tsvector('english', title || ' ' || body));

-- Row Level Security (RLS)
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE confessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE confession_identity_vault ENABLE ROW LEVEL SECURITY;
ALTER TABLE complaints ENABLE ROW LEVEL SECURITY;
ALTER TABLE connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public profiles readable" ON profiles FOR SELECT USING (account_status = 'active');
CREATE POLICY "Approved resources readable" ON resources FOR SELECT USING (status = 'approved' OR uploader_id = auth.uid());
CREATE POLICY "Approved confessions readable" ON confessions FOR SELECT USING (status = 'approved');
CREATE POLICY "Identity vault Super Admin only" ON confession_identity_vault FOR SELECT USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'super_admin')
);
CREATE POLICY "Private complaints restricted" ON complaints FOR SELECT USING (
  NOT is_private OR submitter_id = auth.uid() OR assigned_handler_id = auth.uid() OR
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('super_admin', 'admin'))
);
CREATE POLICY "Own connections only" ON connections FOR SELECT USING (user_a_id = auth.uid() OR user_b_id = auth.uid());
