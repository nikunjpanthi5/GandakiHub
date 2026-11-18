# GandakiHub — University Community, Academic Resource Sharing & Student Networking Platform

**Tagline:** *Your University. Your Community. Your Knowledge.*

GandakiHub is an independent, student-developed digital community platform initially built for Gandaki University, Nepal. It organizes academic resources dynamically (`Program -> Semester -> Subject -> Subtopic Folders -> Resource Categories`), provides university-wide and specialized communities, universal full-text search, real-activity trending metrics, private student networking, moderated anonymous confessions, public/private complaints, innovation boards, and an administrative governance console.

> **Disclaimer:** GandakiHub is an independent platform and is not officially owned, operated, approved, or endorsed by Gandaki University.

---

## Core Architecture & Features

- **Authentication & Verification:**
  - University members (`@gandakiuniversity.edu.np`) verify ownership via a 6-digit OTP with resend cooldowns and rate limiting.
  - External participants (Future Students, Parents/Guardians, Visitors, Researchers, Alumni) select an explicit reason for joining (with required explanation for `Other`).
  - Role-Based Access Control enforced server-side across 8 roles: `super_admin`, `admin`, `community_moderator`, `verified_student`, `verified_teacher`, `future_student`, `alumni`, and `visitor`.
- **Dynamic Academic Hierarchy:**
  - Initialized with 5 programs (`BIT`, `BALLB`, `BBA`, `B.Pharm`, `BSM`), 8 semesters each, 5 placeholder subjects per semester (`Subject 1`..`Subject 5`), nested subtopic folders, and 7 resource categories (`Notes`, `Past Questions`, `Projects`, `Assignments`, `Exam Preparation`, `General Discussion`, `Resources`).
  - Administrators can create, rename, reorder, archive, and restore programs, semesters, subjects, folders, and categories without modifying source code.
- **Secure PDF Resource Repository:**
  - Server-side validation checks `.pdf` extension, MIME type, `%PDF-` magic header, PDF object structure, `%%EOF` marker, 10 MB configurable limit, and SHA-256 deduplication.
  - Private file storage served strictly through authorized preview/download endpoints.
  - Moderator review queue and revision workflow (editing an approved resource submits a pending revision while keeping the prior approved PDF live).
- **Universal Search & Real Trends:**
  - SQLite FTS5 full-text search (plus PostgreSQL `pg_trgm`/GIN migration included in `supabase/migrations/`) covering subjects, approved resources, communities, posts, profiles, opportunities, events, study groups, ideas, public confessions, and public feedback.
  - Private complaints, pending drafts, and private connections are never exposed in search.
  - Trending searches and communities are computed from actual database activity.
- **Special Channels & Moderation:**
  - Anonymous Confessions with an isolated `confession_identity_vault` accessible only to Super Admins under mandatory audit logging.
  - Public and Private Complaints & Suggestions.
  - GetIdeas, Student Donations (moderated, no payment holding), Future Students, Opportunities, Events, and Study Groups.
  - Multilingual profanity detection supporting English, Nepali Devanagari, and Romanized Nepali.
- **Private Messaging Status:**
  - Explicitly marked **Currently in Development** with zero plaintext chat storage or fabricated conversations, prepared for future Matrix Olm/Megolm E2EE integration.

---

## Database & Environment Variables

### Database Used
- **Active Runtime Database:** Local **SQLite** via Node.js 22+ built-in `node:sqlite` (`DatabaseSync`) with **FTS5** full-text indexing, stored at `DATABASE_PATH` (`./data/gandakihub.db`). Uploaded PDFs are stored privately outside the web root at `PRIVATE_STORAGE_DIR` (`./storage/private_pdfs`) and served only through authorized API endpoints.
- **Initial Structural Seed Only:** On an empty database, GandakiHub initializes only the structural academic hierarchy (`5` programs, `40` semesters, `200` initial `Subject 1`..`Subject 5` slots, `7` resource categories), `16` core/program communities, baseline multilingual profanity rules, and default `platform_settings`. Zero demo users, posts, or files are seeded.
- **Supabase Migration Artifacts:** For production PostgreSQL + Storage deployment on Supabase/Vercel, see `supabase/migrations/001_initial_schema.sql` and `supabase/seed.sql`.

### Environment Variables
| Variable | Required | How to Get / Configure |
| --- | --- | --- |
| `PORT` / `APP_URL` | Defaults provided | `3000` and `http://localhost:3000` locally (or your deployed HTTPS URL). |
| `SESSION_SECRET` | Recommended | Generate locally with `openssl rand -hex 32` (an ephemeral dev secret is generated if omitted). |
| `DATABASE_PATH` | Optional | Defaults to `./data/gandakihub.db`. |
| `PRIVATE_STORAGE_DIR` | Optional | Defaults to `./storage/private_pdfs`. |
| `MAX_UPLOAD_MB` | Optional | Defaults to `10` (MB per PDF). |
| `SUPER_ADMIN_EMAIL` | Optional | Set to the university email you want auto-promoted to `super_admin` on OTP verification; if omitted, the Sign Up modal lets the first user claim Super Admin once. |
| `RESEND_API_KEY` | Optional (Prod) | Create a free API key at [resend.com](https://resend.com) for real OTP emails. When unset in dev, OTPs print to server logs and the verification UI. |
| `EMAIL_FROM` | With Resend | Verified sender address in Resend (e.g. `GandakiHub <noreply@yourdomain.com>`). |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Optional (Migration only) | From **Supabase Dashboard -> Project Settings -> API** if migrating to Supabase PostgreSQL. |

---

## Local Development & Running

1. **Install dependencies:**
   ```bash
   npm install
   ```
2. **Configure environment (optional for local dev):**
   ```bash
   cp .env.example .env
   ```
3. **Run development server (Express + SQLite + Vite on port 3000):**
   ```bash
   npm run dev
   ```
4. **Run automated tests & typecheck:**
   ```bash
   npm test
   npm run lint
   ```
5. **Production build & start:**
   ```bash
   npm run build
   npm start
   ```

