-- GandakiHub Additive Migration 003: Post-Registration Profile Completion & Staff Verification
-- ZERO DATA LOSS GUARANTEE: Purely additive, idempotent schema changes.
-- Preserves all existing profiles, credentials, posts, confessions, messages, communities, complaints, and resources.
-- Do NOT execute destructive DROP, TRUNCATE, or DELETE operations.

-- 1. Additive nullable/defaulted profile completion columns on existing profiles table
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS department TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS student_id TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS staff_position TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS designation TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS profile_completed BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill profile_completed safely only for existing accounts that already provided program/semester or hold verified staff/admin roles
UPDATE profiles
SET profile_completed = TRUE
WHERE profile_completed = FALSE
  AND (
    (program_id IS NOT NULL AND semester_id IS NOT NULL)
    OR role IN ('super_admin', 'admin', 'verified_teacher')
  );

-- 2. University Staff / Faculty Verification Requests (Admin-Reviewed)
CREATE TABLE IF NOT EXISTS staff_verification_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  position TEXT NOT NULL,
  department TEXT NOT NULL,
  designation TEXT NOT NULL DEFAULT '',
  university_email TEXT NOT NULL,
  supporting_notes TEXT NOT NULL DEFAULT '',
  evidence_object_path TEXT,
  evidence_original_filename TEXT,
  evidence_mime_type TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewer_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  review_notes TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_verif_one_pending_per_user
  ON staff_verification_requests (user_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_staff_verif_status_created
  ON staff_verification_requests (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_staff_verif_user_created
  ON staff_verification_requests (user_id, created_at DESC);

-- 3. Row Level Security on staff_verification_requests
ALTER TABLE staff_verification_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Staff verification readable by owner or admin" ON staff_verification_requests;
CREATE POLICY "Staff verification readable by owner or admin" ON staff_verification_requests
  FOR SELECT USING (
    user_id = public.app_actor_id()
    OR public.app_is_admin()
  );

DROP POLICY IF EXISTS "Staff verification insertable by owner as pending" ON staff_verification_requests;
CREATE POLICY "Staff verification insertable by owner as pending" ON staff_verification_requests
  FOR INSERT WITH CHECK (
    user_id = public.app_actor_id()
    AND status = 'pending'
  );

DROP POLICY IF EXISTS "Staff verification reviewable by admin only" ON staff_verification_requests;
CREATE POLICY "Staff verification reviewable by admin only" ON staff_verification_requests
  FOR UPDATE USING (public.app_is_admin())
  WITH CHECK (public.app_is_admin());
