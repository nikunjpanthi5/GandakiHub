# GandakiHub — Manual Supabase Migration, Data Preservation & Rollback Guide

> **Important:** Never let automated tools alter your live Supabase database without review. Execute the SQL steps below manually inside your existing Supabase project (**`gandakihub`**).

---

## 1. Before You Run Anything (Pre-Migration Checklist)

1. Open your existing **Supabase Dashboard** -> project **`gandakihub`**.
2. Go to **Database -> Backups** (or export any existing tables via **SQL Editor / `pg_dump`** if you have prior rows).
3. Verify your Postgres version supports `pg_trgm` (enabled cleanly via `CREATE EXTENSION IF NOT EXISTS pg_trgm;`).
4. Prepare a **private** Storage bucket named `gandakihub-private` in **Storage -> Buckets**:
   - **Public bucket:** OFF (Private)
   - **Allowed MIME types (optional):** `application/pdf`, `image/png`, `image/jpeg`, `image/webp`, `image/gif`
   - **Max file size:** `25 MB` (fits PDFs up to 25 MB and images up to 5 MB)

---

## 2. Step-by-Step Schema & Seed Execution (Supabase SQL Editor)

1. Open **Supabase Dashboard -> SQL Editor -> New Query**.
2. Open `/supabase/migrations/002_complete_production_schema.sql` from this repository, copy its full contents, and run it once.
   - Safe & idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`, `DROP TRIGGER IF EXISTS ... CREATE TRIGGER`, and RLS policies on all 49 tables).
   - Creates `user_credentials` (strict `USING (FALSE)` RLS — password hashes never exposed to PostgREST/anon/authenticated keys), `confession_identity_vault` (strict Super Admin isolation), `audit_logs` (append-only protection trigger), `enforce_profile_privilege_guard()` trigger, full-text GIN indexes (`to_tsvector('simple', ...)`), and `pg_trgm` fuzzy search indexes.
3. Run `/supabase/migrations/003_profile_completion_staff_verification.sql` in **SQL Editor -> New Query**:
   - **Zero Data Loss Guarantee:** Purely additive (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`). Contains zero `DROP`, `TRUNCATE`, or `DELETE` statements.
   - Adds optional nullable/defaulted profile completion fields to `profiles` (`department`, `student_id`, `staff_position`, `designation`, `profile_completed`) without altering existing IDs, roles, or credentials.
   - Creates `staff_verification_requests` with strict RLS policies and a partial unique index preventing duplicate pending verification requests.
4. Run `/supabase/seed.sql` in **SQL Editor -> New Query** (skip if structural data is already seeded — `ON CONFLICT DO NOTHING` preserves all edited names):
   - Seeds **only structural academic data**:
     - `programs` (5 programs: `BIT`, `BBA`, `BPH`, `B.Sc.CSIT`, `Civil Engineering`)
     - `semesters` (40 semesters, 8 per program)
     - `subjects` (200 default subjects, editable by Admins/Super Admins)
     - `resource_categories` (7 academic categories)
     - `communities` (11 academic & campus communities)
     - `profanity_dictionary` (baseline English + Devanagari + Romanized Nepali terms)
     - `platform_settings` (`super_admin_initialized = false`)
   - **Zero demo users, posts, confessions, or fake PDFs** are inserted.

---

## 3. Verification Queries (Run in SQL Editor)

Confirm all 50 tables and structural counts exist:

```sql
SELECT count(*) AS table_count
FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE';

SELECT
  (SELECT count(*) FROM public.profiles) AS profiles,
  (SELECT count(*) FROM public.posts) AS posts,
  (SELECT count(*) FROM public.confessions) AS confessions,
  (SELECT count(*) FROM public.programs) AS programs,
  (SELECT count(*) FROM public.semesters) AS semesters,
  (SELECT count(*) FROM public.subjects) AS subjects,
  (SELECT count(*) FROM public.resource_categories) AS categories,
  (SELECT count(*) FROM public.communities) AS communities,
  (SELECT count(*) FROM public.profanity_dictionary) AS profanity_terms;
```

Expected:
- Existing `profiles`, `posts`, and `confessions` counts remain unchanged before and after migration `003`.
- `programs = 5`, `semesters = 40`, `subjects = 200`, `categories = 7`, `communities = 11`.
- Verify RLS is enabled across public tables:

```sql
SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;
```

---

## 4. Migrating Legacy Local SQLite Records (If Applicable)

If you previously ran the local SQLite version (`./data/gandakihub.db`) and have live user accounts, posts, or PDFs on disk to preserve:

1. Export each SQLite table as CSV or JSON using SQLite CLI:
   ```bash
   sqlite3 -header -csv ./data/gandakihub.db "SELECT id, email, username, display_name, bio, role, account_status, program_id, semester_id, email_verified, university_email_verified, external_reason, external_reason_detail, interests, notification_prefs, privacy_settings, created_at, updated_at FROM users;" > profiles_export.csv
   sqlite3 -header -csv ./data/gandakihub.db "SELECT id AS user_id, password_hash FROM users;" > credentials_export.csv
   ```
2. Import into PostgreSQL after running `002_complete_production_schema.sql`:
   - `profiles` receives public/profile fields; `user_credentials` receives `(user_id, password_hash)` so password hashes stay separated from `profiles`.
   - Upload existing `./data/storage/pdfs/*` and `./data/storage/media/*` files into the `gandakihub-private` Supabase Storage bucket preserving keys (`pdfs/...`, `media/...`, `avatars/...`).
3. If starting fresh with zero prior production records, simply run `002_complete_production_schema.sql` and `seed.sql`, then register your `SUPER_ADMIN_EMAIL` (`snikunj769@gmail.com`) via the UI.

---

## 5. Rollback Strategy

- **If a deployment issue occurs on Render/Vercel:** Redeploy the previous Git commit in Render/Vercel dashboards (`Events -> Rollback`) without touching PostgreSQL data.
- **If a schema adjustment must be reversed:** Write a targeted `ALTER TABLE ...` or restore the Supabase daily backup / pre-migration snapshot. Avoid dropping tables (`DROP TABLE`) in production unless intentionally resetting a staging environment.
- **If `super_admin` registration fails or needs resetting before launch:** Inspect `platform_settings` (`key = 'super_admin_initialized'`) and `profiles WHERE role = 'super_admin'` before making any manual update.
