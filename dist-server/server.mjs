// server.ts
import "dotenv/config";
import fs2 from "node:fs";
import path5 from "node:path";
import express2 from "express";

// server/app.ts
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";

// server/authMiddleware.ts
import crypto2 from "node:crypto";

// server/security.ts
import crypto from "node:crypto";
var UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var EPHEMERAL_DEV_SECRET = crypto.randomBytes(32).toString("hex");
function isUuid(value) {
  return Boolean(value && UUID_REGEX.test(value.trim()));
}
function getSessionSecret() {
  const configured = process.env.SESSION_SECRET?.trim();
  if (process.env.NODE_ENV === "production") {
    if (!configured || configured.length < 32 || configured.includes("change-me")) {
      throw new Error("SESSION_SECRET must be set to a strong random string (at least 32 characters) in production.");
    }
    return configured;
  }
  return configured || EPHEMERAL_DEV_SECRET;
}
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${derived}`;
}
function verifyPassword(password, storedHash) {
  const parts = storedHash.split(":");
  if (parts.length !== 2) return false;
  const [salt, keyHex] = parts;
  const derived = crypto.scryptSync(password, salt, 64);
  const keyBuf = Buffer.from(keyHex, "hex");
  if (derived.length !== keyBuf.length) return false;
  return crypto.timingSafeEqual(derived, keyBuf);
}
function generateSixDigitOtp() {
  return String(crypto.randomInt(1e5, 1e6));
}
function hashToken(raw) {
  return crypto.createHmac("sha256", getSessionSecret()).update(raw).digest("hex");
}
function generateSessionToken() {
  return crypto.randomBytes(32).toString("hex");
}
function isUniversityEmail(email) {
  return /^[^\s@]+@gandakiuniversity\.edu\.np$/i.test(email.trim());
}
function sanitizeFilename(name) {
  const base = name.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/_{2,}/g, "_").replace(/^\.+/, "");
  return base.slice(0, 120) || "document.pdf";
}
function validatePdfBuffer(buffer) {
  if (!buffer || buffer.length < 32) {
    return { valid: false, reason: "File is too small to be a valid PDF document." };
  }
  const headHex = buffer.subarray(0, 8).toString("hex").toLowerCase();
  if (headHex.startsWith("504b0304")) {
    return { valid: false, reason: "ZIP or Office archive detected (e.g. DOCX/PPTX). Only genuine PDF files are allowed." };
  }
  if (headHex.startsWith("4d5a")) {
    return { valid: false, reason: "Executable files are strictly prohibited." };
  }
  if (headHex.startsWith("89504e47") || headHex.startsWith("ffd8ff") || headHex.startsWith("47494638")) {
    return { valid: false, reason: "Image files are not allowed in PDF-only academic categories." };
  }
  if (headHex.startsWith("52617221")) {
    return { valid: false, reason: "RAR archives are not allowed. Upload a genuine PDF file." };
  }
  const header = buffer.subarray(0, 16).toString("ascii");
  if (!/^%PDF-\d\.\d/.test(header)) {
    return { valid: false, reason: "Missing %PDF- header signature. File must be a genuine PDF." };
  }
  const fullAscii = buffer.toString("latin1");
  if (!fullAscii.includes("obj") || !fullAscii.includes("endobj")) {
    return { valid: false, reason: "Invalid PDF internal structure (missing PDF objects)." };
  }
  const tail = buffer.subarray(Math.max(0, buffer.length - 1024)).toString("latin1");
  if (!tail.includes("%%EOF")) {
    return { valid: false, reason: "Truncated or malformed PDF (missing %%EOF marker)." };
  }
  return { valid: true };
}
function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}
function isAdminRole(role) {
  return role === "super_admin" || role === "admin";
}
function isModeratorOrAbove(role) {
  return role === "super_admin" || role === "admin" || role === "community_moderator";
}
function canUploadResources(role) {
  return role === "super_admin" || role === "admin" || role === "community_moderator" || role === "verified_student" || role === "verified_teacher";
}
function canPostInCommunity(role, communityKind, communitySlug) {
  if (role === "visitor") {
    return { allowed: false, reason: "Visitors have read-only access on GandakiHub." };
  }
  if (role === "future_student") {
    if (communitySlug === "future-students") {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: "Future Student accounts can participate in the Future Students community only."
    };
  }
  if (communityKind === "academic" && role === "alumni") {
    return {
      allowed: false,
      reason: "Alumni cannot post in current-semester academic communities."
    };
  }
  return { allowed: true };
}
function canVoteOrComment(role, communityKind, communitySlug) {
  if (role === "visitor") return false;
  if (role === "future_student") {
    return communitySlug === "future-students";
  }
  if (communityKind === "academic" && role === "alumni") {
    return false;
  }
  return true;
}

// server/authMiddleware.ts
async function getAuthUserFromDb(db, userId) {
  if (!isUuid(userId)) return null;
  const row = await db.queryOne(
    `SELECT u.*, uc.email, p.name AS program_name, s.name AS semester_name
     FROM profiles u
     JOIN user_credentials uc ON uc.user_id = u.id
     LEFT JOIN programs p ON p.id = u.program_id
     LEFT JOIN semesters s ON s.id = u.semester_id
     WHERE u.id = $1`,
    [userId]
  );
  if (!row) return null;
  const modRows = await db.query(
    "SELECT community_id FROM community_moderators WHERE user_id = $1",
    [userId]
  );
  let staffVerificationStatus = row.role === "verified_teacher" ? "approved" : "not_requested";
  try {
    const tableCheck = await db.queryOne(
      "SELECT to_regclass('public.staff_verification_requests')::text AS exists"
    );
    if (tableCheck?.exists) {
      const latestReq = await db.queryOne(
        `SELECT status FROM staff_verification_requests
         WHERE user_id = $1
         ORDER BY created_at DESC LIMIT 1`,
        [userId]
      );
      if (row.role === "verified_teacher") {
        staffVerificationStatus = "approved";
      } else if (latestReq?.status === "pending" || latestReq?.status === "approved" || latestReq?.status === "rejected") {
        staffVerificationStatus = latestReq.status;
      }
    }
  } catch {
  }
  const role = row.role;
  const hasAcademic = Boolean(row.program_id && row.semester_id);
  const hasStaffInfo = Boolean(row.staff_position && row.department);
  const hasBio = Boolean(String(row.bio || "").trim().length > 0);
  const hasAvatar = Boolean(row.avatar_url);
  const hasInterests = Array.isArray(row.interests) && row.interests.length > 0;
  const hasDeptOrId = Boolean(row.department || row.student_id);
  let completionPct = 25;
  if (hasAcademic || hasStaffInfo) completionPct += 35;
  else if (row.program_id || hasDeptOrId) completionPct += 15;
  if (hasBio) completionPct += 15;
  if (hasInterests) completionPct += 15;
  if (hasAvatar) completionPct += 10;
  completionPct = Math.min(100, completionPct);
  const profileCompleted = Boolean(row.profile_completed) || hasAcademic || hasStaffInfo || role === "super_admin" || role === "admin" || role === "verified_teacher";
  return {
    id: String(row.id),
    email: String(row.email),
    username: String(row.username),
    display_name: String(row.display_name),
    avatar_url: row.avatar_url ? String(row.avatar_url) : null,
    bio: String(row.bio || ""),
    role,
    email_verified: Boolean(row.email_verified),
    university_email_verified: Boolean(row.university_email_verified),
    external_reason: row.external_reason || null,
    external_reason_detail: row.external_reason_detail ? String(row.external_reason_detail) : null,
    program_id: row.program_id ? String(row.program_id) : null,
    program_name: row.program_name ? String(row.program_name) : null,
    semester_id: row.semester_id ? String(row.semester_id) : null,
    semester_name: row.semester_name ? String(row.semester_name) : null,
    department: row.department ? String(row.department) : null,
    student_id: row.student_id ? String(row.student_id) : null,
    staff_position: row.staff_position ? String(row.staff_position) : null,
    designation: row.designation ? String(row.designation) : null,
    profile_completed: profileCompleted,
    profile_completion_pct: completionPct,
    staff_verification_status: staffVerificationStatus,
    interests: Array.isArray(row.interests) ? row.interests : [],
    notification_prefs: row.notification_prefs || {
      replies: true,
      connections: true,
      resources: true,
      events: true,
      announcements: true
    },
    privacy_settings: row.privacy_settings || {
      show_program: true,
      allow_connection_requests: true
    },
    account_status: row.account_status || "active",
    moderated_community_ids: modRows.map((m) => String(m.community_id)),
    created_at: new Date(String(row.created_at)).toISOString()
  };
}
function attachSessionMiddleware(db, storage) {
  return async (req, _res, next) => {
    try {
      req.db = db;
      req.storage = storage;
      req.user = null;
      const authHeader = req.headers.authorization;
      const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : void 0;
      const rawToken = req.cookies?.gh_session || bearerToken;
      if (!rawToken) return next();
      const tokenHash = hashToken(rawToken);
      const session = await db.queryOne(
        "SELECT user_id, expires_at FROM sessions WHERE token_hash = $1",
        [tokenHash]
      );
      if (!session) return next();
      if (new Date(session.expires_at).getTime() < Date.now()) {
        await db.execute("DELETE FROM sessions WHERE token_hash = $1", [tokenHash]);
        return next();
      }
      const user = await getAuthUserFromDb(db, String(session.user_id));
      if (user && user.account_status === "active") {
        req.user = user;
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
}
function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: "Authentication required. Please sign in." });
  }
  if (req.user.account_status !== "active") {
    return res.status(403).json({ error: "Your account is currently suspended or restricted." });
  }
  return next();
}
function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Authentication required." });
  if (!isAdminRole(req.user.role)) {
    return res.status(403).json({ error: "Administrator privileges required." });
  }
  return next();
}
function requireSuperAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Authentication required." });
  if (req.user.role !== "super_admin") {
    return res.status(403).json({ error: "Super Admin privileges required." });
  }
  return next();
}
function requireModerator(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Authentication required." });
  if (!isModeratorOrAbove(req.user.role)) {
    return res.status(403).json({ error: "Moderator or administrator privileges required." });
  }
  return next();
}
async function checkRateLimit(db, key, maxRequests, windowSeconds) {
  const now = Date.now();
  const row = await db.queryOne(
    "SELECT count, window_expires_at FROM rate_limits WHERE key = $1",
    [key]
  );
  if (!row || new Date(row.window_expires_at).getTime() <= now) {
    const expires = new Date(now + windowSeconds * 1e3).toISOString();
    await db.execute(
      `INSERT INTO rate_limits (key, count, window_expires_at)
       VALUES ($1, 1, $2::timestamptz)
       ON CONFLICT (key) DO UPDATE SET count = 1, window_expires_at = EXCLUDED.window_expires_at`,
      [key, expires]
    );
    return { allowed: true, retryAfterSec: 0 };
  }
  if (Number(row.count) >= maxRequests) {
    const retryAfterSec = Math.max(
      1,
      Math.ceil((new Date(row.window_expires_at).getTime() - now) / 1e3)
    );
    return { allowed: false, retryAfterSec };
  }
  await db.execute("UPDATE rate_limits SET count = count + 1 WHERE key = $1", [key]);
  return { allowed: true, retryAfterSec: 0 };
}
function isHttpsRequest(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  return req.secure || proto === "https" || process.env.NODE_ENV === "production";
}
async function createSessionCookie(db, req, res, userId, rawToken) {
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1e3).toISOString();
  await db.execute(
    "INSERT INTO sessions (id, token_hash, user_id, expires_at, created_at) VALUES ($1, $2, $3, $4::timestamptz, NOW())",
    [crypto2.randomUUID(), tokenHash, userId, expiresAt]
  );
  const isHttps = isHttpsRequest(req);
  res.cookie("gh_session", rawToken, {
    httpOnly: true,
    sameSite: isHttps ? "none" : "lax",
    secure: isHttps,
    path: "/",
    maxAge: 7 * 24 * 3600 * 1e3
  });
}
function clearSessionCookie(req, res) {
  const isHttps = isHttpsRequest(req);
  res.clearCookie("gh_session", {
    httpOnly: true,
    sameSite: isHttps ? "none" : "lax",
    secure: isHttps,
    path: "/"
  });
}

// server/routes/academic.ts
import crypto4 from "node:crypto";
import path2 from "node:path";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";

// server/db.ts
import crypto3 from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
function createPgPoolExecutor(client) {
  return {
    async query(sql, params = []) {
      const result = await client.query(sql, params);
      return result.rows;
    },
    async queryOne(sql, params = []) {
      const result = await client.query(sql, params);
      return result.rows[0] ?? null;
    },
    async execute(sql, params = []) {
      const result = await client.query(sql, params);
      return result.rowCount ?? 0;
    }
  };
}
function createPgPoolDatabase(connectionString) {
  const isLocal = connectionString.includes("localhost") || connectionString.includes("127.0.0.1") || process.env.PGSSLMODE === "disable";
  const pool = new Pool({
    connectionString,
    max: Number(process.env.PG_POOL_MAX || 10),
    idleTimeoutMillis: 3e4,
    connectionTimeoutMillis: 1e4,
    ssl: isLocal ? void 0 : { rejectUnauthorized: false }
  });
  pool.on("error", (err) => {
    console.error("[GandakiHub PG Pool Error]", err.message);
  });
  const rootExec = createPgPoolExecutor(pool);
  return {
    kind: "postgres",
    ...rootExec,
    async transaction(fn, options = {}) {
      const client = await pool.connect();
      const txExec = createPgPoolExecutor(client);
      try {
        await client.query("BEGIN");
        if (options.trustedServer) {
          await client.query("SELECT set_config('app.trusted_server', 'true', true)");
        }
        if (options.actorId) {
          await client.query("SELECT set_config('app.current_user_id', $1, true)", [options.actorId]);
        }
        const out = await fn(txExec);
        await client.query("COMMIT");
        return out;
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch {
        }
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    }
  };
}
function createPGliteDatabase(pg) {
  let txQueue = Promise.resolve();
  function runSerialized(work) {
    const next = txQueue.then(work, work);
    txQueue = next.then(
      () => void 0,
      () => void 0
    );
    return next;
  }
  const exec = {
    async query(sql, params = []) {
      const res = await pg.query(sql, params);
      return res.rows;
    },
    async queryOne(sql, params = []) {
      const res = await pg.query(sql, params);
      return res.rows[0] ?? null;
    },
    async execute(sql, params = []) {
      const res = await pg.query(sql, params);
      return res.affectedRows ?? res.rows.length ?? 0;
    }
  };
  return {
    kind: "pglite",
    ...exec,
    async transaction(fn, options = {}) {
      return runSerialized(async () => {
        await pg.exec("BEGIN");
        try {
          if (options.trustedServer) {
            await pg.query("SELECT set_config('app.trusted_server', 'true', true)");
          }
          if (options.actorId) {
            await pg.query("SELECT set_config('app.current_user_id', $1, true)", [options.actorId]);
          }
          const out = await fn(exec);
          await pg.exec("COMMIT");
          return out;
        } catch (err) {
          try {
            await pg.exec("ROLLBACK");
          } catch {
          }
          throw err;
        }
      });
    },
    async close() {
      await pg.close();
    }
  };
}
var cachedDb = null;
async function initDatabase() {
  if (cachedDb) return cachedDb;
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const isProd = process.env.NODE_ENV === "production";
  if (isProd && !databaseUrl) {
    throw new Error("DATABASE_URL environment variable is required in production (Supabase PostgreSQL connection string).");
  }
  if (databaseUrl) {
    const db2 = createPgPoolDatabase(databaseUrl);
    await db2.queryOne("SELECT 1 AS ok");
    const schemaCheck = await db2.queryOne(
      "SELECT to_regclass('public.profiles')::text AS exists"
    );
    if (!schemaCheck?.exists) {
      throw new Error(
        "PostgreSQL schema is not initialized. Run supabase/migrations/002_complete_production_schema.sql and supabase/seed.sql in your Supabase SQL Editor first."
      );
    }
    cachedDb = db2;
    return db2;
  }
  console.warn(
    "[GandakiHub] DATABASE_URL not set in local dev. Starting embedded local PostgreSQL (PGlite). Set DATABASE_URL for Supabase PostgreSQL."
  );
  const { PGlite } = await import("@electric-sql/pglite");
  const { pg_trgm } = await import("@electric-sql/pglite/contrib/pg_trgm");
  const pgDataDir = process.env.LOCAL_PGDATA_DIR || path.resolve(process.cwd(), "data", "pgdata");
  fs.mkdirSync(path.dirname(pgDataDir), { recursive: true });
  const pglite = new PGlite(pgDataDir, { extensions: { pg_trgm } });
  const migrationFiles = [
    "002_complete_production_schema.sql",
    "003_profile_completion_staff_verification.sql"
  ];
  for (const file of migrationFiles) {
    const filePath = path.resolve(process.cwd(), "supabase", "migrations", file);
    if (fs.existsSync(filePath)) {
      const migrationSql = fs.readFileSync(filePath, "utf8");
      await pglite.exec(migrationSql);
    }
  }
  const db = createPGliteDatabase(pglite);
  cachedDb = db;
  return db;
}
async function writeAuditLog(db, actorId, action, targetType, targetId, metadata = {}) {
  await db.execute(
    `INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, metadata, created_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())`,
    [crypto3.randomUUID(), actorId, action, targetType, targetId, JSON.stringify(metadata)]
  );
}
async function createNotification(db, userId, kind, title, body, linkPath) {
  await db.execute(
    `INSERT INTO notifications (id, user_id, kind, title, body, link_path, is_read, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, FALSE, NOW())`,
    [crypto3.randomUUID(), userId, kind, title, body, linkPath]
  );
}
async function syncModerationQueue(db, entityType, entityId, submittedBy, status, reviewerId = null, notes = null) {
  await db.execute(
    `INSERT INTO moderation_queue (id, entity_type, entity_id, submitted_by, status, reviewer_id, notes, created_at, reviewed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), CASE WHEN $5 = 'pending' THEN NULL ELSE NOW() END)
     ON CONFLICT (entity_type, entity_id) DO UPDATE SET
       status = EXCLUDED.status,
       reviewer_id = EXCLUDED.reviewer_id,
       notes = EXCLUDED.notes,
       reviewed_at = CASE WHEN EXCLUDED.status = 'pending' THEN NULL ELSE NOW() END`,
    [crypto3.randomUUID(), entityType, entityId, submittedBy, status, reviewerId, notes]
  );
}

// server/routes/academic.ts
function createAcademicRouter(db) {
  const router = Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 }
  });
  router.get("/structure", async (req, res, next) => {
    try {
      const includeArchived = req.query.includeArchived === "true";
      const archiveClause = includeArchived ? "" : "WHERE is_archived = FALSE";
      const [programs, semesters, subjects, folders, categories] = await Promise.all([
        db.query(
          `SELECT * FROM programs ${archiveClause} ORDER BY sort_order ASC, code ASC`
        ),
        db.query(
          `SELECT * FROM semesters ${archiveClause} ORDER BY sort_order ASC, number ASC`
        ),
        db.query(
          `SELECT s.*,
            (SELECT COUNT(*) FROM resources r WHERE r.subject_id = s.id AND r.status = 'approved') AS resource_count
           FROM subjects s ${includeArchived ? "" : "WHERE s.is_archived = FALSE"}
           ORDER BY s.sort_order ASC, s.name ASC`
        ),
        db.query(
          `SELECT * FROM academic_folders ${archiveClause} ORDER BY sort_order ASC, name ASC`
        ),
        db.query("SELECT * FROM resource_categories ORDER BY sort_order ASC")
      ]);
      return res.json({
        programs: programs.map((p) => ({ ...p, is_archived: Boolean(p.is_archived) })),
        semesters: semesters.map((s) => ({ ...s, is_archived: Boolean(s.is_archived) })),
        subjects: subjects.map((sub) => ({
          ...sub,
          is_archived: Boolean(sub.is_archived),
          resource_count: Number(sub.resource_count || 0)
        })),
        folders: folders.map((f) => ({ ...f, is_archived: Boolean(f.is_archived) })),
        categories: categories.map((c) => ({ ...c, pdf_only: Boolean(c.pdf_only) }))
      });
    } catch (err) {
      return next(err);
    }
  });
  router.post("/programs", requireAdmin, async (req, res, next) => {
    try {
      const parsed = z.object({
        code: z.string().min(2).max(16),
        name: z.string().min(3).max(120),
        description: z.string().max(400).default("")
      }).safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid program." });
      }
      const code = parsed.data.code.trim().toUpperCase();
      const name = parsed.data.name.trim();
      const description = parsed.data.description.trim();
      const id = crypto4.randomUUID();
      const semNames = [
        "First Semester",
        "Second Semester",
        "Third Semester",
        "Fourth Semester",
        "Fifth Semester",
        "Sixth Semester",
        "Seventh Semester",
        "Eighth Semester"
      ];
      try {
        await db.transaction(async (tx) => {
          const maxRow = await tx.queryOne(
            "SELECT COALESCE(MAX(sort_order), 0) AS m FROM programs"
          );
          const maxOrder = Number(maxRow?.m || 0);
          await tx.execute(
            "INSERT INTO programs (id, code, name, description, sort_order, is_archived, created_at) VALUES ($1, $2, $3, $4, $5, FALSE, NOW())",
            [id, code, name, description, maxOrder + 1]
          );
          for (let idx = 0; idx < semNames.length; idx++) {
            await tx.execute(
              "INSERT INTO semesters (id, program_id, number, name, sort_order, is_archived, created_at) VALUES ($1, $2, $3, $4, $5, FALSE, NOW())",
              [crypto4.randomUUID(), id, idx + 1, semNames[idx], idx + 1]
            );
          }
          await writeAuditLog(tx, req.user.id, "create_program", "program", id, { code, name });
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        if (msg.toLowerCase().includes("unique")) {
          return res.status(409).json({ error: "Program code already exists." });
        }
        throw err;
      }
      return res.status(201).json({ id, code, name, description });
    } catch (err) {
      return next(err);
    }
  });
  router.patch("/programs/:id", requireAdmin, async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: "Program not found." });
      const parsed = z.object({
        code: z.string().min(2).max(16).optional(),
        name: z.string().min(3).max(120).optional(),
        description: z.string().max(400).optional(),
        is_archived: z.boolean().optional()
      }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid program update." });
      const d = parsed.data;
      await db.execute(
        `UPDATE programs SET
          code = COALESCE($1, code),
          name = COALESCE($2, name),
          description = COALESCE($3, description),
          is_archived = COALESCE($4, is_archived)
         WHERE id = $5`,
        [
          d.code?.trim().toUpperCase() ?? null,
          d.name?.trim() ?? null,
          d.description?.trim() ?? null,
          d.is_archived ?? null,
          req.params.id
        ]
      );
      await writeAuditLog(db, req.user.id, "update_program", "program", req.params.id, d);
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });
  router.post("/semesters", requireAdmin, async (req, res, next) => {
    try {
      const parsed = z.object({
        program_id: z.string().min(1),
        number: z.number().int().min(1).max(16),
        name: z.string().min(2).max(60)
      }).safeParse(req.body);
      if (!parsed.success || !isUuid(parsed.data.program_id)) {
        return res.status(400).json({ error: "Invalid semester fields." });
      }
      const id = crypto4.randomUUID();
      try {
        await db.execute(
          "INSERT INTO semesters (id, program_id, number, name, sort_order, is_archived, created_at) VALUES ($1, $2, $3, $4, $5, FALSE, NOW())",
          [id, parsed.data.program_id, parsed.data.number, parsed.data.name.trim(), parsed.data.number]
        );
      } catch {
        return res.status(409).json({ error: "Semester number already exists for this program." });
      }
      await writeAuditLog(db, req.user.id, "create_semester", "semester", id, parsed.data);
      return res.status(201).json({ id, ...parsed.data });
    } catch (err) {
      return next(err);
    }
  });
  router.patch("/semesters/:id", requireAdmin, async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: "Semester not found." });
      const parsed = z.object({
        name: z.string().min(2).max(60).optional(),
        is_archived: z.boolean().optional()
      }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid semester update." });
      const d = parsed.data;
      await db.execute(
        `UPDATE semesters SET
          name = COALESCE($1, name),
          is_archived = COALESCE($2, is_archived)
         WHERE id = $3`,
        [d.name?.trim() ?? null, d.is_archived ?? null, req.params.id]
      );
      await writeAuditLog(db, req.user.id, "update_semester", "semester", req.params.id, d);
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });
  router.post("/subjects", requireAdmin, async (req, res, next) => {
    try {
      const parsed = z.object({
        program_id: z.string().min(1),
        semester_id: z.string().min(1),
        code: z.string().max(24).default(""),
        name: z.string().min(2).max(120),
        description: z.string().max(400).default("")
      }).safeParse(req.body);
      if (!parsed.success || !isUuid(parsed.data.program_id) || !isUuid(parsed.data.semester_id)) {
        return res.status(400).json({ error: "Invalid subject fields." });
      }
      const maxRow = await db.queryOne(
        "SELECT COALESCE(MAX(sort_order), 0) AS m FROM subjects WHERE semester_id = $1",
        [parsed.data.semester_id]
      );
      const maxOrder = Number(maxRow?.m || 0);
      const id = crypto4.randomUUID();
      await db.execute(
        "INSERT INTO subjects (id, program_id, semester_id, code, name, description, sort_order, is_archived, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, NOW())",
        [
          id,
          parsed.data.program_id,
          parsed.data.semester_id,
          parsed.data.code.trim(),
          parsed.data.name.trim(),
          parsed.data.description.trim(),
          maxOrder + 1
        ]
      );
      await writeAuditLog(db, req.user.id, "create_subject", "subject", id, parsed.data);
      return res.status(201).json({ id, ...parsed.data, sort_order: maxOrder + 1, is_archived: false });
    } catch (err) {
      return next(err);
    }
  });
  router.patch("/subjects/:id", requireAdmin, async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: "Subject not found." });
      const parsed = z.object({
        name: z.string().min(2).max(120).optional(),
        code: z.string().max(24).optional(),
        description: z.string().max(400).optional(),
        sort_order: z.number().int().min(0).optional(),
        is_archived: z.boolean().optional()
      }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid subject update." });
      const d = parsed.data;
      await db.execute(
        `UPDATE subjects SET
          name = COALESCE($1, name),
          code = COALESCE($2, code),
          description = COALESCE($3, description),
          sort_order = COALESCE($4, sort_order),
          is_archived = COALESCE($5, is_archived)
         WHERE id = $6`,
        [
          d.name?.trim() ?? null,
          d.code?.trim() ?? null,
          d.description?.trim() ?? null,
          d.sort_order ?? null,
          d.is_archived ?? null,
          req.params.id
        ]
      );
      await writeAuditLog(db, req.user.id, "update_subject", "subject", req.params.id, d);
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });
  router.post("/folders", requireAdmin, async (req, res, next) => {
    try {
      const parsed = z.object({
        subject_id: z.string().min(1),
        parent_folder_id: z.string().nullable().optional(),
        name: z.string().min(2).max(100)
      }).safeParse(req.body);
      if (!parsed.success || !isUuid(parsed.data.subject_id)) {
        return res.status(400).json({ error: "Invalid folder fields." });
      }
      const id = crypto4.randomUUID();
      const maxRow = await db.queryOne(
        "SELECT COALESCE(MAX(sort_order), 0) AS m FROM academic_folders WHERE subject_id = $1",
        [parsed.data.subject_id]
      );
      const maxOrder = Number(maxRow?.m || 0);
      await db.execute(
        "INSERT INTO academic_folders (id, subject_id, parent_folder_id, name, sort_order, is_archived, created_at) VALUES ($1, $2, $3, $4, $5, FALSE, NOW())",
        [
          id,
          parsed.data.subject_id,
          isUuid(parsed.data.parent_folder_id) ? parsed.data.parent_folder_id : null,
          parsed.data.name.trim(),
          maxOrder + 1
        ]
      );
      await writeAuditLog(db, req.user.id, "create_folder", "academic_folder", id, parsed.data);
      return res.status(201).json({ id, ...parsed.data });
    } catch (err) {
      return next(err);
    }
  });
  router.patch("/folders/:id", requireAdmin, async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: "Folder not found." });
      const parsed = z.object({
        name: z.string().min(2).max(100).optional(),
        sort_order: z.number().int().min(0).optional(),
        is_archived: z.boolean().optional()
      }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid folder update." });
      const d = parsed.data;
      await db.execute(
        `UPDATE academic_folders SET
          name = COALESCE($1, name),
          sort_order = COALESCE($2, sort_order),
          is_archived = COALESCE($3, is_archived)
         WHERE id = $4`,
        [d.name?.trim() ?? null, d.sort_order ?? null, d.is_archived ?? null, req.params.id]
      );
      await writeAuditLog(db, req.user.id, "update_folder", "academic_folder", req.params.id, d);
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });
  router.post("/categories", requireAdmin, async (req, res, next) => {
    try {
      const parsed = z.object({
        name: z.string().min(2).max(60),
        description: z.string().max(200).default(""),
        pdf_only: z.boolean().default(true)
      }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid category." });
      const slug = parsed.data.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const id = crypto4.randomUUID();
      const maxRow = await db.queryOne(
        "SELECT COALESCE(MAX(sort_order), 0) AS m FROM resource_categories"
      );
      await db.execute(
        "INSERT INTO resource_categories (id, slug, name, description, pdf_only, sort_order) VALUES ($1, $2, $3, $4, $5, $6)",
        [id, slug, parsed.data.name.trim(), parsed.data.description.trim(), parsed.data.pdf_only, Number(maxRow?.m || 0) + 1]
      );
      await writeAuditLog(db, req.user.id, "create_category", "resource_category", id, parsed.data);
      return res.status(201).json({ id, slug, ...parsed.data });
    } catch (err) {
      return next(err);
    }
  });
  router.patch("/categories/:id", requireAdmin, async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: "Category not found." });
      const parsed = z.object({
        name: z.string().min(2).max(60).optional(),
        description: z.string().max(200).optional()
      }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid category update." });
      await db.execute(
        "UPDATE resource_categories SET name = COALESCE($1, name), description = COALESCE($2, description) WHERE id = $3",
        [parsed.data.name?.trim() ?? null, parsed.data.description?.trim() ?? null, req.params.id]
      );
      await writeAuditLog(db, req.user.id, "update_category", "resource_category", req.params.id, parsed.data);
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });
  router.get("/resources", async (req, res, next) => {
    try {
      const { program_id, semester_id, subject_id, category_id, folder_id, sort, mine, status } = req.query;
      const viewerId = req.user?.id || null;
      const isMod = req.user ? isModeratorOrAbove(req.user.role) : false;
      const conditions = [];
      const params = [viewerId];
      const addParam = (val) => {
        params.push(val);
        return `$${params.length}`;
      };
      if (mine === "true" && req.user) {
        conditions.push(`r.uploader_id = ${addParam(req.user.id)}`);
      } else if (status && isMod) {
        conditions.push(`r.status = ${addParam(status)}`);
      } else if (viewerId) {
        conditions.push(`(r.status = 'approved' OR r.uploader_id = ${addParam(viewerId)})`);
      } else {
        conditions.push("r.status = 'approved'");
      }
      if (isUuid(program_id)) conditions.push(`r.program_id = ${addParam(program_id)}`);
      if (isUuid(semester_id)) conditions.push(`r.semester_id = ${addParam(semester_id)}`);
      if (isUuid(subject_id)) conditions.push(`r.subject_id = ${addParam(subject_id)}`);
      if (isUuid(category_id)) conditions.push(`r.category_id = ${addParam(category_id)}`);
      if (isUuid(folder_id)) conditions.push(`r.folder_id = ${addParam(folder_id)}`);
      let orderBy = "r.created_at DESC";
      if (sort === "downloads") orderBy = "r.download_count DESC, r.created_at DESC";
      else if (sort === "upvotes") orderBy = "r.upvote_count DESC, r.created_at DESC";
      const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const rows = await db.query(
        `SELECT r.*,
                rc.name AS category_name, rc.slug AS category_slug,
                p.code AS program_code, p.name AS program_name,
                sem.name AS semester_name,
                sub.name AS subject_name,
                f.name AS folder_name,
                u.display_name AS uploader_name, u.username AS uploader_username, u.role AS uploader_role,
                COALESCE(rev_cur.revision_number, rev_latest.revision_number, 1) AS revision_number,
                COALESCE(rev_cur.file_size, rev_latest.file_size, 0) AS file_size,
                COALESCE(rev_cur.original_filename, rev_latest.original_filename, 'document.pdf') AS original_filename,
                (SELECT value FROM votes v WHERE v.user_id = $1 AND v.target_type = 'resource' AND v.target_id = r.id) AS user_vote,
                (SELECT 1 FROM bookmarks b WHERE b.user_id = $1 AND b.target_type = 'resource' AND b.target_id = r.id) AS is_bookmarked,
                (SELECT COUNT(*) FROM resource_revisions rr WHERE rr.resource_id = r.id AND rr.status = 'pending') AS pending_rev_count
         FROM resources r
         JOIN resource_categories rc ON rc.id = r.category_id
         JOIN programs p ON p.id = r.program_id
         JOIN semesters sem ON sem.id = r.semester_id
         JOIN subjects sub ON sub.id = r.subject_id
         LEFT JOIN academic_folders f ON f.id = r.folder_id
         JOIN profiles u ON u.id = r.uploader_id
         LEFT JOIN resource_revisions rev_cur ON rev_cur.id = r.current_revision_id
         LEFT JOIN LATERAL (
           SELECT revision_number, file_size, original_filename
           FROM resource_revisions
           WHERE resource_id = r.id
           ORDER BY revision_number DESC LIMIT 1
         ) rev_latest ON TRUE
         ${whereSql}
         ORDER BY ${orderBy}
         LIMIT 100`,
        params
      );
      const formatted = rows.map((r) => ({
        ...r,
        download_count: Number(r.download_count || 0),
        upvote_count: Number(r.upvote_count || 0),
        revision_number: Number(r.revision_number || 1),
        file_size: Number(r.file_size || 0),
        user_vote: Number(r.user_vote || 0),
        is_bookmarked: Boolean(r.is_bookmarked),
        has_pending_revision: Number(r.pending_rev_count || 0) > 0
      }));
      return res.json({ resources: formatted });
    } catch (err) {
      return next(err);
    }
  });
  router.post("/resources", requireAuth, upload.single("file"), async (req, res, next) => {
    try {
      const user = req.user;
      if (!canUploadResources(user.role)) {
        return res.status(403).json({ error: "Only verified university students, teachers, moderators, or admins can upload academic resources." });
      }
      const parsed = z.object({
        title: z.string().min(4, "Enter a meaningful document title (at least 4 characters).").max(180),
        description: z.string().min(5).max(1e3),
        category_id: z.string().min(1),
        program_id: z.string().min(1),
        semester_id: z.string().min(1),
        subject_id: z.string().min(1),
        folder_id: z.string().optional().nullable(),
        academic_year: z.string().min(4).max(20)
      }).safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || "All required hierarchy and document fields must be filled." });
      }
      if (!isUuid(parsed.data.category_id) || !isUuid(parsed.data.program_id) || !isUuid(parsed.data.semester_id) || !isUuid(parsed.data.subject_id)) {
        return res.status(400).json({ error: "Invalid academic hierarchy selection." });
      }
      if (!req.file) {
        return res.status(400).json({ error: "Please attach a PDF document." });
      }
      const maxMbSetting = await db.queryOne(
        "SELECT value FROM platform_settings WHERE key = 'max_upload_mb'"
      );
      const maxBytes = Number(maxMbSetting?.value || 10) * 1024 * 1024;
      if (req.file.size > maxBytes) {
        return res.status(413).json({ error: `File exceeds maximum allowed upload size of ${maxBytes / (1024 * 1024)} MB.` });
      }
      const ext = path2.extname(req.file.originalname).toLowerCase();
      if (ext !== ".pdf") {
        return res.status(400).json({ error: "Only .pdf files are accepted for academic resource uploads." });
      }
      if (req.file.mimetype !== "application/pdf" && req.file.mimetype !== "application/x-pdf") {
        return res.status(400).json({ error: `Rejected invalid MIME type (${req.file.mimetype}). Only application/pdf is permitted.` });
      }
      const pdfCheck = validatePdfBuffer(req.file.buffer);
      if (!pdfCheck.valid) {
        return res.status(400).json({ error: pdfCheck.reason || "Invalid PDF document." });
      }
      const subj = await db.queryOne(
        "SELECT id, program_id, semester_id FROM subjects WHERE id = $1 AND is_archived = FALSE",
        [parsed.data.subject_id]
      );
      if (!subj || subj.program_id !== parsed.data.program_id || subj.semester_id !== parsed.data.semester_id) {
        return res.status(400).json({ error: "Selected subject does not belong to the selected program and semester." });
      }
      const hash = sha256Buffer(req.file.buffer);
      const duplicate = await db.queryOne(
        `SELECT r.title FROM resource_revisions rev
         JOIN resources r ON r.id = rev.resource_id
         WHERE rev.sha256_hash = $1 AND r.subject_id = $2 AND r.status <> 'rejected' LIMIT 1`,
        [hash, parsed.data.subject_id]
      );
      if (duplicate) {
        return res.status(409).json({
          error: `Duplicate PDF detected for this subject ("${duplicate.title}" has identical file content).`
        });
      }
      const resourceId = crypto4.randomUUID();
      const revId = crypto4.randomUUID();
      const safeName = sanitizeFilename(req.file.originalname);
      const objectPath = `pdfs/${resourceId}/${revId}_${safeName}`;
      await req.storage.uploadPrivate(objectPath, req.file.buffer, "application/pdf");
      const autoApprove = isAdminRole(user.role);
      const initialStatus = autoApprove ? "approved" : "pending";
      try {
        await db.transaction(async (tx) => {
          await tx.execute(
            `INSERT INTO resources (id, title, description, category_id, program_id, semester_id, subject_id, folder_id, academic_year, uploader_id, status, current_revision_id, download_count, upvote_count, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 0, 0, NOW(), NOW())`,
            [
              resourceId,
              parsed.data.title.trim(),
              parsed.data.description.trim(),
              parsed.data.category_id,
              parsed.data.program_id,
              parsed.data.semester_id,
              parsed.data.subject_id,
              isUuid(parsed.data.folder_id) ? parsed.data.folder_id : null,
              parsed.data.academic_year.trim(),
              user.id,
              initialStatus,
              autoApprove ? revId : null
            ]
          );
          await tx.execute(
            `INSERT INTO resource_revisions (id, resource_id, revision_number, storage_object_path, original_filename, sanitized_filename, file_size, sha256_hash, mime_type, extracted_text, status, reviewer_id, review_notes, created_at)
             VALUES ($1, $2, 1, $3, $4, $5, $6, $7, 'application/pdf', '', $8, $9, $10, NOW())`,
            [
              revId,
              resourceId,
              objectPath,
              req.file.originalname,
              safeName,
              req.file.size,
              hash,
              initialStatus,
              autoApprove ? user.id : null,
              autoApprove ? "Published directly by administrator." : null
            ]
          );
          await syncModerationQueue(
            tx,
            "resource",
            resourceId,
            user.id,
            initialStatus,
            autoApprove ? user.id : null,
            autoApprove ? "Published directly by administrator." : null
          );
          await writeAuditLog(tx, user.id, "upload_resource", "resource", resourceId, {
            status: initialStatus,
            file_size: req.file.size
          });
        });
      } catch (err) {
        await req.storage.deletePrivate(objectPath).catch(() => {
        });
        throw err;
      }
      return res.status(201).json({
        id: resourceId,
        status: initialStatus,
        message: autoApprove ? "Resource uploaded and published." : "Resource uploaded and submitted to the moderator review queue."
      });
    } catch (err) {
      return next(err);
    }
  });
  router.put("/resources/:id", requireAuth, upload.single("file"), async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: "Resource not found." });
      const user = req.user;
      const resource = await db.queryOne(
        "SELECT * FROM resources WHERE id = $1",
        [req.params.id]
      );
      if (!resource) return res.status(404).json({ error: "Resource not found." });
      if (String(resource.uploader_id) !== user.id && !isAdminRole(user.role)) {
        return res.status(403).json({ error: "You may only edit your own uploaded resources." });
      }
      const parsed = z.object({
        title: z.string().min(4).max(180).optional(),
        description: z.string().min(5).max(1e3).optional(),
        academic_year: z.string().min(4).max(20).optional()
      }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid edit fields." });
      const isApproved = String(resource.status) === "approved";
      let uploadedPath = null;
      if (req.file) {
        const ext = path2.extname(req.file.originalname).toLowerCase();
        if (ext !== ".pdf") return res.status(400).json({ error: "Replacement file must be a PDF." });
        const pdfCheck = validatePdfBuffer(req.file.buffer);
        if (!pdfCheck.valid) return res.status(400).json({ error: pdfCheck.reason || "Invalid PDF file." });
        const revId = crypto4.randomUUID();
        const safeName = sanitizeFilename(req.file.originalname);
        uploadedPath = `pdfs/${req.params.id}/${revId}_${safeName}`;
        await req.storage.uploadPrivate(uploadedPath, req.file.buffer, "application/pdf");
        try {
          await db.transaction(async (tx) => {
            const maxRow = await tx.queryOne(
              "SELECT COALESCE(MAX(revision_number), 0) AS m FROM resource_revisions WHERE resource_id = $1",
              [req.params.id]
            );
            const newRevStatus = isAdminRole(user.role) ? "approved" : "pending";
            await tx.execute(
              `INSERT INTO resource_revisions (id, resource_id, revision_number, storage_object_path, original_filename, sanitized_filename, file_size, sha256_hash, mime_type, extracted_text, status, reviewer_id, created_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'application/pdf', '', $9, $10, NOW())`,
              [
                revId,
                req.params.id,
                Number(maxRow?.m || 0) + 1,
                uploadedPath,
                req.file.originalname,
                safeName,
                req.file.size,
                sha256Buffer(req.file.buffer),
                newRevStatus,
                newRevStatus === "approved" ? user.id : null
              ]
            );
            if (newRevStatus === "approved") {
              await tx.execute("UPDATE resources SET current_revision_id = $1, updated_at = NOW() WHERE id = $2", [
                revId,
                req.params.id
              ]);
            }
            await syncModerationQueue(tx, "resource", req.params.id, String(resource.uploader_id), newRevStatus);
          });
        } catch (err) {
          if (uploadedPath) await req.storage.deletePrivate(uploadedPath).catch(() => {
          });
          throw err;
        }
      }
      if (isApproved && !isAdminRole(user.role) && !req.file) {
        await db.transaction(async (tx) => {
          const curRev = await tx.queryOne(
            "SELECT * FROM resource_revisions WHERE id = $1",
            [String(resource.current_revision_id)]
          );
          if (curRev) {
            const maxRow = await tx.queryOne(
              "SELECT COALESCE(MAX(revision_number), 0) AS m FROM resource_revisions WHERE resource_id = $1",
              [req.params.id]
            );
            await tx.execute(
              `INSERT INTO resource_revisions (id, resource_id, revision_number, storage_object_path, original_filename, sanitized_filename, file_size, sha256_hash, mime_type, extracted_text, status, review_notes, created_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'application/pdf', '', 'pending', $9, NOW())`,
              [
                crypto4.randomUUID(),
                req.params.id,
                Number(maxRow?.m || 0) + 1,
                String(curRev.storage_object_path),
                String(curRev.original_filename),
                String(curRev.sanitized_filename),
                Number(curRev.file_size),
                String(curRev.sha256_hash),
                JSON.stringify({
                  pending_title: parsed.data.title,
                  pending_description: parsed.data.description
                })
              ]
            );
            await syncModerationQueue(tx, "resource", req.params.id, String(resource.uploader_id), "pending");
          }
        });
        return res.json({
          ok: true,
          pendingReview: true,
          message: "Edit submitted as a pending revision. The previously approved version remains live until reviewed."
        });
      }
      await db.execute(
        `UPDATE resources SET
          title = COALESCE($1, title),
          description = COALESCE($2, description),
          academic_year = COALESCE($3, academic_year),
          updated_at = NOW()
         WHERE id = $4`,
        [
          parsed.data.title?.trim() ?? null,
          parsed.data.description?.trim() ?? null,
          parsed.data.academic_year?.trim() ?? null,
          req.params.id
        ]
      );
      return res.json({ ok: true, message: "Resource updated." });
    } catch (err) {
      return next(err);
    }
  });
  router.delete("/resources/:id", requireAuth, async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: "Resource not found." });
      const resource = await db.queryOne(
        "SELECT * FROM resources WHERE id = $1",
        [req.params.id]
      );
      if (!resource) return res.status(404).json({ error: "Resource not found." });
      if (String(resource.uploader_id) !== req.user.id && !isAdminRole(req.user.role)) {
        return res.status(403).json({ error: "Only the resource uploader or an administrator can delete this resource." });
      }
      const revisions = await db.query(
        "SELECT storage_object_path FROM resource_revisions WHERE resource_id = $1",
        [req.params.id]
      );
      await db.transaction(async (tx) => {
        await tx.execute("DELETE FROM resources WHERE id = $1", [req.params.id]);
        await tx.execute("DELETE FROM moderation_queue WHERE entity_type = 'resource' AND entity_id = $1", [req.params.id]);
        await writeAuditLog(tx, req.user.id, "delete_resource", "resource", req.params.id, {});
      });
      for (const rev of revisions) {
        await req.storage.deletePrivate(String(rev.storage_object_path)).catch(() => {
        });
      }
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });
  async function resolveAuthorizedRevision(req) {
    if (!isUuid(req.params.id)) return { errorStatus: 404, error: "Resource not found." };
    const resource = await db.queryOne(
      "SELECT * FROM resources WHERE id = $1",
      [req.params.id]
    );
    if (!resource) return { errorStatus: 404, error: "Resource not found." };
    const isOwner = req.user?.id === String(resource.uploader_id);
    const isMod = req.user ? isModeratorOrAbove(req.user.role) : false;
    if (String(resource.status) !== "approved" && !isOwner && !isMod) {
      return {
        errorStatus: 403,
        error: "Unauthorized: pending or rejected resources cannot be downloaded publicly."
      };
    }
    const requestedRevId = req.query.revisionId ? String(req.query.revisionId) : "";
    const revId = isUuid(requestedRevId) ? requestedRevId : isUuid(String(resource.current_revision_id || "")) ? String(resource.current_revision_id) : "";
    let rev = revId ? await db.queryOne(
      "SELECT * FROM resource_revisions WHERE id = $1 AND resource_id = $2",
      [revId, req.params.id]
    ) : null;
    if (!rev) {
      rev = await db.queryOne(
        "SELECT * FROM resource_revisions WHERE resource_id = $1 ORDER BY revision_number DESC LIMIT 1",
        [req.params.id]
      );
    }
    if (!rev) return { errorStatus: 404, error: "Revision file not found." };
    return { resource, rev };
  }
  router.get("/resources/:id/signed-url", async (req, res, next) => {
    try {
      const resolved = await resolveAuthorizedRevision(req);
      if ("error" in resolved) {
        return res.status(resolved.errorStatus ?? 400).json({ error: resolved.error });
      }
      const { resource, rev } = resolved;
      const filename = sanitizeFilename(String(rev.original_filename));
      const signedUrl = await req.storage.createSignedUrl(
        String(rev.storage_object_path),
        60,
        req.query.download === "1" ? filename : void 0
      );
      if (!signedUrl) {
        return res.status(404).json({ error: "Stored PDF file could not be located." });
      }
      if (req.query.download === "1" && String(resource.status) === "approved") {
        await db.execute("UPDATE resources SET download_count = download_count + 1 WHERE id = $1", [req.params.id]);
        await db.execute("INSERT INTO resource_downloads (id, resource_id, user_id, created_at) VALUES ($1, $2, $3, NOW())", [
          crypto4.randomUUID(),
          req.params.id,
          req.user?.id ?? null
        ]);
      }
      return res.json({ url: signedUrl, expires_in: 60, filename });
    } catch (err) {
      return next(err);
    }
  });
  router.get("/resources/:id/file", async (req, res, next) => {
    try {
      const resolved = await resolveAuthorizedRevision(req);
      if ("error" in resolved) {
        return res.status(resolved.errorStatus ?? 400).json({ error: resolved.error });
      }
      const { resource, rev } = resolved;
      const filename = sanitizeFilename(String(rev.original_filename));
      if (req.query.mode === "url") {
        const signedUrl = await req.storage.createSignedUrl(
          String(rev.storage_object_path),
          60,
          req.query.download === "1" ? filename : void 0
        );
        if (!signedUrl) {
          return res.status(404).json({ error: "Stored PDF file could not be located." });
        }
        return res.json({ url: signedUrl, expires_in: 60, filename });
      }
      const fileBuffer = await req.storage.downloadPrivate(String(rev.storage_object_path));
      if (!fileBuffer) {
        return res.status(404).json({ error: "Stored PDF file could not be located." });
      }
      const mode = req.query.download === "1" ? "attachment" : "inline";
      if (req.query.download === "1" && String(resource.status) === "approved") {
        await db.execute("UPDATE resources SET download_count = download_count + 1 WHERE id = $1", [req.params.id]);
        await db.execute("INSERT INTO resource_downloads (id, resource_id, user_id, created_at) VALUES ($1, $2, $3, NOW())", [
          crypto4.randomUUID(),
          req.params.id,
          req.user?.id ?? null
        ]);
      }
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `${mode}; filename="${filename}"`);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "private, no-store");
      return res.send(fileBuffer);
    } catch (err) {
      return next(err);
    }
  });
  router.get("/resources/:id/revisions", async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: "Resource not found." });
      const resource = await db.queryOne(
        "SELECT * FROM resources WHERE id = $1",
        [req.params.id]
      );
      if (!resource) return res.status(404).json({ error: "Resource not found." });
      const isOwner = req.user?.id === String(resource.uploader_id);
      const isMod = req.user ? isModeratorOrAbove(req.user.role) : false;
      const revisions = await db.query(
        `SELECT rr.id, rr.resource_id, rr.revision_number, rr.original_filename, rr.file_size, rr.sha256_hash, rr.status, rr.reviewer_id, rr.review_notes, rr.created_at,
                u.display_name AS reviewer_name
         FROM resource_revisions rr
         LEFT JOIN profiles u ON u.id = rr.reviewer_id
         WHERE rr.resource_id = $1 ${isOwner || isMod ? "" : "AND rr.status = 'approved'"}
         ORDER BY rr.revision_number DESC`,
        [req.params.id]
      );
      return res.json({ revisions });
    } catch (err) {
      return next(err);
    }
  });
  router.post("/resources/:id/review", requireModerator, async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: "Resource not found." });
      const parsed = z.object({
        decision: z.enum(["approved", "rejected", "changes_requested"]),
        revision_id: z.string().optional(),
        review_notes: z.string().max(500).default("")
      }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid review decision." });
      const resource = await db.queryOne(
        "SELECT * FROM resources WHERE id = $1",
        [req.params.id]
      );
      if (!resource) return res.status(404).json({ error: "Resource not found." });
      if (String(resource.uploader_id) === req.user.id) {
        return res.status(403).json({
          error: "Users cannot approve or review their own uploaded resources."
        });
      }
      const targetRev = isUuid(parsed.data.revision_id) ? await db.queryOne(
        "SELECT * FROM resource_revisions WHERE id = $1 AND resource_id = $2",
        [parsed.data.revision_id, req.params.id]
      ) : await db.queryOne(
        "SELECT * FROM resource_revisions WHERE resource_id = $1 ORDER BY revision_number DESC LIMIT 1",
        [req.params.id]
      );
      if (!targetRev) return res.status(404).json({ error: "Revision not found." });
      await db.transaction(async (tx) => {
        await tx.execute(
          "UPDATE resource_revisions SET status = $1, reviewer_id = $2, review_notes = $3 WHERE id = $4",
          [
            parsed.data.decision,
            req.user.id,
            parsed.data.review_notes.trim() || null,
            String(targetRev.id)
          ]
        );
        if (parsed.data.decision === "approved") {
          await tx.execute(
            "UPDATE resources SET status = 'approved', current_revision_id = $1, updated_at = NOW() WHERE id = $2",
            [String(targetRev.id), req.params.id]
          );
        } else if (!resource.current_revision_id) {
          await tx.execute("UPDATE resources SET status = $1, updated_at = NOW() WHERE id = $2", [
            parsed.data.decision,
            req.params.id
          ]);
        }
        await syncModerationQueue(
          tx,
          "resource",
          req.params.id,
          String(resource.uploader_id),
          parsed.data.decision,
          req.user.id,
          parsed.data.review_notes.trim() || null
        );
        await createNotification(
          tx,
          String(resource.uploader_id),
          `resource_${parsed.data.decision}`,
          `Resource ${parsed.data.decision.replace("_", " ")}`,
          `"${resource.title}" was reviewed: ${parsed.data.review_notes || parsed.data.decision}.`,
          "/academic"
        );
        await writeAuditLog(tx, req.user.id, "review_resource", "resource", req.params.id, {
          decision: parsed.data.decision,
          revision_id: targetRev.id
        });
      });
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });
  return router;
}

// server/routes/admin.ts
import crypto5 from "node:crypto";
import { Router as Router2 } from "express";
import { z as z2 } from "zod";

// server/profanity.ts
var LEET_MAP = {
  "0": "o",
  "1": "i",
  "!": "i",
  "3": "e",
  "4": "a",
  "@": "a",
  "5": "s",
  "$": "s",
  "7": "t",
  "8": "b"
};
function normalizeForModeration(input) {
  const nfkc = input.normalize("NFKC").toLowerCase();
  const noZeroWidth = nfkc.replace(/[\u200B-\u200D\uFEFF\u00AD]/g, "");
  let mapped = "";
  for (const ch of noZeroWidth) {
    mapped += LEET_MAP[ch] ?? ch;
  }
  const collapsed = mapped.replace(/(.)\1{2,}/g, "$1$1");
  return collapsed;
}
function normalizeDictionaryTerm(term) {
  return normalizeForModeration(term).replace(/[^a-z0-9\u0900-\u097F\s]/g, "").trim();
}
function checkTextAgainstDictionary(text, rules) {
  const normalized = normalizeForModeration(text);
  const tokens = normalized.split(/[\s,.;:!?()[\]{}"'`~\\/|<>-]+/).filter(Boolean);
  const compactTokens = tokens.map((t) => t.replace(/(.)\1+/g, "$1"));
  const joinedStripped = normalized.replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ");
  const matches = [];
  for (const rule of rules) {
    const normTerm = rule.normalized_term;
    if (!normTerm) continue;
    const compactTerm = normTerm.replace(/(.)\1+/g, "$1");
    let matched = false;
    if (normTerm.includes(" ")) {
      matched = joinedStripped.includes(normTerm);
    } else {
      matched = tokens.includes(normTerm) || compactTokens.includes(compactTerm) || rule.language === "ne_devanagari" && normalized.includes(normTerm);
    }
    if (matched) {
      matches.push({
        term: rule.term,
        severity: rule.severity,
        language: rule.language
      });
    }
  }
  const blocked = matches.some((m) => m.severity === "high");
  return {
    flagged: matches.length > 0,
    blocked,
    matches
  };
}

// server/routes/admin.ts
function createAdminRouter(db) {
  const router = Router2();
  router.get("/overview", requireModerator, async (_req, res, next) => {
    try {
      const countQuery = async (sql) => {
        const r = await db.queryOne(sql);
        return Number(r?.cnt || 0);
      };
      const [
        total_users,
        verified_students,
        verified_teachers,
        active_users,
        total_communities,
        total_posts,
        total_resources,
        pending_resources_new,
        pending_resources_revs,
        pending_confessions,
        pending_complaints,
        open_reports,
        pendingResources,
        pendingConfessions,
        pendingOpportunities,
        pendingDonations,
        openReports
      ] = await Promise.all([
        countQuery("SELECT COUNT(*) AS cnt FROM profiles"),
        countQuery("SELECT COUNT(*) AS cnt FROM profiles WHERE role = 'verified_student' AND university_email_verified = TRUE"),
        countQuery("SELECT COUNT(*) AS cnt FROM profiles WHERE role = 'verified_teacher' AND university_email_verified = TRUE"),
        countQuery("SELECT COUNT(*) AS cnt FROM profiles WHERE account_status = 'active'"),
        countQuery("SELECT COUNT(*) AS cnt FROM communities WHERE is_archived = FALSE"),
        countQuery("SELECT COUNT(*) AS cnt FROM posts WHERE is_hidden = FALSE"),
        countQuery("SELECT COUNT(*) AS cnt FROM resources WHERE status = 'approved'"),
        countQuery("SELECT COUNT(*) AS cnt FROM resources WHERE status = 'pending'"),
        countQuery("SELECT COUNT(*) AS cnt FROM resource_revisions WHERE status = 'pending' AND resource_id IN (SELECT id FROM resources WHERE status = 'approved')"),
        countQuery("SELECT COUNT(*) AS cnt FROM confessions WHERE status = 'pending'"),
        countQuery("SELECT COUNT(*) AS cnt FROM complaints WHERE status IN ('submitted', 'under_review')"),
        countQuery("SELECT COUNT(*) AS cnt FROM reports WHERE status = 'open'"),
        db.query(
          `SELECT r.id, r.title, r.status, r.created_at, p.code AS program_code, sem.name AS semester_name, sub.name AS subject_name,
                  rc.name AS category_name, u.display_name AS uploader_name, rr.id AS revision_id, rr.revision_number, rr.original_filename, rr.file_size
           FROM resource_revisions rr
           JOIN resources r ON r.id = rr.resource_id
           JOIN programs p ON p.id = r.program_id
           JOIN semesters sem ON sem.id = r.semester_id
           JOIN subjects sub ON sub.id = r.subject_id
           JOIN resource_categories rc ON rc.id = r.category_id
           JOIN profiles u ON u.id = r.uploader_id
           WHERE rr.status = 'pending'
           ORDER BY rr.created_at ASC`
        ),
        db.query(
          "SELECT id, title, body, image_url, category, created_at FROM confessions WHERE status = 'pending' ORDER BY created_at ASC"
        ),
        db.query(
          "SELECT o.*, u.display_name AS author_name FROM opportunities o JOIN profiles u ON u.id = o.author_id WHERE o.status = 'pending' ORDER BY o.created_at ASC"
        ),
        db.query(
          "SELECT d.*, u.display_name AS requester_name FROM donation_requests d JOIN profiles u ON u.id = d.requester_id WHERE d.status = 'pending' ORDER BY d.created_at ASC"
        ),
        db.query(
          `SELECT rp.*, u.display_name AS reporter_name
           FROM reports rp JOIN profiles u ON u.id = rp.reporter_id
           ORDER BY CASE WHEN rp.status = 'open' THEN 0 ELSE 1 END, rp.created_at DESC LIMIT 50`
        )
      ]);
      let pending_staff_verifications = 0;
      let pendingStaffVerifications = [];
      try {
        const svExists = await db.queryOne(
          "SELECT to_regclass('public.staff_verification_requests')::text AS exists"
        );
        if (svExists?.exists) {
          pending_staff_verifications = await countQuery(
            "SELECT COUNT(*) AS cnt FROM staff_verification_requests WHERE status = 'pending'"
          );
          pendingStaffVerifications = await db.query(
            `SELECT sv.id, sv.user_id, sv.position, sv.department, sv.designation, sv.university_email,
                    sv.supporting_notes, (sv.evidence_object_path IS NOT NULL) AS has_evidence,
                    sv.evidence_original_filename, sv.status, sv.review_notes, sv.created_at,
                    u.display_name AS requester_name, u.username AS requester_username, u.role AS requester_role
             FROM staff_verification_requests sv
             JOIN profiles u ON u.id = sv.user_id
             WHERE sv.status = 'pending'
             ORDER BY sv.created_at ASC`
          );
        }
      } catch {
      }
      return res.json({
        stats: {
          total_users,
          verified_students,
          verified_teachers,
          active_users,
          total_communities,
          total_posts,
          total_resources,
          pending_resources: pending_resources_new + pending_resources_revs,
          pending_confessions,
          pending_complaints,
          open_reports,
          pending_staff_verifications
        },
        queues: {
          pendingResources,
          pendingConfessions,
          pendingOpportunities,
          pendingDonations,
          openReports,
          pendingStaffVerifications
        }
      });
    } catch (err) {
      return next(err);
    }
  });
  router.get("/users", requireAdmin, async (req, res, next) => {
    try {
      const q = String(req.query.q || "").trim().toLowerCase();
      const rows = await db.query(
        `SELECT u.id, uc.email, u.username, u.display_name, u.role, u.email_verified, u.university_email_verified,
                u.account_status, u.created_at, p.code AS program_code
         FROM profiles u
         JOIN user_credentials uc ON uc.user_id = u.id
         LEFT JOIN programs p ON p.id = u.program_id
         ${q ? "WHERE lower(u.display_name) LIKE $1 OR lower(u.username) LIKE $1 OR lower(uc.email) LIKE $1" : ""}
         ORDER BY u.created_at DESC LIMIT 100`,
        q ? [`%${q}%`] : []
      );
      return res.json({ users: rows });
    } catch (err) {
      return next(err);
    }
  });
  router.patch("/users/:id/status", requireAdmin, async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: "User not found." });
      const parsed = z2.object({ account_status: z2.enum(["active", "suspended", "restricted"]), reason: z2.string().max(300).default("") }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid status update." });
      const target = await db.queryOne("SELECT role FROM profiles WHERE id = $1", [req.params.id]);
      if (!target) return res.status(404).json({ error: "User not found." });
      if (target.role === "super_admin" && req.user.role !== "super_admin") {
        return res.status(403).json({ error: "Only a Super Admin can modify another Super Admin." });
      }
      await db.transaction(
        async (tx) => {
          await tx.execute("UPDATE profiles SET account_status = $1, updated_at = NOW() WHERE id = $2", [
            parsed.data.account_status,
            req.params.id
          ]);
          if (parsed.data.account_status !== "active") {
            await tx.execute("DELETE FROM sessions WHERE user_id = $1", [req.params.id]);
          }
          await writeAuditLog(tx, req.user.id, "update_user_status", "user", req.params.id, {
            account_status: parsed.data.account_status,
            reason: parsed.data.reason
          });
        },
        { trustedServer: true, actorId: req.user.id }
      );
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });
  router.patch("/users/:id/role", requireAdmin, async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: "User not found." });
      const parsed = z2.object({
        role: z2.enum([
          "super_admin",
          "admin",
          "community_moderator",
          "verified_student",
          "verified_teacher",
          "future_student",
          "alumni",
          "visitor"
        ])
      }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid role." });
      const { role } = parsed.data;
      if ((role === "super_admin" || role === "admin") && req.user.role !== "super_admin") {
        return res.status(403).json({ error: "Only a Super Admin can assign Admin or Super Admin roles." });
      }
      await db.transaction(
        async (tx) => {
          await tx.execute("UPDATE profiles SET role = $1::user_role, updated_at = NOW() WHERE id = $2", [
            role,
            req.params.id
          ]);
          await tx.execute(
            `INSERT INTO user_roles (id, user_id, role, granted_by, reason, created_at)
             VALUES ($1, $2, $3::user_role, $4, 'Role updated via admin governance', NOW())`,
            [crypto5.randomUUID(), req.params.id, role, req.user.id]
          );
          await writeAuditLog(tx, req.user.id, "change_user_role", "user", req.params.id, { new_role: role });
          await createNotification(
            tx,
            req.params.id,
            "role_changed",
            "Account Role Updated",
            `Your GandakiHub role was updated to ${role.replace("_", " ")}.`,
            "/profile"
          );
        },
        { trustedServer: true, actorId: req.user.id }
      );
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });
  router.post("/admins", requireSuperAdmin, async (req, res, next) => {
    try {
      const parsed = z2.object({
        username: z2.string().min(3, "Admin username must be at least 3 characters").max(30).regex(/^[a-zA-Z0-9_]+$/, "Username may contain letters, numbers, and underscores only"),
        display_name: z2.string().min(2).max(80).optional(),
        email: z2.string().email().max(160).optional().or(z2.literal("")),
        password: z2.string().min(8, "Password must be at least 8 characters").max(128).regex(/[A-Za-z]/, "Password must include a letter").regex(/[0-9]/, "Password must include a number")
      }).safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid admin account details." });
      }
      const username = parsed.data.username.trim().toLowerCase();
      const displayName = (parsed.data.display_name || parsed.data.username).trim();
      const email = parsed.data.email?.trim() ? parsed.data.email.trim().toLowerCase() : `${username}@admin.gandakihub.local`;
      if (await db.queryOne("SELECT id FROM profiles WHERE lower(username) = $1", [username])) {
        return res.status(409).json({ error: "This username is already taken." });
      }
      if (await db.queryOne("SELECT user_id FROM user_credentials WHERE lower(email) = $1", [email])) {
        return res.status(409).json({ error: "An account with this email already exists." });
      }
      const id = crypto5.randomUUID();
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const passHash = hashPassword(parsed.data.password);
      await db.transaction(
        async (tx) => {
          await tx.execute(
            `INSERT INTO profiles (id, username, display_name, bio, role, email_verified, university_email_verified, interests, account_status, created_at, updated_at)
             VALUES ($1, $2, $3, '', 'admin', TRUE, FALSE, '{}', 'active', $4::timestamptz, $4::timestamptz)`,
            [id, username, displayName, now]
          );
          await tx.execute(
            `INSERT INTO user_credentials (user_id, email, password_hash, created_at, updated_at)
             VALUES ($1, $2, $3, $4::timestamptz, $4::timestamptz)`,
            [id, email, passHash, now]
          );
          await tx.execute(
            `INSERT INTO user_roles (id, user_id, role, granted_by, reason, created_at)
             VALUES ($1, $2, 'admin', $3, 'Provisioned by Super Admin', $4::timestamptz)`,
            [crypto5.randomUUID(), id, req.user.id, now]
          );
          await writeAuditLog(tx, req.user.id, "create_admin_account", "user", id, { username, email });
        },
        { trustedServer: true, actorId: req.user.id }
      );
      return res.status(201).json({
        admin: {
          id,
          username,
          display_name: displayName,
          email,
          role: "admin",
          account_status: "active",
          created_at: now
        }
      });
    } catch (err) {
      return next(err);
    }
  });
  router.patch("/admins/:id", requireSuperAdmin, async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: "Admin account not found." });
      const parsed = z2.object({
        display_name: z2.string().min(2).max(80).optional(),
        password: z2.string().min(8, "Password must be at least 8 characters").max(128).regex(/[A-Za-z]/, "Password must include a letter").regex(/[0-9]/, "Password must include a number").optional()
      }).safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid update." });
      }
      const target = await db.queryOne(
        "SELECT id, role FROM profiles WHERE id = $1",
        [req.params.id]
      );
      if (!target || target.role !== "admin") {
        return res.status(404).json({ error: "Admin account not found." });
      }
      await db.transaction(
        async (tx) => {
          if (parsed.data.display_name) {
            await tx.execute("UPDATE profiles SET display_name = $1, updated_at = NOW() WHERE id = $2", [
              parsed.data.display_name.trim(),
              target.id
            ]);
          }
          if (parsed.data.password) {
            await tx.execute(
              "UPDATE user_credentials SET password_hash = $1, updated_at = NOW() WHERE user_id = $2",
              [hashPassword(parsed.data.password), target.id]
            );
            await tx.execute("DELETE FROM sessions WHERE user_id = $1", [target.id]);
          }
          await writeAuditLog(tx, req.user.id, "update_admin_account", "user", target.id, {
            updated_display_name: Boolean(parsed.data.display_name),
            reset_password: Boolean(parsed.data.password)
          });
        },
        { trustedServer: true, actorId: req.user.id }
      );
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });
  router.patch("/reports/:id", requireModerator, async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: "Report not found." });
      const parsed = z2.object({ status: z2.enum(["resolved", "dismissed"]), resolution_notes: z2.string().max(400).default("") }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid report resolution." });
      await db.execute(
        "UPDATE reports SET status = $1, reviewed_by = $2, resolution_notes = $3 WHERE id = $4",
        [parsed.data.status, req.user.id, parsed.data.resolution_notes.trim() || null, req.params.id]
      );
      await writeAuditLog(db, req.user.id, `report_${parsed.data.status}`, "report", req.params.id, {
        resolution_notes: parsed.data.resolution_notes
      });
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });
  router.get("/profanity", requireModerator, async (_req, res, next) => {
    try {
      const terms = await db.query(
        "SELECT * FROM profanity_dictionary ORDER BY language ASC, severity DESC, term ASC"
      );
      return res.json({ terms });
    } catch (err) {
      return next(err);
    }
  });
  router.post("/profanity", requireAdmin, async (req, res, next) => {
    try {
      const parsed = z2.object({
        term: z2.string().min(2).max(60),
        language: z2.enum(["en", "ne_devanagari", "ne_romanized"]),
        severity: z2.enum(["low", "medium", "high"]),
        context_exception_note: z2.string().max(240).nullable().optional()
      }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid profanity rule." });
      const id = crypto5.randomUUID();
      const norm = normalizeDictionaryTerm(parsed.data.term);
      try {
        await db.execute(
          "INSERT INTO profanity_dictionary (id, term, normalized_term, language, severity, context_exception_note, created_at) VALUES ($1, $2, $3, $4, $5, $6, NOW())",
          [
            id,
            parsed.data.term.trim(),
            norm,
            parsed.data.language,
            parsed.data.severity,
            parsed.data.context_exception_note ?? null
          ]
        );
      } catch {
        return res.status(409).json({ error: "This term already exists in the moderation dictionary." });
      }
      await writeAuditLog(db, req.user.id, "add_profanity_term", "profanity_dictionary", id, parsed.data);
      return res.status(201).json({ id });
    } catch (err) {
      return next(err);
    }
  });
  router.delete("/profanity/:id", requireAdmin, async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: "Term not found." });
      await db.execute("DELETE FROM profanity_dictionary WHERE id = $1", [req.params.id]);
      await writeAuditLog(db, req.user.id, "delete_profanity_term", "profanity_dictionary", req.params.id, {});
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });
  router.get("/audit-logs", requireAdmin, async (_req, res, next) => {
    try {
      const logs = await db.query(
        `SELECT a.*, u.display_name AS actor_name, u.username AS actor_username, u.role AS actor_role
         FROM audit_logs a
         LEFT JOIN profiles u ON u.id = a.actor_id
         ORDER BY a.created_at DESC LIMIT 120`
      );
      return res.json({ logs });
    } catch (err) {
      return next(err);
    }
  });
  router.get("/settings", requireAdmin, async (_req, res, next) => {
    try {
      const rows = await db.query("SELECT key, value FROM platform_settings");
      return res.json({ settings: rows });
    } catch (err) {
      return next(err);
    }
  });
  router.patch("/settings", requireSuperAdmin, async (req, res, next) => {
    try {
      const parsed = z2.object({ key: z2.string().min(1), value: z2.string().min(1) }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid setting payload." });
      const { key, value } = parsed.data;
      await db.execute(
        `INSERT INTO platform_settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [key, value]
      );
      await writeAuditLog(db, req.user.id, "update_platform_setting", "platform_settings", key, { value });
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });
  router.get("/staff-verification", requireAdmin, async (req, res, next) => {
    try {
      const svExists = await db.queryOne(
        "SELECT to_regclass('public.staff_verification_requests')::text AS exists"
      );
      if (!svExists?.exists) {
        return res.json({ requests: [] });
      }
      const statusFilter = req.query.status ? String(req.query.status) : "";
      const validStatus = ["pending", "approved", "rejected"].includes(statusFilter);
      const rows = await db.query(
        `SELECT sv.id, sv.user_id, sv.position, sv.department, sv.designation, sv.university_email,
                sv.supporting_notes, (sv.evidence_object_path IS NOT NULL) AS has_evidence,
                sv.evidence_original_filename, sv.status, sv.reviewer_id, sv.review_notes,
                sv.reviewed_at, sv.created_at, sv.updated_at,
                u.display_name AS requester_name, u.username AS requester_username,
                u.role AS requester_role, uc.email AS requester_email
         FROM staff_verification_requests sv
         JOIN profiles u ON u.id = sv.user_id
         JOIN user_credentials uc ON uc.user_id = u.id
         ${validStatus ? "WHERE sv.status = $1" : ""}
         ORDER BY CASE WHEN sv.status = 'pending' THEN 0 ELSE 1 END, sv.created_at DESC
         LIMIT 100`,
        validStatus ? [statusFilter] : []
      );
      return res.json({
        requests: rows.map((r) => ({
          ...r,
          has_evidence: Boolean(r.has_evidence),
          reviewed_at: r.reviewed_at ? new Date(String(r.reviewed_at)).toISOString() : null,
          created_at: new Date(String(r.created_at)).toISOString(),
          updated_at: new Date(String(r.updated_at)).toISOString()
        }))
      });
    } catch (err) {
      return next(err);
    }
  });
  router.get("/staff-verification/:id/evidence", requireAdmin, async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: "Verification request not found." });
      const row = await db.queryOne(
        "SELECT evidence_object_path, evidence_original_filename, evidence_mime_type FROM staff_verification_requests WHERE id = $1",
        [req.params.id]
      );
      if (!row || !row.evidence_object_path) {
        return res.status(404).json({ error: "No supporting document attached to this request." });
      }
      const data = await req.storage.downloadPrivate(String(row.evidence_object_path));
      if (!data) {
        return res.status(404).json({ error: "Supporting document not found in private storage." });
      }
      res.setHeader("Content-Type", row.evidence_mime_type || "application/octet-stream");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${row.evidence_original_filename || "evidence"}"`
      );
      return res.send(data);
    } catch (err) {
      return next(err);
    }
  });
  router.post("/staff-verification/:id/review", requireAdmin, async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: "Verification request not found." });
      const parsed = z2.object({
        decision: z2.enum(["approved", "rejected"]),
        review_notes: z2.string().trim().max(500).default("")
      }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid review decision." });
      const reqRow = await db.queryOne("SELECT id, user_id, position, department, designation, status FROM staff_verification_requests WHERE id = $1", [
        req.params.id
      ]);
      if (!reqRow) return res.status(404).json({ error: "Verification request not found." });
      if (reqRow.status !== "pending") {
        return res.status(409).json({ error: `This verification request has already been ${reqRow.status}.` });
      }
      if (String(reqRow.user_id) === req.user.id) {
        return res.status(403).json({ error: "Administrators cannot approve their own verification request." });
      }
      await db.transaction(
        async (tx) => {
          await tx.execute(
            `UPDATE staff_verification_requests
             SET status = $1,
                 reviewer_id = $2,
                 review_notes = $3,
                 reviewed_at = NOW(),
                 updated_at = NOW()
             WHERE id = $4`,
            [parsed.data.decision, req.user.id, parsed.data.review_notes || null, reqRow.id]
          );
          if (parsed.data.decision === "approved") {
            await tx.execute(
              `UPDATE profiles
               SET role = 'verified_teacher',
                   staff_position = $1,
                   department = $2,
                   designation = $3,
                   profile_completed = TRUE,
                   updated_at = NOW()
               WHERE id = $4`,
              [reqRow.position, reqRow.department, reqRow.designation || null, reqRow.user_id]
            );
            await tx.execute(
              `INSERT INTO user_roles (id, user_id, role, granted_by, reason, created_at)
               VALUES ($1, $2, 'verified_teacher', $3, $4, NOW())`,
              [
                crypto5.randomUUID(),
                reqRow.user_id,
                req.user.id,
                `University staff verification approved (${reqRow.position} \xB7 ${reqRow.department})`
              ]
            );
          }
          await syncModerationQueue(
            tx,
            "staff_verification",
            reqRow.id,
            reqRow.user_id,
            parsed.data.decision,
            req.user.id,
            parsed.data.review_notes || null
          );
          await writeAuditLog(tx, req.user.id, `staff_verification_${parsed.data.decision}`, "staff_verification", reqRow.id, {
            target_user_id: reqRow.user_id,
            position: reqRow.position,
            department: reqRow.department,
            review_notes: parsed.data.review_notes
          });
          await createNotification(
            tx,
            reqRow.user_id,
            "staff_verification_update",
            parsed.data.decision === "approved" ? "University Staff Verification Approved" : "University Staff Verification Update",
            parsed.data.decision === "approved" ? `Your verification request (${reqRow.position} \xB7 ${reqRow.department}) has been approved.` : `Your university staff verification request was declined.${parsed.data.review_notes ? ` Note: ${parsed.data.review_notes}` : ""}`,
            "/profile"
          );
        },
        { trustedServer: true, actorId: req.user.id }
      );
      return res.json({ ok: true, status: parsed.data.decision });
    } catch (err) {
      return next(err);
    }
  });
  return router;
}

// server/routes/auth.ts
import crypto6 from "node:crypto";
import path3 from "node:path";
import { Router as Router3 } from "express";
import multer2 from "multer";
import { z as z3 } from "zod";

// server/email.ts
function buildRegistrationEmailHtml(code) {
  return `
  <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; color: #0f172a; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px;">
    <h2 style="margin: 0 0 8px; font-size: 20px; color: #0f172a;">Verify your GandakiHub account</h2>
    <p style="margin: 0 0 16px; font-size: 14px; line-height: 1.5; color: #475569;">
      Use the 6-digit verification code below to confirm ownership of your email address and activate your GandakiHub account.
    </p>
    <div style="margin: 20px 0; padding: 16px; background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 8px; text-align: center;">
      <span style="font-family: monospace; font-size: 28px; font-weight: 700; letter-spacing: 6px; color: #0f172a;">${code}</span>
    </div>
    <p style="margin: 0 0 8px; font-size: 12px; color: #64748b;">
      This code expires in 15 minutes and can only be used once.
    </p>
    <p style="margin: 0; font-size: 12px; color: #94a3b8;">
      If you did not request this verification, you can safely ignore this message. GandakiHub is an independent student-developed community platform.
    </p>
  </div>`;
}
function buildPasswordResetEmailHtml(code) {
  return `
  <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; color: #0f172a; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px;">
    <h2 style="margin: 0 0 8px; font-size: 20px; color: #0f172a;">GandakiHub Password Recovery</h2>
    <p style="margin: 0 0 16px; font-size: 14px; line-height: 1.5; color: #475569;">
      A password reset was requested for your GandakiHub account. Enter the 6-digit recovery code below to set a new password.
    </p>
    <div style="margin: 20px 0; padding: 16px; background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 8px; text-align: center;">
      <span style="font-family: monospace; font-size: 28px; font-weight: 700; letter-spacing: 6px; color: #0f172a;">${code}</span>
    </div>
    <p style="margin: 0 0 8px; font-size: 12px; color: #64748b;">
      This code expires in 15 minutes. Completing a password reset revokes all active sessions for your security.
    </p>
    <p style="margin: 0; font-size: 12px; color: #94a3b8;">
      If you did not request a password reset, please ignore this email\u2014your existing password remains unchanged.
    </p>
  </div>`;
}
async function dispatchOtpEmail(email, code, purpose) {
  const isProd = process.env.NODE_ENV === "production";
  const resendKey = process.env.RESEND_API_KEY?.trim();
  const fromAddress = process.env.EMAIL_FROM?.trim();
  if (resendKey) {
    if (!fromAddress && isProd) {
      throw new Error("EMAIL_FROM must be configured to send verification emails via Resend in production.");
    }
    const subject = purpose === "reset_password" ? "GandakiHub Password Recovery Code" : "Verify your GandakiHub email address";
    const text = purpose === "reset_password" ? `Your 6-digit GandakiHub password recovery code is: ${code}. It expires in 15 minutes.` : `Your 6-digit GandakiHub verification code is: ${code}. It expires in 15 minutes.`;
    const html = purpose === "reset_password" ? buildPasswordResetEmailHtml(code) : buildRegistrationEmailHtml(code);
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: fromAddress || "GandakiHub <onboarding@resend.dev>",
        to: [email],
        subject,
        text,
        html
      })
    });
    if (resp.ok) {
      return { deliveredVia: "resend" };
    }
    const errText = await resp.text().catch(() => "");
    console.error(`[GandakiHub Email] Resend API error (${resp.status}):`, errText.slice(0, 300));
    if (isProd) {
      throw new Error("Unable to deliver verification email right now. Please try again shortly.");
    }
  } else if (isProd) {
    throw new Error("RESEND_API_KEY is not configured in production for email OTP delivery.");
  }
  if (process.env.NODE_ENV !== "test") {
    console.info(`[GandakiHub DEV OTP] ${purpose} for ${email}: ${code}`);
  }
  return {
    deliveredVia: "dev_console",
    devCode: code
  };
}

// server/routes/auth.ts
var STAFF_POSITIONS = [
  "Teacher",
  "Faculty",
  "Staff",
  "Lecturer",
  "Assistant Professor",
  "Associate Professor",
  "Professor",
  "Administrative Staff",
  "Other"
];
var registerSchema = z3.object({
  full_name: z3.string().trim().min(2, "Full name must be at least 2 characters").max(80).optional(),
  display_name: z3.string().trim().min(2, "Full name must be at least 2 characters").max(80).optional(),
  email: z3.string().trim().email("Please enter a valid email address").max(160),
  password: z3.string().min(8, "Password must be at least 8 characters").max(128).regex(/[A-Za-z]/, "Password must include a letter").regex(/[0-9]/, "Password must include a number"),
  confirm_password: z3.string().min(1, "Please confirm your password")
}).refine((d) => Boolean((d.full_name || d.display_name || "").trim().length >= 2), {
  message: "Full name is required (at least 2 characters)."
}).refine((d) => d.password === d.confirm_password, {
  message: "Password and Confirm Password do not match.",
  path: ["confirm_password"]
});
var verifyOtpSchema = z3.object({
  email: z3.string().email(),
  code: z3.string().length(6).regex(/^\d{6}$/),
  purpose: z3.enum(["verify_email", "reset_password"]).default("verify_email")
});
var loginSchema = z3.object({
  identifier: z3.string().min(1).max(160).optional(),
  email: z3.string().min(1).max(160).optional(),
  password: z3.string().min(1, "Password is required.")
}).refine((d) => Boolean((d.identifier || d.email || "").trim()), {
  message: "Email is required."
});
var profileUpdateSchema = z3.object({
  display_name: z3.string().trim().min(2).max(80).optional(),
  bio: z3.string().max(500).optional(),
  program_id: z3.string().nullable().optional(),
  semester_id: z3.string().nullable().optional(),
  department: z3.string().trim().max(120).nullable().optional(),
  student_id: z3.string().trim().max(60).nullable().optional(),
  interests: z3.array(z3.string().trim().max(40)).max(12).optional(),
  notification_prefs: z3.object({
    replies: z3.boolean(),
    connections: z3.boolean(),
    resources: z3.boolean(),
    events: z3.boolean(),
    announcements: z3.boolean()
  }).optional(),
  privacy_settings: z3.object({
    show_program: z3.boolean(),
    allow_connection_requests: z3.boolean()
  }).optional()
});
function getConfiguredSuperAdminEmail() {
  const val = process.env.SUPER_ADMIN_EMAIL?.trim().toLowerCase();
  return val && val.includes("@") ? val : null;
}
async function generateUniqueUsername(tx, fullName, email) {
  const fromName = fullName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 20);
  const fromEmail = email.split("@")[0].toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 20);
  const base = (fromName.length >= 3 ? fromName : fromEmail.length >= 3 ? fromEmail : "gandaki_member").slice(0, 22);
  const exact = await tx.queryOne("SELECT id FROM profiles WHERE lower(username) = $1", [base]);
  if (!exact) return base;
  for (let i = 0; i < 12; i++) {
    const suffix = crypto6.randomBytes(2).toString("hex");
    const candidate = `${base.slice(0, 24)}_${suffix}`;
    const taken = await tx.queryOne("SELECT id FROM profiles WHERE lower(username) = $1", [candidate]);
    if (!taken) return candidate;
  }
  return `member_${crypto6.randomBytes(4).toString("hex")}`;
}
async function hasMigration003ProfileCols(db) {
  const row = await db.queryOne(
    `SELECT column_name::text AS exists
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'department'
     LIMIT 1`
  );
  return Boolean(row?.exists);
}
async function hasStaffVerificationTable(db) {
  const row = await db.queryOne(
    "SELECT to_regclass('public.staff_verification_requests')::text AS exists"
  );
  return Boolean(row?.exists);
}
function createAuthRouter(db) {
  const router = Router3();
  const avatarUpload = multer2({
    storage: multer2.memoryStorage(),
    limits: { fileSize: 2 * 1024 * 1024 }
  });
  const evidenceUpload = multer2({
    storage: multer2.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }
  });
  router.get("/me", (req, res) => {
    res.json({ user: req.user ?? null });
  });
  router.post("/register", async (req, res, next) => {
    try {
      const ipKey = `reg:${req.ip || "local"}`;
      const rl = await checkRateLimit(db, ipKey, 15, 900);
      if (!rl.allowed) {
        return res.status(429).json({ error: `Too many registration attempts. Retry in ${rl.retryAfterSec}s.` });
      }
      const parsed = registerSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid registration data." });
      }
      const data = parsed.data;
      const fullName = (data.full_name || data.display_name || "").trim();
      const normalizedEmail = data.email.trim().toLowerCase();
      const envSuperEmail = getConfiguredSuperAdminEmail();
      const superRow = await db.queryOne(
        "SELECT COUNT(*) AS cnt FROM profiles WHERE role = 'super_admin' AND email_verified = TRUE"
      );
      const initSetting = await db.queryOne(
        "SELECT value FROM platform_settings WHERE key = 'super_admin_initialized'"
      );
      const superAlreadyInitialized = Number(superRow?.cnt || 0) > 0 || initSetting?.value === "true";
      const isBootstrapSuperEmail = !superAlreadyInitialized && Boolean(envSuperEmail && envSuperEmail === normalizedEmail);
      if (!isUniversityEmail(normalizedEmail) && !isBootstrapSuperEmail) {
        return res.status(400).json({
          error: "Registration requires a valid @gandakiuniversity.edu.np email address."
        });
      }
      const existingByEmail = await db.queryOne(
        `SELECT uc.user_id, p.email_verified
         FROM user_credentials uc
         JOIN profiles p ON p.id = uc.user_id
         WHERE lower(uc.email) = $1`,
        [normalizedEmail]
      );
      if (existingByEmail) {
        if (!existingByEmail.email_verified) {
          return res.status(409).json({
            error: "An account with this email already exists and is awaiting verification. Sign in or verify your code.",
            requiresVerification: true,
            email: normalizedEmail
          });
        }
        return res.status(409).json({
          error: "An account with this email address already exists. One email can only have one account."
        });
      }
      const initialRole = "visitor";
      const userId = crypto6.randomUUID();
      const passHash = hashPassword(data.password);
      const otp = generateSixDigitOtp();
      const resendAfter = new Date(Date.now() + 60 * 1e3).toISOString();
      const expiresAt = new Date(Date.now() + 15 * 60 * 1e3).toISOString();
      try {
        await db.transaction(
          async (tx) => {
            const generatedUsername = await generateUniqueUsername(tx, fullName, normalizedEmail);
            await tx.execute(
              `INSERT INTO profiles (id, username, display_name, bio, role, email_verified, university_email_verified, interests, account_status, created_at, updated_at)
               VALUES ($1, $2, $3, '', $4::user_role, FALSE, FALSE, '{}', 'active', NOW(), NOW())`,
              [userId, generatedUsername, fullName, initialRole]
            );
            await tx.execute(
              `INSERT INTO user_credentials (user_id, email, password_hash, created_at, updated_at)
               VALUES ($1, $2, $3, NOW(), NOW())`,
              [userId, normalizedEmail, passHash]
            );
            await tx.execute(
              `INSERT INTO user_roles (id, user_id, role, granted_by, reason, created_at)
               VALUES ($1, $2, $3::user_role, NULL, 'Initial registration (pending OTP verification)', NOW())`,
              [crypto6.randomUUID(), userId, initialRole]
            );
            await tx.execute(
              `INSERT INTO otp_codes (id, email, purpose, code_hash, attempts, resend_after, expires_at, created_at)
               VALUES ($1, $2, 'verify_email', $3, 0, $4::timestamptz, $5::timestamptz, NOW())`,
              [crypto6.randomUUID(), normalizedEmail, hashToken(otp), resendAfter, expiresAt]
            );
            await writeAuditLog(tx, userId, "user_registered", "user", userId, {
              registration_mode: "simplified_unified"
            });
          },
          { trustedServer: true }
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        if (msg.toLowerCase().includes("unique")) {
          return res.status(409).json({
            error: "An account with this email address already exists."
          });
        }
        throw err;
      }
      const delivery = await dispatchOtpEmail(normalizedEmail, otp, "verify_email");
      return res.status(201).json({
        message: "Account created. Enter the 6-digit verification code sent to your email.",
        email: normalizedEmail,
        requiresVerification: true,
        resendCooldownSeconds: 60,
        ...delivery.devCode ? { devOtpPreview: delivery.devCode } : {}
      });
    } catch (err) {
      return next(err);
    }
  });
  router.post("/verify-otp", async (req, res, next) => {
    try {
      const parsed = verifyOtpSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Please enter a valid email and 6-digit code." });
      }
      const email = parsed.data.email.trim().toLowerCase();
      const { code, purpose } = parsed.data;
      const rl = await checkRateLimit(db, `otp_verify:${email}`, 10, 900);
      if (!rl.allowed) {
        return res.status(429).json({ error: `Too many verification attempts. Try again in ${rl.retryAfterSec}s.` });
      }
      const otpRow = await db.queryOne(
        `SELECT id, code_hash, attempts, expires_at
         FROM otp_codes
         WHERE lower(email) = $1 AND purpose = $2 AND used_at IS NULL
         ORDER BY created_at DESC LIMIT 1`,
        [email, purpose]
      );
      if (!otpRow) {
        return res.status(400).json({ error: "No active verification code found. Please request a new code." });
      }
      if (new Date(otpRow.expires_at).getTime() < Date.now()) {
        return res.status(400).json({ error: "Verification code has expired. Please request a new one." });
      }
      if (Number(otpRow.attempts) >= 5) {
        return res.status(429).json({ error: "Maximum code attempts exceeded. Request a fresh code." });
      }
      if (hashToken(code) !== String(otpRow.code_hash)) {
        await db.execute("UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1", [otpRow.id]);
        return res.status(400).json({ error: "Incorrect 6-digit verification code." });
      }
      if (purpose === "reset_password") {
        await db.execute("UPDATE otp_codes SET used_at = NOW() WHERE id = $1", [otpRow.id]);
        return res.json({ verified: true, message: "Code verified. You may now set a new password." });
      }
      const envSuperEmail = getConfiguredSuperAdminEmail();
      const token = generateSessionToken();
      const result = await db.transaction(
        async (tx) => {
          await tx.execute("UPDATE otp_codes SET used_at = NOW() WHERE id = $1", [otpRow.id]);
          const userRow = await tx.queryOne(
            `SELECT p.id, p.role, p.external_reason_detail
             FROM profiles p
             JOIN user_credentials uc ON uc.user_id = p.id
             WHERE lower(uc.email) = $1`,
            [email]
          );
          if (!userRow) return null;
          await tx.query("SELECT pg_advisory_xact_lock(984521)");
          const superRow = await tx.queryOne(
            "SELECT COUNT(*) AS cnt FROM profiles WHERE role = 'super_admin' AND email_verified = TRUE"
          );
          const initSetting = await tx.queryOne(
            "SELECT value FROM platform_settings WHERE key = 'super_admin_initialized'"
          );
          const superCount = Number(superRow?.cnt || 0);
          const alreadyInit = initSetting?.value === "true";
          const isUni = isUniversityEmail(email);
          let assignedRole = userRow.role;
          let cleanDetail = userRow.external_reason_detail;
          let bootstrappedSuperAdmin = false;
          if (!alreadyInit && superCount === 0 && envSuperEmail && envSuperEmail === email) {
            assignedRole = "super_admin";
            cleanDetail = null;
            bootstrappedSuperAdmin = true;
            await tx.execute(
              `INSERT INTO platform_settings (key, value)
               VALUES ('super_admin_initialized', 'true')
               ON CONFLICT (key) DO UPDATE SET value = 'true'`
            );
          } else if (isUni) {
            assignedRole = "verified_student";
            cleanDetail = null;
          } else if (cleanDetail === "pending_super_admin_claim") {
            cleanDetail = null;
          }
          await tx.execute(
            `UPDATE profiles
             SET email_verified = TRUE,
                 university_email_verified = $1,
                 role = $2::user_role,
                 external_reason_detail = $3,
                 updated_at = NOW()
             WHERE id = $4`,
            [isUni, assignedRole, cleanDetail, userRow.id]
          );
          await tx.execute(
            `INSERT INTO user_roles (id, user_id, role, granted_by, reason, created_at)
             VALUES ($1, $2, $3::user_role, NULL, $4, NOW())`,
            [
              crypto6.randomUUID(),
              userRow.id,
              assignedRole,
              bootstrappedSuperAdmin ? "First-time Super Admin bootstrap via verified SUPER_ADMIN_EMAIL" : "OTP email verification completed"
            ]
          );
          await writeAuditLog(tx, userRow.id, "email_verified", "user", userRow.id, {
            university_email_verified: isUni,
            assigned_role: assignedRole
          });
          if (bootstrappedSuperAdmin) {
            await writeAuditLog(tx, userRow.id, "super_admin_bootstrapped", "user", userRow.id, { email });
          }
          await createSessionCookie(tx, req, res, userRow.id, token);
          const authUser = await getAuthUserFromDb(tx, userRow.id);
          return authUser;
        },
        { trustedServer: true }
      );
      if (!result) {
        return res.status(404).json({ error: "User account not found." });
      }
      return res.json({
        verified: true,
        user: result,
        sessionToken: token
      });
    } catch (err) {
      return next(err);
    }
  });
  router.post("/resend-otp", async (req, res, next) => {
    try {
      const parsed = z3.object({ email: z3.string().email(), purpose: z3.enum(["verify_email", "reset_password"]).default("verify_email") }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Valid email is required." });
      const email = parsed.data.email.trim().toLowerCase();
      const userRow = await db.queryOne(
        "SELECT user_id FROM user_credentials WHERE lower(email) = $1",
        [email]
      );
      if (!userRow) {
        return res.status(404).json({ error: "No account found with that email address." });
      }
      const latest = await db.queryOne(
        "SELECT resend_after FROM otp_codes WHERE lower(email) = $1 AND purpose = $2 ORDER BY created_at DESC LIMIT 1",
        [email, parsed.data.purpose]
      );
      if (latest && new Date(latest.resend_after).getTime() > Date.now()) {
        const waitSec = Math.ceil((new Date(latest.resend_after).getTime() - Date.now()) / 1e3);
        return res.status(429).json({ error: `Please wait ${waitSec}s before requesting another code.`, retryAfterSec: waitSec });
      }
      const rl = await checkRateLimit(db, `otp_send:${email}`, 5, 3600);
      if (!rl.allowed) {
        return res.status(429).json({ error: `Hourly OTP limit reached. Try again in ${rl.retryAfterSec}s.` });
      }
      const otp = generateSixDigitOtp();
      await db.execute(
        `INSERT INTO otp_codes (id, email, purpose, code_hash, attempts, resend_after, expires_at, created_at)
         VALUES ($1, $2, $3, $4, 0, $5::timestamptz, $6::timestamptz, NOW())`,
        [
          crypto6.randomUUID(),
          email,
          parsed.data.purpose,
          hashToken(otp),
          new Date(Date.now() + 60 * 1e3).toISOString(),
          new Date(Date.now() + 15 * 60 * 1e3).toISOString()
        ]
      );
      const delivery = await dispatchOtpEmail(email, otp, parsed.data.purpose);
      return res.json({
        message: "A fresh 6-digit verification code has been issued.",
        resendCooldownSeconds: 60,
        ...delivery.devCode ? { devOtpPreview: delivery.devCode } : {}
      });
    } catch (err) {
      return next(err);
    }
  });
  router.post("/request-password-reset", async (req, res, next) => {
    try {
      const parsed = z3.object({ email: z3.string().email() }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Valid email is required." });
      const email = parsed.data.email.trim().toLowerCase();
      const rl = await checkRateLimit(db, `pwd_reset:${email}`, 5, 3600);
      if (!rl.allowed) {
        return res.status(429).json({ error: `Too many reset requests. Retry in ${rl.retryAfterSec}s.` });
      }
      const userRow = await db.queryOne(
        "SELECT user_id FROM user_credentials WHERE lower(email) = $1",
        [email]
      );
      if (!userRow) {
        return res.json({ message: "If an account matches that email, a 6-digit reset code has been sent." });
      }
      const otp = generateSixDigitOtp();
      await db.execute(
        `INSERT INTO otp_codes (id, email, purpose, code_hash, attempts, resend_after, expires_at, created_at)
         VALUES ($1, $2, 'reset_password', $3, 0, $4::timestamptz, $5::timestamptz, NOW())`,
        [
          crypto6.randomUUID(),
          email,
          hashToken(otp),
          new Date(Date.now() + 60 * 1e3).toISOString(),
          new Date(Date.now() + 15 * 60 * 1e3).toISOString()
        ]
      );
      const delivery = await dispatchOtpEmail(email, otp, "reset_password");
      return res.json({
        message: "If an account matches that email, a 6-digit reset code has been sent.",
        ...delivery.devCode ? { devOtpPreview: delivery.devCode } : {}
      });
    } catch (err) {
      return next(err);
    }
  });
  router.post("/reset-password", async (req, res, next) => {
    try {
      const parsed = z3.object({
        email: z3.string().email(),
        code: z3.string().length(6).regex(/^\d{6}$/),
        new_password: z3.string().min(8).max(128).regex(/[A-Za-z]/).regex(/[0-9]/)
      }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid reset fields." });
      const email = parsed.data.email.trim().toLowerCase();
      const otpRow = await db.queryOne(
        `SELECT id, code_hash, attempts, expires_at
         FROM otp_codes
         WHERE lower(email) = $1 AND purpose = 'reset_password' AND used_at IS NULL
         ORDER BY created_at DESC LIMIT 1`,
        [email]
      );
      if (!otpRow || new Date(otpRow.expires_at).getTime() < Date.now() || Number(otpRow.attempts) >= 5) {
        return res.status(400).json({ error: "Invalid or expired password reset code." });
      }
      if (hashToken(parsed.data.code) !== String(otpRow.code_hash)) {
        await db.execute("UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1", [otpRow.id]);
        return res.status(400).json({ error: "Invalid or expired password reset code." });
      }
      const newPassHash = hashPassword(parsed.data.new_password);
      await db.transaction(async (tx) => {
        await tx.execute("UPDATE otp_codes SET used_at = NOW() WHERE id = $1", [otpRow.id]);
        const cred = await tx.queryOne(
          "SELECT user_id FROM user_credentials WHERE lower(email) = $1",
          [email]
        );
        if (cred) {
          await tx.execute(
            "UPDATE user_credentials SET password_hash = $1, updated_at = NOW() WHERE user_id = $2",
            [newPassHash, cred.user_id]
          );
          await tx.execute("DELETE FROM sessions WHERE user_id = $1", [cred.user_id]);
          await writeAuditLog(tx, cred.user_id, "password_reset", "user", cred.user_id, {});
        }
      });
      return res.json({ message: "Password updated successfully. Please sign in with your new password." });
    } catch (err) {
      return next(err);
    }
  });
  router.post("/login", async (req, res, next) => {
    try {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Email and password are required." });
      const identifier = (parsed.data.identifier ?? parsed.data.email ?? "").trim().toLowerCase();
      const rl = await checkRateLimit(db, `login:${identifier}`, 12, 900);
      if (!rl.allowed) {
        return res.status(429).json({ error: `Too many login attempts. Retry in ${rl.retryAfterSec}s.` });
      }
      const row = await db.queryOne(
        `SELECT p.id, uc.email, uc.password_hash, p.account_status, p.email_verified
         FROM profiles p
         JOIN user_credentials uc ON uc.user_id = p.id
         WHERE lower(uc.email) = $1 OR lower(p.username) = $1`,
        [identifier]
      );
      if (!row || !verifyPassword(parsed.data.password, String(row.password_hash))) {
        return res.status(401).json({ error: "Invalid email or password." });
      }
      if (row.account_status !== "active") {
        return res.status(403).json({ error: "Your account has been suspended. Contact campus moderation." });
      }
      if (!row.email_verified) {
        const userEmail = String(row.email).toLowerCase();
        const otp = generateSixDigitOtp();
        await db.execute(
          `INSERT INTO otp_codes (id, email, purpose, code_hash, attempts, resend_after, expires_at, created_at)
           VALUES ($1, $2, 'verify_email', $3, 0, $4::timestamptz, $5::timestamptz, NOW())`,
          [
            crypto6.randomUUID(),
            userEmail,
            hashToken(otp),
            new Date(Date.now() + 60 * 1e3).toISOString(),
            new Date(Date.now() + 15 * 60 * 1e3).toISOString()
          ]
        );
        const delivery = await dispatchOtpEmail(userEmail, otp, "verify_email");
        return res.status(403).json({
          error: "Email verification pending. Enter the 6-digit verification code sent to your email.",
          requiresVerification: true,
          email: userEmail,
          ...delivery.devCode ? { devOtpPreview: delivery.devCode } : {}
        });
      }
      const token = generateSessionToken();
      await createSessionCookie(db, req, res, String(row.id), token);
      const user = await getAuthUserFromDb(db, String(row.id));
      return res.json({
        user,
        sessionToken: token
      });
    } catch (err) {
      return next(err);
    }
  });
  router.post("/admin-login", async (req, res, next) => {
    try {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Email and password are required." });
      }
      const identifier = (parsed.data.email ?? parsed.data.identifier ?? "").trim().toLowerCase();
      const rl = await checkRateLimit(db, `admin_login:${req.ip || "local"}:${identifier}`, 10, 900);
      if (!rl.allowed) {
        return res.status(429).json({ error: `Too many login attempts. Retry in ${rl.retryAfterSec}s.` });
      }
      const row = await db.queryOne(
        `SELECT p.id, uc.email, uc.password_hash, p.role, p.account_status, p.email_verified
         FROM profiles p
         JOIN user_credentials uc ON uc.user_id = p.id
         WHERE lower(uc.email) = $1 OR lower(p.username) = $1`,
        [identifier]
      );
      if (!row || !verifyPassword(parsed.data.password, String(row.password_hash))) {
        return res.status(401).json({ error: "Invalid credentials." });
      }
      if (row.role !== "admin" && row.role !== "super_admin") {
        await writeAuditLog(db, String(row.id), "admin_portal_unauthorized_attempt", "user", String(row.id), {
          role: row.role
        });
        return res.status(403).json({
          error: "You are not authorized to access the administrator portal."
        });
      }
      if (row.account_status !== "active") {
        return res.status(403).json({ error: "This administrator account is currently suspended." });
      }
      if (!row.email_verified) {
        return res.status(403).json({ error: "Administrator email verification is pending." });
      }
      const token = generateSessionToken();
      await createSessionCookie(db, req, res, String(row.id), token);
      await writeAuditLog(db, String(row.id), "admin_portal_login", "user", String(row.id), {
        role: row.role
      });
      const user = await getAuthUserFromDb(db, String(row.id));
      return res.json({
        user,
        sessionToken: token
      });
    } catch (err) {
      return next(err);
    }
  });
  router.post("/logout", async (req, res, next) => {
    try {
      const authHeader = req.headers.authorization;
      const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : void 0;
      const rawToken = req.cookies?.gh_session || bearerToken;
      if (rawToken) {
        await db.execute("DELETE FROM sessions WHERE token_hash = $1", [hashToken(rawToken)]);
      }
      clearSessionCookie(req, res);
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });
  router.patch("/profile", requireAuth, async (req, res, next) => {
    try {
      const parsed = profileUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid profile fields." });
      }
      const u = req.user;
      const d = parsed.data;
      const nextProgramId = d.program_id !== void 0 ? isUuid(d.program_id) ? d.program_id : null : u.program_id;
      const nextSemesterId = d.semester_id !== void 0 ? isUuid(d.semester_id) ? d.semester_id : null : u.semester_id;
      if (nextProgramId) {
        const progExists = await db.queryOne("SELECT id FROM programs WHERE id = $1 AND is_archived = FALSE", [nextProgramId]);
        if (!progExists) {
          return res.status(400).json({ error: "Selected academic program was not found." });
        }
      }
      if (nextSemesterId) {
        const semExists = await db.queryOne("SELECT id FROM semesters WHERE id = $1 AND is_archived = FALSE", [nextSemesterId]);
        if (!semExists) {
          return res.status(400).json({ error: "Selected semester was not found." });
        }
      }
      const supportsExtendedCols = await hasMigration003ProfileCols(db);
      const nextDept = d.department !== void 0 ? d.department?.trim() || null : u.department ?? null;
      const nextStudentId = d.student_id !== void 0 ? d.student_id?.trim() || null : u.student_id ?? null;
      const nextBio = d.bio !== void 0 ? d.bio.trim() : u.bio;
      const willComplete = Boolean(
        nextProgramId && nextSemesterId || nextDept && (nextStudentId || nextBio)
      );
      const updated = await db.transaction(
        async (tx) => {
          if (supportsExtendedCols) {
            await tx.execute(
              `UPDATE profiles SET
                display_name = COALESCE($1, display_name),
                bio = COALESCE($2, bio),
                program_id = $3,
                semester_id = $4,
                department = $5,
                student_id = $6,
                profile_completed = profile_completed OR $7,
                interests = COALESCE($8::text[], interests),
                notification_prefs = COALESCE($9::jsonb, notification_prefs),
                privacy_settings = COALESCE($10::jsonb, privacy_settings),
                updated_at = NOW()
               WHERE id = $11`,
              [
                d.display_name?.trim() ?? null,
                d.bio !== void 0 ? d.bio.trim() : null,
                nextProgramId,
                nextSemesterId,
                nextDept,
                nextStudentId,
                willComplete,
                d.interests ?? null,
                d.notification_prefs ? JSON.stringify(d.notification_prefs) : null,
                d.privacy_settings ? JSON.stringify(d.privacy_settings) : null,
                u.id
              ]
            );
          } else {
            await tx.execute(
              `UPDATE profiles SET
                display_name = COALESCE($1, display_name),
                bio = COALESCE($2, bio),
                program_id = $3,
                semester_id = $4,
                interests = COALESCE($5::text[], interests),
                notification_prefs = COALESCE($6::jsonb, notification_prefs),
                privacy_settings = COALESCE($7::jsonb, privacy_settings),
                updated_at = NOW()
               WHERE id = $8`,
              [
                d.display_name?.trim() ?? null,
                d.bio !== void 0 ? d.bio.trim() : null,
                nextProgramId,
                nextSemesterId,
                d.interests ?? null,
                d.notification_prefs ? JSON.stringify(d.notification_prefs) : null,
                d.privacy_settings ? JSON.stringify(d.privacy_settings) : null,
                u.id
              ]
            );
          }
          return getAuthUserFromDb(tx, u.id);
        },
        { actorId: u.id, trustedServer: false }
      );
      return res.json({ user: updated });
    } catch (err) {
      return next(err);
    }
  });
  router.get("/staff-verification", requireAuth, async (req, res, next) => {
    try {
      const tableReady = await hasStaffVerificationTable(db);
      if (!tableReady) {
        return res.json({
          status: req.user.role === "verified_teacher" ? "approved" : "not_requested",
          latestRequest: null
        });
      }
      const row = await db.queryOne(
        `SELECT id, user_id, position, department, designation, university_email, supporting_notes,
                (evidence_object_path IS NOT NULL) AS has_evidence, evidence_original_filename,
                status, reviewer_id, review_notes, reviewed_at, created_at, updated_at
         FROM staff_verification_requests
         WHERE user_id = $1
         ORDER BY created_at DESC LIMIT 1`,
        [req.user.id]
      );
      const status = req.user.role === "verified_teacher" ? "approved" : row ? String(row.status) : "not_requested";
      const latestRequest = row ? {
        ...row,
        has_evidence: Boolean(row.has_evidence),
        reviewed_at: row.reviewed_at ? new Date(String(row.reviewed_at)).toISOString() : null,
        created_at: new Date(String(row.created_at)).toISOString(),
        updated_at: new Date(String(row.updated_at)).toISOString()
      } : null;
      return res.json({
        status,
        latestRequest
      });
    } catch (err) {
      return next(err);
    }
  });
  router.post(
    "/staff-verification",
    requireAuth,
    evidenceUpload.single("evidence"),
    async (req, res, next) => {
      try {
        const u = req.user;
        if (u.role === "visitor" || u.role === "future_student") {
          return res.status(403).json({
            error: "Only verified university members can request university staff verification."
          });
        }
        if (u.role === "verified_teacher" || u.role === "admin" || u.role === "super_admin") {
          return res.status(400).json({
            error: "Your account already holds verified staff or administrative privileges."
          });
        }
        const tableReady = await hasStaffVerificationTable(db);
        if (!tableReady) {
          return res.status(503).json({
            error: "Staff verification database migration (003) has not been applied yet."
          });
        }
        const parsed = z3.object({
          position: z3.enum(STAFF_POSITIONS),
          department: z3.string().trim().min(2, "Department is required").max(120),
          designation: z3.string().trim().max(120).default(""),
          supporting_notes: z3.string().trim().max(1e3).default("")
        }).safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({
            error: parsed.error.issues[0]?.message || "Please complete all required staff verification fields."
          });
        }
        const existingPending = await db.queryOne(
          "SELECT id FROM staff_verification_requests WHERE user_id = $1 AND status = 'pending'",
          [u.id]
        );
        if (existingPending) {
          return res.status(409).json({
            error: "You already have a pending university staff verification request awaiting review."
          });
        }
        let evidencePath = null;
        let evidenceOrigName = null;
        let evidenceMime = null;
        if (req.file) {
          const buf = req.file.buffer;
          const isPng = buf.subarray(0, 8).toString("hex") === "89504e470d0a1a0a";
          const isJpg = buf.subarray(0, 3).toString("hex") === "ffd8ff";
          const pdfCheck = validatePdfBuffer(buf);
          if (!isPng && !isJpg && !pdfCheck.valid) {
            return res.status(400).json({
              error: "Supporting evidence must be a valid PDF, PNG, or JPEG file (max 5MB)."
            });
          }
          const ext = isPng ? "png" : isJpg ? "jpg" : "pdf";
          evidenceMime = isPng ? "image/png" : isJpg ? "image/jpeg" : "application/pdf";
          evidenceOrigName = sanitizeFilename(req.file.originalname);
          const safeBase = evidenceOrigName.replace(/\.[^.]+$/, "");
          evidencePath = `verification-evidence/${u.id}/${Date.now()}_${safeBase}.${ext}`;
          await req.storage.uploadPrivate(evidencePath, buf, evidenceMime);
        }
        const reqId = crypto6.randomUUID();
        const supportsExtendedCols = await hasMigration003ProfileCols(db);
        await db.transaction(
          async (tx) => {
            await tx.execute(
              `INSERT INTO staff_verification_requests
               (id, user_id, position, department, designation, university_email, supporting_notes,
                evidence_object_path, evidence_original_filename, evidence_mime_type, status, created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', NOW(), NOW())`,
              [
                reqId,
                u.id,
                parsed.data.position,
                parsed.data.department,
                parsed.data.designation,
                u.email,
                parsed.data.supporting_notes,
                evidencePath,
                evidenceOrigName,
                evidenceMime
              ]
            );
            if (supportsExtendedCols) {
              await tx.execute(
                `UPDATE profiles
                 SET staff_position = $1,
                     department = $2,
                     designation = $3,
                     updated_at = NOW()
                 WHERE id = $4`,
                [parsed.data.position, parsed.data.department, parsed.data.designation || null, u.id]
              );
            }
            await syncModerationQueue(tx, "staff_verification", reqId, u.id, "pending");
            await writeAuditLog(tx, u.id, "staff_verification_requested", "staff_verification", reqId, {
              position: parsed.data.position,
              department: parsed.data.department,
              has_evidence: Boolean(evidencePath)
            });
          },
          { actorId: u.id, trustedServer: false }
        );
        const refreshedUser = await getAuthUserFromDb(db, u.id);
        return res.status(201).json({
          status: "pending",
          user: refreshedUser,
          request: {
            id: reqId,
            user_id: u.id,
            position: parsed.data.position,
            department: parsed.data.department,
            designation: parsed.data.designation,
            university_email: u.email,
            supporting_notes: parsed.data.supporting_notes,
            has_evidence: Boolean(evidencePath),
            evidence_original_filename: evidenceOrigName,
            status: "pending",
            reviewer_id: null,
            review_notes: null,
            reviewed_at: null,
            created_at: (/* @__PURE__ */ new Date()).toISOString(),
            updated_at: (/* @__PURE__ */ new Date()).toISOString()
          },
          message: "Your university staff verification request has been submitted for administrator review. Your account remains a standard member until approved."
        });
      } catch (err) {
        return next(err);
      }
    }
  );
  router.post(
    "/profile/avatar",
    requireAuth,
    avatarUpload.single("avatar"),
    async (req, res, next) => {
      try {
        if (!req.file) {
          return res.status(400).json({ error: "Please select an image file (PNG or JPEG, max 2MB)." });
        }
        const buf = req.file.buffer;
        const isPng = buf.subarray(0, 8).toString("hex") === "89504e470d0a1a0a";
        const isJpg = buf.subarray(0, 3).toString("hex") === "ffd8ff";
        if (!isPng && !isJpg) {
          return res.status(400).json({ error: "Only valid PNG or JPEG images are allowed for profile avatars." });
        }
        const ext = isPng ? "png" : "jpg";
        const mime = isPng ? "image/png" : "image/jpeg";
        const safeName = `${req.user.id}_${Date.now()}_${sanitizeFilename(req.file.originalname).replace(/\.[^.]+$/, "")}.${ext}`;
        await req.storage.uploadPrivate(`avatars/${safeName}`, buf, mime);
        const avatarUrl = `/api/auth/avatars/${safeName}`;
        await db.transaction(
          async (tx) => {
            await tx.execute("UPDATE profiles SET avatar_url = $1, updated_at = NOW() WHERE id = $2", [
              avatarUrl,
              req.user.id
            ]);
          },
          { actorId: req.user.id }
        );
        const user = await getAuthUserFromDb(db, req.user.id);
        return res.json({ avatar_url: avatarUrl, user });
      } catch (err) {
        return next(err);
      }
    }
  );
  router.get("/avatars/:filename", async (req, res, next) => {
    try {
      const safe = path3.basename(req.params.filename);
      if (!/^[a-zA-Z0-9._-]+$/.test(safe)) {
        return res.status(400).end();
      }
      const data = await req.storage.downloadPrivate(`avatars/${safe}`);
      if (!data) return res.status(404).end();
      const isPng = safe.toLowerCase().endsWith(".png");
      res.setHeader("Content-Type", isPng ? "image/png" : "image/jpeg");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "public, max-age=86400");
      return res.send(data);
    } catch (err) {
      return next(err);
    }
  });
  router.get("/users/:username", async (req, res, next) => {
    try {
      const row = await db.queryOne(
        `SELECT u.*, p.name AS program_name, s.name AS semester_name
         FROM profiles u
         LEFT JOIN programs p ON p.id = u.program_id
         LEFT JOIN semesters s ON s.id = u.semester_id
         WHERE lower(u.username) = $1`,
        [req.params.username.toLowerCase()]
      );
      if (!row) return res.status(404).json({ error: "User profile not found." });
      const privacy = row.privacy_settings || { show_program: true };
      const isSelf = req.user?.id === String(row.id);
      const posts = await db.query(
        `SELECT p.id, p.title, p.created_at, p.upvote_count, p.comment_count, c.name AS community_name, c.slug AS community_slug
         FROM posts p JOIN communities c ON c.id = p.community_id
         WHERE p.author_id = $1 AND p.is_hidden = FALSE
         ORDER BY p.created_at DESC LIMIT 20`,
        [String(row.id)]
      );
      const resources = await db.query(
        `SELECT r.id, r.title, r.status, r.download_count, r.upvote_count, r.created_at, sub.name AS subject_name, rc.name AS category_name
         FROM resources r
         JOIN subjects sub ON sub.id = r.subject_id
         JOIN resource_categories rc ON rc.id = r.category_id
         WHERE r.uploader_id = $1 ${isSelf ? "" : "AND r.status = 'approved'"}
         ORDER BY r.created_at DESC LIMIT 20`,
        [String(row.id)]
      );
      return res.json({
        profile: {
          id: row.id,
          username: row.username,
          display_name: row.display_name,
          avatar_url: row.avatar_url,
          bio: row.bio,
          role: row.role,
          university_email_verified: Boolean(row.university_email_verified),
          email_verified: Boolean(row.email_verified),
          program_id: privacy.show_program || isSelf ? row.program_id : null,
          program_name: privacy.show_program || isSelf ? row.program_name : null,
          semester_id: privacy.show_program || isSelf ? row.semester_id : null,
          semester_name: privacy.show_program || isSelf ? row.semester_name : null,
          department: privacy.show_program || isSelf ? row.department ? String(row.department) : null : null,
          student_id: isSelf ? row.student_id ? String(row.student_id) : null : null,
          staff_position: row.role === "verified_teacher" ? row.staff_position ? String(row.staff_position) : null : null,
          designation: row.role === "verified_teacher" ? row.designation ? String(row.designation) : null : null,
          interests: Array.isArray(row.interests) ? row.interests : [],
          account_status: row.account_status,
          created_at: new Date(String(row.created_at)).toISOString()
        },
        posts,
        resources
      });
    } catch (err) {
      return next(err);
    }
  });
  return router;
}

// server/routes/community.ts
import crypto7 from "node:crypto";
import { Router as Router4 } from "express";
import { z as z4 } from "zod";
async function getProfanityRules(db) {
  return db.query("SELECT * FROM profanity_dictionary");
}
async function canViewCommunity(db, req, visibility, communityId) {
  if (visibility === "public") return true;
  if (!req.user) return false;
  if (isAdminRole(req.user.role)) return true;
  if (visibility === "university_only") {
    return req.user.university_email_verified || req.user.role === "verified_student" || req.user.role === "verified_teacher" || req.user.role === "community_moderator";
  }
  if (visibility === "private_approval") {
    const member = await db.queryOne(
      "SELECT status FROM community_members WHERE community_id = $1 AND user_id = $2 AND status = 'joined'",
      [communityId, req.user.id]
    );
    return Boolean(member);
  }
  return false;
}
function createCommunityRouter(db) {
  const router = Router4();
  router.get("/communities", async (req, res, next) => {
    try {
      const includeArchived = req.query.includeArchived === "true" && req.user && isAdminRole(req.user.role);
      const viewerId = req.user?.id || null;
      const rows = await db.query(
        `SELECT c.*,
          (SELECT COUNT(*) FROM community_members cm WHERE cm.community_id = c.id AND cm.status = 'joined') AS member_count,
          (SELECT COUNT(*) FROM posts p WHERE p.community_id = c.id AND p.is_hidden = FALSE AND p.created_at >= NOW() - INTERVAL '7 days') AS recent_posts_count,
          (SELECT status FROM community_members cm2 WHERE cm2.community_id = c.id AND cm2.user_id = $1) AS membership_status,
          (SELECT 1 FROM community_moderators mod WHERE mod.community_id = c.id AND mod.user_id = $1) AS is_moderator
         FROM communities c
         ${includeArchived ? "" : "WHERE c.is_archived = FALSE"}
         ORDER BY c.kind ASC, member_count DESC, c.name ASC`,
        [viewerId]
      );
      const list = rows.map((c) => ({
        ...c,
        member_count: Number(c.member_count || 0),
        recent_posts_count: Number(c.recent_posts_count || 0),
        is_archived: Boolean(c.is_archived),
        is_member: c.membership_status === "joined",
        membership_status: c.membership_status || "none",
        is_moderator: Boolean(c.is_moderator)
      }));
      return res.json({ communities: list });
    } catch (err) {
      return next(err);
    }
  });
  router.post("/communities", requireAdmin, async (req, res, next) => {
    try {
      const parsed = z4.object({
        name: z4.string().min(2).max(80),
        description: z4.string().min(5).max(400),
        kind: z4.enum(["academic", "special"]).default("special"),
        visibility: z4.enum(["public", "university_only", "private_approval"]).default("public"),
        rules: z4.string().max(1e3).default("Be respectful and follow campus community guidelines.")
      }).safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid community." });
      }
      const baseSlug = parsed.data.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "community";
      const existingSlug = await db.queryOne("SELECT id FROM communities WHERE slug = $1", [baseSlug]);
      const slug = existingSlug ? `${baseSlug}-${crypto7.randomUUID().slice(0, 4)}` : baseSlug;
      const id = crypto7.randomUUID();
      await db.execute(
        "INSERT INTO communities (id, slug, name, description, kind, visibility, rules, is_archived, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, NOW())",
        [id, slug, parsed.data.name.trim(), parsed.data.description.trim(), parsed.data.kind, parsed.data.visibility, parsed.data.rules.trim()]
      );
      await writeAuditLog(db, req.user.id, "create_community", "community", id, parsed.data);
      return res.status(201).json({ id, slug, ...parsed.data });
    } catch (err) {
      return next(err);
    }
  });
  router.patch("/communities/:id", requireAdmin, async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: "Community not found." });
      const parsed = z4.object({
        name: z4.string().min(2).max(80).optional(),
        description: z4.string().max(400).optional(),
        visibility: z4.enum(["public", "university_only", "private_approval"]).optional(),
        rules: z4.string().max(1e3).optional(),
        is_archived: z4.boolean().optional()
      }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid community update." });
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
          req.params.id
        ]
      );
      await writeAuditLog(db, req.user.id, "update_community", "community", req.params.id, d);
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });
  router.post("/communities/:id/join", requireAuth, async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: "Community not found." });
      const comm = await db.queryOne(
        "SELECT * FROM communities WHERE id = $1 AND is_archived = FALSE",
        [req.params.id]
      );
      if (!comm) return res.status(404).json({ error: "Community not found." });
      if (req.user.role === "visitor") {
        return res.status(403).json({ error: "Visitors have read-only access." });
      }
      if (String(comm.visibility) === "university_only" && !req.user.university_email_verified && !isModeratorOrAbove(req.user.role)) {
        return res.status(403).json({ error: "Only verified Gandaki University members can join this community." });
      }
      const existing = await db.queryOne(
        "SELECT status FROM community_members WHERE community_id = $1 AND user_id = $2",
        [req.params.id, req.user.id]
      );
      if (existing) {
        await db.execute("DELETE FROM community_members WHERE community_id = $1 AND user_id = $2", [
          req.params.id,
          req.user.id
        ]);
        return res.json({ joined: false, status: "none" });
      }
      const status = String(comm.visibility) === "private_approval" ? "pending" : "joined";
      await db.execute(
        "INSERT INTO community_members (community_id, user_id, status, created_at) VALUES ($1, $2, $3, NOW())",
        [req.params.id, req.user.id, status]
      );
      return res.json({ joined: status === "joined", status });
    } catch (err) {
      return next(err);
    }
  });
  router.get("/posts", async (req, res, next) => {
    try {
      const { community_id, community_slug, sort = "latest", program_id, subject_id, bookmarked, mine } = req.query;
      const viewerId = req.user?.id || null;
      const conditions = ["p.is_hidden = FALSE", "c.is_archived = FALSE"];
      const params = [viewerId];
      const addParam = (val) => {
        params.push(val);
        return `$${params.length}`;
      };
      if (isUuid(community_id)) conditions.push(`p.community_id = ${addParam(community_id)}`);
      if (community_slug) conditions.push(`c.slug = ${addParam(community_slug)}`);
      if (isUuid(program_id)) conditions.push(`p.program_id = ${addParam(program_id)}`);
      if (isUuid(subject_id)) conditions.push(`p.subject_id = ${addParam(subject_id)}`);
      if (mine === "true" && req.user) conditions.push(`p.author_id = ${addParam(req.user.id)}`);
      if (bookmarked === "true" && req.user) {
        conditions.push(
          `EXISTS (SELECT 1 FROM bookmarks b WHERE b.user_id = ${addParam(req.user.id)} AND b.target_type = 'post' AND b.target_id = p.id)`
        );
      }
      if (req.user) {
        conditions.push(
          `NOT EXISTS (SELECT 1 FROM user_blocks ub WHERE ub.blocker_id = ${addParam(req.user.id)} AND ub.blocked_id = p.author_id)`
        );
      }
      let orderBy = "p.is_pinned DESC, p.created_at DESC";
      if (sort === "top") {
        orderBy = "p.is_pinned DESC, (p.upvote_count - p.downvote_count) DESC, p.created_at DESC";
      } else if (sort === "trending") {
        orderBy = "p.is_pinned DESC, ((p.upvote_count * 2 + p.comment_count * 3)::float / (1.0 + GREATEST(0, EXTRACT(EPOCH FROM (NOW() - p.created_at)) / 3600.0))) DESC";
      } else if (sort === "for_you" && isUuid(req.user?.program_id)) {
        const pParam = addParam(req.user.program_id);
        orderBy = `p.is_pinned DESC, (CASE WHEN p.program_id = ${pParam} THEN 1 ELSE 0 END) DESC, p.created_at DESC`;
      }
      const rows = await db.query(
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
         WHERE ${conditions.join(" AND ")}
         ORDER BY ${orderBy}
         LIMIT 60`,
        params
      );
      const visible = [];
      for (const r of rows) {
        if (await canViewCommunity(db, req, String(r.community_visibility), String(r.community_id))) {
          visible.push(r);
        }
      }
      const postIds = visible.map((r) => String(r.id));
      const pollMap = /* @__PURE__ */ new Map();
      const optionsByPoll = /* @__PURE__ */ new Map();
      const userPollVotes = /* @__PURE__ */ new Map();
      if (postIds.length > 0) {
        const pollRows = await db.query(
          "SELECT * FROM polls WHERE post_id = ANY($1::uuid[])",
          [postIds]
        );
        const pollIds = pollRows.map((p) => String(p.id));
        for (const pr of pollRows) {
          pollMap.set(String(pr.post_id), pr);
        }
        if (pollIds.length > 0) {
          const optRows = await db.query(
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
            const pvRows = await db.query(
              "SELECT poll_id, option_id FROM poll_votes WHERE poll_id = ANY($1::uuid[]) AND user_id = $2",
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
              percentage: totalVotes > 0 ? Math.round(o.vote_count / totalVotes * 100) : 0
            }))
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
          updated_at: new Date(String(r.updated_at)).toISOString()
        };
      });
      return res.json({ posts });
    } catch (err) {
      return next(err);
    }
  });
  router.post("/posts", requireAuth, async (req, res, next) => {
    try {
      const parsed = z4.object({
        community_id: z4.string().min(1),
        title: z4.string().max(200).default(""),
        body: z4.string().max(5e3).default(""),
        image_url: z4.string().regex(/^\/api\/media\/images\/[a-zA-Z0-9._-]+$/, "Invalid image reference.").nullable().optional(),
        flair: z4.string().max(40).optional().nullable(),
        tags: z4.array(z4.string().max(30)).max(5).default([]),
        program_id: z4.string().optional().nullable(),
        semester_id: z4.string().optional().nullable(),
        subject_id: z4.string().optional().nullable(),
        poll: z4.object({
          question: z4.string().min(3).max(200),
          options: z4.array(z4.string().min(1).max(100)).min(2).max(6)
        }).optional().nullable()
      }).safeParse(req.body);
      if (!parsed.success || !isUuid(parsed.data.community_id)) {
        return res.status(400).json({ error: parsed.success ? "Invalid community." : parsed.error.issues[0]?.message || "Invalid post." });
      }
      const cleanTitle = parsed.data.title.trim();
      const cleanBody = parsed.data.body.trim();
      const cleanImage = parsed.data.image_url || null;
      if (!cleanTitle && !cleanBody && !cleanImage) {
        return res.status(400).json({ error: "Please include text, a title, or an image to publish a post." });
      }
      const comm = await db.queryOne(
        "SELECT * FROM communities WHERE id = $1 AND is_archived = FALSE",
        [parsed.data.community_id]
      );
      if (!comm) return res.status(404).json({ error: "Community not found." });
      const perm = canPostInCommunity(req.user.role, comm.kind, String(comm.slug));
      if (!perm.allowed) return res.status(403).json({ error: perm.reason });
      if (!await canViewCommunity(db, req, String(comm.visibility), String(comm.id))) {
        return res.status(403).json({ error: "You do not have permission to post in this community." });
      }
      const rules = await getProfanityRules(db);
      const profCheck = checkTextAgainstDictionary(`${cleanTitle} ${cleanBody}`, rules);
      if (profCheck.blocked) {
        return res.status(400).json({
          error: "Your post contains prohibited abusive language and cannot be published.",
          flagged_terms: profCheck.matches.map((m) => m.term)
        });
      }
      const postId = crypto7.randomUUID();
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
            req.user.id,
            cleanTitle,
            cleanBody,
            cleanImage,
            parsed.data.flair?.trim() || null,
            cleanTags
          ]
        );
        await tx.execute(
          "INSERT INTO votes (user_id, target_type, target_id, value, created_at) VALUES ($1, 'post', $2, 1, NOW())",
          [req.user.id, postId]
        );
        for (const tagName of cleanTags) {
          const slug = tagName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || tagName.toLowerCase();
          await tx.execute(
            `INSERT INTO tags (id, name, slug, created_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (slug) DO NOTHING`,
            [crypto7.randomUUID(), tagName, slug]
          );
          const tagRow = await tx.queryOne("SELECT id FROM tags WHERE slug = $1", [slug]);
          if (tagRow) {
            await tx.execute(
              "INSERT INTO post_tags (post_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
              [postId, tagRow.id]
            );
          }
        }
        if (parsed.data.poll) {
          const pollId = crypto7.randomUUID();
          await tx.execute(
            "INSERT INTO polls (id, post_id, question, closes_at) VALUES ($1, $2, $3, $4::timestamptz)",
            [pollId, postId, parsed.data.poll.question.trim(), new Date(Date.now() + 14 * 86400 * 1e3).toISOString()]
          );
          for (let i = 0; i < parsed.data.poll.options.length; i++) {
            await tx.execute(
              "INSERT INTO poll_options (id, poll_id, label, sort_order) VALUES ($1, $2, $3, $4)",
              [crypto7.randomUUID(), pollId, parsed.data.poll.options[i].trim(), i + 1]
            );
          }
        }
      });
      return res.status(201).json({ id: postId, profanity_warning: profCheck.flagged });
    } catch (err) {
      return next(err);
    }
  });
  router.patch("/posts/:id", requireAuth, async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: "Post not found." });
      const post = await db.queryOne("SELECT * FROM posts WHERE id = $1", [req.params.id]);
      if (!post) return res.status(404).json({ error: "Post not found." });
      const isOwner = String(post.author_id) === req.user.id;
      const isMod = isAdminRole(req.user.role) || req.user.moderated_community_ids.includes(String(post.community_id));
      const parsed = z4.object({
        title: z4.string().max(200).optional(),
        body: z4.string().max(5e3).optional(),
        image_url: z4.string().regex(/^\/api\/media\/images\/[a-zA-Z0-9._-]+$/).nullable().optional(),
        is_pinned: z4.boolean().optional()
      }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid post update." });
      if (parsed.data.is_pinned !== void 0 && !isMod) {
        return res.status(403).json({ error: "Only community moderators or admins can pin posts." });
      }
      if ((parsed.data.title !== void 0 || parsed.data.body !== void 0 || parsed.data.image_url !== void 0) && !isOwner && !isAdminRole(req.user.role)) {
        return res.status(403).json({ error: "You can only edit your own posts." });
      }
      const nextImageUrl = parsed.data.image_url !== void 0 ? parsed.data.image_url : post.image_url ? String(post.image_url) : null;
      await db.execute(
        `UPDATE posts SET
          title = COALESCE($1, title),
          body = COALESCE($2, body),
          image_url = $3,
          is_pinned = COALESCE($4, is_pinned),
          updated_at = NOW()
         WHERE id = $5`,
        [
          parsed.data.title !== void 0 ? parsed.data.title.trim() : null,
          parsed.data.body !== void 0 ? parsed.data.body.trim() : null,
          nextImageUrl,
          parsed.data.is_pinned ?? null,
          req.params.id
        ]
      );
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });
  router.delete("/posts/:id", requireAuth, async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: "Post not found." });
      const post = await db.queryOne("SELECT * FROM posts WHERE id = $1", [req.params.id]);
      if (!post) return res.status(404).json({ error: "Post not found." });
      const isMod = isAdminRole(req.user.role) || req.user.moderated_community_ids.includes(String(post.community_id));
      if (String(post.author_id) !== req.user.id && !isMod) {
        return res.status(403).json({ error: "Unauthorized to delete this post." });
      }
      await db.execute("DELETE FROM posts WHERE id = $1", [req.params.id]);
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });
  router.post("/polls/:pollId/vote", requireAuth, async (req, res, next) => {
    try {
      if (req.user.role === "visitor") return res.status(403).json({ error: "Visitors cannot vote in polls." });
      if (!isUuid(req.params.pollId)) return res.status(404).json({ error: "Poll not found." });
      const parsed = z4.object({ option_id: z4.string().min(1) }).safeParse(req.body);
      if (!parsed.success || !isUuid(parsed.data.option_id)) {
        return res.status(400).json({ error: "Invalid poll option." });
      }
      await db.execute(
        `INSERT INTO poll_votes (poll_id, option_id, user_id, created_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (poll_id, user_id) DO UPDATE SET option_id = EXCLUDED.option_id, created_at = NOW()`,
        [req.params.pollId, parsed.data.option_id, req.user.id]
      );
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });
  router.get("/posts/:postId/comments", async (req, res, next) => {
    try {
      if (!isUuid(req.params.postId)) return res.status(404).json({ error: "Post not found." });
      const viewerId = req.user?.id || null;
      const rows = await db.query(
        `SELECT cm.*, u.display_name AS author_name, u.username AS author_username, u.role AS author_role, u.university_email_verified AS author_verified,
          (SELECT value FROM votes v WHERE v.user_id = $1 AND v.target_type = 'comment' AND v.target_id = cm.id) AS user_vote
         FROM comments cm
         JOIN profiles u ON u.id = cm.author_id
         WHERE cm.post_id = $2 AND cm.is_hidden = FALSE
         ORDER BY cm.created_at ASC`,
        [viewerId, req.params.postId]
      );
      const map = /* @__PURE__ */ new Map();
      const roots = [];
      for (const r of rows) {
        const item = {
          id: String(r.id),
          post_id: String(r.post_id),
          parent_comment_id: r.parent_comment_id ? String(r.parent_comment_id) : null,
          author_id: String(r.author_id),
          author_name: String(r.author_name),
          author_username: String(r.author_username),
          author_role: r.author_role,
          author_verified: Boolean(r.author_verified),
          body: String(r.body),
          upvote_count: Number(r.upvote_count || 0),
          downvote_count: Number(r.downvote_count || 0),
          user_vote: Number(r.user_vote || 0),
          created_at: new Date(String(r.created_at)).toISOString(),
          replies: []
        };
        map.set(item.id, item);
      }
      for (const item of map.values()) {
        if (item.parent_comment_id && map.has(item.parent_comment_id)) {
          map.get(item.parent_comment_id).replies.push(item);
        } else {
          roots.push(item);
        }
      }
      return res.json({ comments: roots });
    } catch (err) {
      return next(err);
    }
  });
  router.post("/posts/:postId/comments", requireAuth, async (req, res, next) => {
    try {
      if (!isUuid(req.params.postId)) return res.status(404).json({ error: "Post not found." });
      const parsed = z4.object({
        body: z4.string().min(1).max(3e3),
        parent_comment_id: z4.string().nullable().optional()
      }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Comment text is required." });
      const post = await db.queryOne(
        "SELECT p.*, c.kind AS community_kind, c.slug AS community_slug FROM posts p JOIN communities c ON c.id = p.community_id WHERE p.id = $1",
        [req.params.postId]
      );
      if (!post) return res.status(404).json({ error: "Post not found." });
      if (!canVoteOrComment(
        req.user.role,
        post.community_kind,
        String(post.community_slug)
      )) {
        return res.status(403).json({ error: "Your account role does not allow commenting in this community." });
      }
      const rules = await getProfanityRules(db);
      const profCheck = checkTextAgainstDictionary(parsed.data.body, rules);
      if (profCheck.blocked) {
        return res.status(400).json({ error: "Comment contains prohibited abusive language." });
      }
      const id = crypto7.randomUUID();
      await db.transaction(async (tx) => {
        await tx.execute(
          "INSERT INTO comments (id, post_id, parent_comment_id, author_id, body, upvote_count, downvote_count, is_hidden, created_at) VALUES ($1, $2, $3, $4, $5, 1, 0, FALSE, NOW())",
          [
            id,
            req.params.postId,
            isUuid(parsed.data.parent_comment_id) ? parsed.data.parent_comment_id : null,
            req.user.id,
            parsed.data.body.trim()
          ]
        );
        await tx.execute("UPDATE posts SET comment_count = comment_count + 1 WHERE id = $1", [req.params.postId]);
        if (String(post.author_id) !== req.user.id) {
          await createNotification(
            tx,
            String(post.author_id),
            "post_reply",
            "New Reply on Your Post",
            `${req.user.display_name} commented on "${String(post.title).slice(0, 60)}"`,
            `/communities/${post.community_slug}`
          );
        }
      });
      return res.status(201).json({ id });
    } catch (err) {
      return next(err);
    }
  });
  router.post("/votes", requireAuth, async (req, res, next) => {
    try {
      if (req.user.role === "visitor") {
        return res.status(403).json({ error: "Visitors have read-only access and cannot vote." });
      }
      const parsed = z4.object({
        target_type: z4.enum(["post", "comment", "resource", "idea"]),
        target_id: z4.string().min(1),
        value: z4.union([z4.literal(1), z4.literal(-1), z4.literal(0)])
      }).safeParse(req.body);
      if (!parsed.success || !isUuid(parsed.data.target_id)) {
        return res.status(400).json({ error: "Invalid vote request." });
      }
      const { target_type, target_id, value } = parsed.data;
      const newVal = await db.transaction(async (tx) => {
        const existing = await tx.queryOne(
          "SELECT value FROM votes WHERE user_id = $1 AND target_type = $2 AND target_id = $3",
          [req.user.id, target_type, target_id]
        );
        const oldVal = existing?.value ?? 0;
        const resolved = value === oldVal ? 0 : value;
        if (resolved === 0) {
          await tx.execute(
            "DELETE FROM votes WHERE user_id = $1 AND target_type = $2 AND target_id = $3",
            [req.user.id, target_type, target_id]
          );
        } else {
          await tx.execute(
            `INSERT INTO votes (user_id, target_type, target_id, value, created_at)
             VALUES ($1, $2, $3, $4, NOW())
             ON CONFLICT (user_id, target_type, target_id) DO UPDATE SET value = EXCLUDED.value, created_at = NOW()`,
            [req.user.id, target_type, target_id, resolved]
          );
        }
        const upDelta = (resolved === 1 ? 1 : 0) - (oldVal === 1 ? 1 : 0);
        const downDelta = (resolved === -1 ? 1 : 0) - (oldVal === -1 ? 1 : 0);
        if (target_type === "post") {
          await tx.execute(
            "UPDATE posts SET upvote_count = GREATEST(0, upvote_count + $1), downvote_count = GREATEST(0, downvote_count + $2) WHERE id = $3",
            [upDelta, downDelta, target_id]
          );
        } else if (target_type === "comment") {
          await tx.execute(
            "UPDATE comments SET upvote_count = GREATEST(0, upvote_count + $1), downvote_count = GREATEST(0, downvote_count + $2) WHERE id = $3",
            [upDelta, downDelta, target_id]
          );
        } else if (target_type === "resource") {
          await tx.execute(
            "UPDATE resources SET upvote_count = GREATEST(0, upvote_count + $1) WHERE id = $2",
            [upDelta, target_id]
          );
        } else if (target_type === "idea") {
          await tx.execute(
            "UPDATE ideas SET upvote_count = GREATEST(0, upvote_count + $1) WHERE id = $2",
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
  router.post("/bookmarks/toggle", requireAuth, async (req, res, next) => {
    try {
      const parsed = z4.object({
        target_type: z4.enum(["post", "resource"]),
        target_id: z4.string().min(1)
      }).safeParse(req.body);
      if (!parsed.success || !isUuid(parsed.data.target_id)) {
        return res.status(400).json({ error: "Invalid bookmark target." });
      }
      const existing = await db.queryOne(
        "SELECT 1 FROM bookmarks WHERE user_id = $1 AND target_type = $2 AND target_id = $3",
        [req.user.id, parsed.data.target_type, parsed.data.target_id]
      );
      if (existing) {
        await db.execute(
          "DELETE FROM bookmarks WHERE user_id = $1 AND target_type = $2 AND target_id = $3",
          [req.user.id, parsed.data.target_type, parsed.data.target_id]
        );
        return res.json({ bookmarked: false });
      }
      await db.execute(
        "INSERT INTO bookmarks (user_id, target_type, target_id, created_at) VALUES ($1, $2, $3, NOW())",
        [req.user.id, parsed.data.target_type, parsed.data.target_id]
      );
      return res.json({ bookmarked: true });
    } catch (err) {
      return next(err);
    }
  });
  router.get("/bookmarks", requireAuth, async (req, res, next) => {
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
          [req.user.id]
        ),
        db.query(
          `SELECT p.id, p.title, c.name AS community_name, c.slug AS community_slug
           FROM bookmarks b
           JOIN posts p ON p.id = b.target_id
           JOIN communities c ON c.id = p.community_id
           WHERE b.user_id = $1 AND b.target_type = 'post'
           ORDER BY b.created_at DESC`,
          [req.user.id]
        )
      ]);
      return res.json({ resources, posts });
    } catch (err) {
      return next(err);
    }
  });
  router.post("/reports", requireAuth, async (req, res, next) => {
    try {
      if (req.user.role === "visitor") {
        return res.status(403).json({ error: "Sign in with a member account to submit reports." });
      }
      const parsed = z4.object({
        target_type: z4.enum(["post", "comment", "resource", "confession", "user"]),
        target_id: z4.string().min(1),
        reason: z4.string().min(3).max(120),
        details: z4.string().max(600).default("")
      }).safeParse(req.body);
      if (!parsed.success || !isUuid(parsed.data.target_id)) {
        return res.status(400).json({ error: "Please provide a valid report target and reason." });
      }
      const id = crypto7.randomUUID();
      await db.transaction(async (tx) => {
        await tx.execute(
          "INSERT INTO reports (id, reporter_id, target_type, target_id, reason, details, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, 'open', NOW())",
          [
            id,
            req.user.id,
            parsed.data.target_type,
            parsed.data.target_id,
            parsed.data.reason.trim(),
            parsed.data.details.trim()
          ]
        );
        if (parsed.data.target_type === "resource") {
          await tx.execute(
            "INSERT INTO resource_reports (id, resource_id, reporter_id, reason, details, status, created_at) VALUES ($1, $2, $3, $4, $5, 'open', NOW())",
            [crypto7.randomUUID(), parsed.data.target_id, req.user.id, parsed.data.reason.trim(), parsed.data.details.trim()]
          );
        }
      });
      return res.status(201).json({ id, message: "Report submitted for moderator review." });
    } catch (err) {
      return next(err);
    }
  });
  return router;
}

// server/routes/media.ts
import crypto8 from "node:crypto";
import path4 from "node:path";
import { Router as Router5 } from "express";
import multer3 from "multer";
function detectImageExtension(buf) {
  if (buf.length < 12) return null;
  if (buf.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") {
    return { ext: "png", mime: "image/png" };
  }
  if (buf.subarray(0, 3).toString("hex") === "ffd8ff") {
    return { ext: "jpg", mime: "image/jpeg" };
  }
  if (buf.subarray(0, 4).toString("ascii") === "GIF8") {
    return { ext: "gif", mime: "image/gif" };
  }
  if (buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") {
    return { ext: "webp", mime: "image/webp" };
  }
  return null;
}
function mimeFromExt(filename) {
  const ext = path4.extname(filename).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/jpeg";
}
function createMediaRouter() {
  const router = Router5();
  const upload = multer3({
    storage: multer3.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }
  });
  router.post("/media/upload", requireAuth, upload.single("image"), async (req, res, next) => {
    try {
      if (req.user.role === "visitor") {
        return res.status(403).json({ error: "Visitors cannot upload post images." });
      }
      if (!req.file) {
        return res.status(400).json({ error: "Please select an image file (PNG, JPEG, WebP, or GIF, max 5 MB)." });
      }
      const detected = detectImageExtension(req.file.buffer);
      if (!detected) {
        return res.status(400).json({ error: "Only valid PNG, JPEG, WebP, or GIF images are permitted." });
      }
      const filename = `${Date.now()}_${crypto8.randomUUID().slice(0, 12)}.${detected.ext}`;
      await req.storage.uploadPrivate(`media/${filename}`, req.file.buffer, detected.mime);
      return res.status(201).json({
        image_url: `/api/media/images/${filename}`,
        mime: detected.mime,
        size: req.file.size
      });
    } catch (err) {
      return next(err);
    }
  });
  router.get("/media/images/:filename", async (req, res, next) => {
    try {
      const safe = path4.basename(req.params.filename);
      if (!/^[a-zA-Z0-9._-]+$/.test(safe)) {
        return res.status(400).end();
      }
      const data = await req.storage.downloadPrivate(`media/${safe}`);
      if (!data) {
        return res.status(404).end();
      }
      res.setHeader("Content-Type", mimeFromExt(safe));
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "public, max-age=86400");
      return res.send(data);
    } catch (err) {
      return next(err);
    }
  });
  return router;
}

// server/routes/search.ts
import crypto9 from "node:crypto";
import { Router as Router6 } from "express";
function createSearchRouter(db) {
  const router = Router6();
  router.get("/search", async (req, res, next) => {
    try {
      const q = String(req.query.q || "").trim();
      const typeFilter = String(req.query.type || "all");
      const programId = String(req.query.program_id || "");
      const semesterId = String(req.query.semester_id || "");
      const subjectId = String(req.query.subject_id || "");
      const categoryId = String(req.query.category_id || "");
      const year = String(req.query.year || "");
      const sort = String(req.query.sort || "relevance");
      const recordHistory = req.query.track === "1";
      if (!q || q.length < 2) {
        return res.json({ results: [], total: 0, query: q });
      }
      const likePattern = `%${q.toLowerCase()}%`;
      const viewer = req.user;
      const results = [];
      const shouldQuery = (kind) => typeFilter === "all" || typeFilter === kind;
      if (shouldQuery("program")) {
        const progs = await db.query(
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
            type: "program",
            id: String(p.id),
            title: `${p.code} \u2014 ${p.name}`,
            snippet: String(p.description || ""),
            subtitle: "Academic Program",
            link_path: `/academic?program=${p.id}`,
            score: 8 + Number(p.trgm_score || 0) * 10,
            meta: { code: String(p.code), created_at: String(p.created_at) }
          });
        }
      }
      if (shouldQuery("semester")) {
        const sems = await db.query(
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
            type: "semester",
            id: String(sem.id),
            title: `${sem.p_code} \xB7 ${sem.name}`,
            snippet: `Semester ${sem.number} curriculum and uploaded PDFs`,
            subtitle: `${sem.p_code} \xB7 Academic Semester`,
            link_path: `/academic?program=${sem.program_id}&semester=${sem.id}`,
            score: 6,
            meta: { program_id: String(sem.program_id), created_at: String(sem.created_at) }
          });
        }
      }
      if (shouldQuery("subject")) {
        const subjs = await db.query(
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
            type: "subject",
            id: String(s.id),
            title: String(s.name),
            snippet: String(s.description || ""),
            subtitle: `${s.p_code} \xB7 ${s.sem_name} \xB7 ${s.code || "Subject"}`,
            link_path: `/academic?program=${s.program_id}&semester=${s.semester_id}&subject=${s.id}`,
            score: 6 + Number(s.fts_rank || 0) * 10 + Number(s.trgm_score || 0) * 10 + (String(s.name).toLowerCase().includes(q.toLowerCase()) ? 8 : 0),
            meta: { program_id: String(s.program_id), semester_id: String(s.semester_id), created_at: String(s.created_at) }
          });
        }
      }
      if (shouldQuery("folder")) {
        const folders = await db.query(
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
            type: "folder",
            id: String(f.id),
            title: String(f.name),
            snippet: `Topic folder inside ${f.subject_name}`,
            subtitle: `${f.p_code} \xB7 ${f.subject_name} \xB7 Topic Folder`,
            link_path: `/academic?program=${f.program_id}&semester=${f.semester_id}&subject=${f.subject_id}`,
            score: 5,
            meta: { created_at: String(f.created_at) }
          });
        }
      }
      if (shouldQuery("resource")) {
        const resRows = await db.query(
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
            type: "resource",
            id: String(r.id),
            title: String(r.title),
            snippet: String(r.description || ""),
            subtitle: `${r.p_code} \xB7 ${r.sem_name} \xB7 ${r.sub_name} \xB7 ${r.cat_name}`,
            link_path: `/academic?program=${r.program_id}&semester=${r.semester_id}&subject=${r.subject_id}&resource=${r.id}`,
            score: 5 + Number(r.fts_rank || 0) * 10 + Number(r.trgm_score || 0) * 8 + (sort === "popular" ? Number(r.download_count || 0) + Number(r.upvote_count || 0) : 0),
            meta: {
              downloads: Number(r.download_count || 0),
              upvotes: Number(r.upvote_count || 0),
              year: String(r.academic_year),
              created_at: new Date(String(r.created_at)).toISOString()
            }
          });
        }
      }
      if (shouldQuery("community")) {
        const comms = await db.query(
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
          if (String(c.visibility) === "private_approval") {
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
            type: "community",
            id: String(c.id),
            title: String(c.name),
            snippet: String(c.description),
            subtitle: `${c.kind === "academic" ? "Academic Community" : "Community"} \xB7 ${String(c.visibility).replace("_", " ")}`,
            link_path: `/communities/${c.slug}`,
            score: 6 + Number(c.fts_rank || 0) * 8 + Number(c.trgm_score || 0) * 8,
            meta: { slug: String(c.slug), created_at: new Date(String(c.created_at)).toISOString() }
          });
        }
      }
      if (shouldQuery("post")) {
        const postRows = await db.query(
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
          if (isUuid(programId) && String(p.program_id || "") !== programId) continue;
          if (String(p.comm_vis) === "university_only" && (!viewer || !viewer.university_email_verified && !isAdminRole(viewer.role))) continue;
          if (String(p.comm_vis) === "private_approval") continue;
          results.push({
            type: "post",
            id: String(p.id),
            title: String(p.title) || "Image Post",
            snippet: String(p.body).slice(0, 160),
            subtitle: `${p.comm_name} \xB7 Posted by ${p.author_name}`,
            link_path: `/communities/${p.comm_slug}?post=${p.id}`,
            score: 5 + Number(p.fts_rank || 0) * 10 + Number(p.trgm_score || 0) * 6 + (sort === "popular" ? Number(p.upvote_count || 0) * 2 : 0),
            meta: {
              upvotes: Number(p.upvote_count || 0),
              comments: Number(p.comment_count || 0),
              created_at: new Date(String(p.created_at)).toISOString()
            }
          });
        }
      }
      if (shouldQuery("comment")) {
        const cmtRows = await db.query(
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
          if (String(cm.comm_vis) === "university_only" && (!viewer || !viewer.university_email_verified && !isAdminRole(viewer.role))) continue;
          if (String(cm.comm_vis) === "private_approval") continue;
          results.push({
            type: "comment",
            id: String(cm.id),
            title: `Comment on "${String(cm.post_title || "Post")}"`,
            snippet: String(cm.body).slice(0, 160),
            subtitle: `${cm.comm_name} \xB7 Reply by ${cm.author_name}`,
            link_path: `/communities/${cm.comm_slug}?post=${cm.post_id}`,
            score: 4,
            meta: { created_at: new Date(String(cm.created_at)).toISOString() }
          });
        }
      }
      if (shouldQuery("tag")) {
        const tagRows = await db.query(
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
            type: "tag",
            id: String(t.id),
            title: `#${t.name}`,
            snippet: `${Number(t.post_count || 0)} tagged discussions`,
            subtitle: "Discussion Tag",
            link_path: "/communities",
            score: 4,
            meta: { slug: String(t.slug) }
          });
        }
      }
      if (shouldQuery("user")) {
        const userRows = await db.query(
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
            type: "user",
            id: String(u.id),
            title: String(u.display_name),
            snippet: String(u.bio || ""),
            subtitle: `@${u.username} \xB7 ${String(u.role).replace("_", " ")}`,
            link_path: `/profile/${u.username}`,
            score: 3 + Number(u.trgm_score || 0) * 8,
            meta: {
              username: String(u.username),
              verified: Boolean(u.university_email_verified),
              created_at: new Date(String(u.created_at)).toISOString()
            }
          });
        }
      }
      if (shouldQuery("opportunity")) {
        const opps = await db.query(
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
            type: "opportunity",
            id: String(o.id),
            title: String(o.title) || "Opportunity",
            snippet: String(o.description).slice(0, 140),
            subtitle: `${o.kind} \xB7 ${o.organization} \xB7 Deadline ${o.deadline}`,
            link_path: "/opportunities",
            score: 5,
            meta: { kind: String(o.kind), deadline: String(o.deadline), created_at: new Date(String(o.created_at)).toISOString() }
          });
        }
      }
      if (shouldQuery("event")) {
        const evs = await db.query(
          `SELECT * FROM events
           WHERE to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(location, '') || ' ' || coalesce(description, '')) @@ plainto_tsquery('simple', $1)
              OR lower(title) LIKE $2 OR lower(description) LIKE $2 OR lower(location) LIKE $2
           LIMIT 20`,
          [q, likePattern]
        );
        for (const e of evs) {
          results.push({
            type: "event",
            id: String(e.id),
            title: String(e.title) || "Campus Event",
            snippet: String(e.description).slice(0, 140),
            subtitle: `${e.kind} \xB7 ${e.location}`,
            link_path: "/events",
            score: 5,
            meta: { starts_at: String(e.starts_at), created_at: new Date(String(e.created_at)).toISOString() }
          });
        }
      }
      if (shouldQuery("study_group")) {
        const sgs = await db.query(
          `SELECT * FROM study_groups
           WHERE to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(description, '')) @@ plainto_tsquery('simple', $1)
              OR lower(name) LIKE $2 OR lower(description) LIKE $2
           LIMIT 20`,
          [q, likePattern]
        );
        for (const sg of sgs) {
          results.push({
            type: "study_group",
            id: String(sg.id),
            title: String(sg.name),
            snippet: String(sg.description).slice(0, 140),
            subtitle: `Study Group \xB7 ${sg.schedule_text}`,
            link_path: "/study-groups",
            score: 4,
            meta: { members: Number(sg.member_count || 0), created_at: new Date(String(sg.created_at)).toISOString() }
          });
        }
      }
      if (shouldQuery("idea")) {
        const ideas = await db.query(
          `SELECT * FROM ideas
           WHERE to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(problem_statement, '') || ' ' || coalesce(proposed_solution, '')) @@ plainto_tsquery('simple', $1)
              OR lower(title) LIKE $2 OR lower(problem_statement) LIKE $2 OR lower(proposed_solution) LIKE $2
           LIMIT 20`,
          [q, likePattern]
        );
        for (const i of ideas) {
          results.push({
            type: "idea",
            id: String(i.id),
            title: String(i.title) || "Campus Idea",
            snippet: String(i.problem_statement).slice(0, 140),
            subtitle: `GetIdeas \xB7 ${String(i.status).replace(/_/g, " ")}`,
            link_path: "/ideas",
            score: 4,
            meta: { upvotes: Number(i.upvote_count || 0), created_at: new Date(String(i.created_at)).toISOString() }
          });
        }
      }
      if (shouldQuery("confession")) {
        const confs = await db.query(
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
            type: "confession",
            id: String(c.id),
            title: String(c.title) || "Campus Confession",
            snippet: String(c.body).slice(0, 140),
            subtitle: `Confessions \xB7 ${c.category}`,
            link_path: "/confessions",
            score: 3,
            meta: { category: String(c.category), created_at: new Date(String(c.created_at)).toISOString() }
          });
        }
      }
      if (shouldQuery("complaint")) {
        const comps = await db.query(
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
            type: "complaint",
            id: String(cm.id),
            title: String(cm.title) || "Public Feedback",
            snippet: String(cm.body).slice(0, 140),
            subtitle: `Public Feedback \xB7 ${cm.category} \xB7 ${String(cm.status).replace(/_/g, " ")}`,
            link_path: "/complaints",
            score: 3,
            meta: { status: String(cm.status), created_at: new Date(String(cm.created_at)).toISOString() }
          });
        }
      }
      if (sort === "newest") {
        results.sort((a, b) => String(b.meta.created_at || "").localeCompare(String(a.meta.created_at || "")));
      } else {
        results.sort((a, b) => b.score - a.score);
      }
      if (recordHistory) {
        await db.execute(
          "INSERT INTO search_events (id, query_normalized, display_query, user_id, result_count, cleared_by_user, created_at) VALUES ($1, $2, $3, $4, $5, FALSE, NOW())",
          [crypto9.randomUUID(), q.toLowerCase(), q, viewer?.id ?? null, results.length]
        );
      }
      return res.json({ results: results.slice(0, 60), total: results.length, query: q });
    } catch (err) {
      return next(err);
    }
  });
  router.get("/search/suggestions", async (req, res, next) => {
    try {
      const q = String(req.query.q || "").trim().toLowerCase();
      if (!q || q.length < 2) return res.json({ suggestions: [] });
      const like = `%${q}%`;
      const [subjects, resources, communities, posts, users] = await Promise.all([
        db.query(
          `SELECT s.id, s.name, p.code AS p_code, sem.name AS sem_name, s.program_id, s.semester_id
           FROM subjects s JOIN programs p ON p.id = s.program_id JOIN semesters sem ON sem.id = s.semester_id
           WHERE s.is_archived = FALSE AND (lower(s.name) LIKE $1 OR similarity(s.name, $2) > 0.25)
           LIMIT 4`,
          [like, q]
        ),
        db.query(
          `SELECT r.id, r.title, rc.name AS cat_name, r.program_id, r.semester_id, r.subject_id
           FROM resources r JOIN resource_categories rc ON rc.id = r.category_id
           WHERE r.status = 'approved' AND lower(r.title) LIKE $1 LIMIT 4`,
          [like]
        ),
        db.query(
          "SELECT id, name, slug FROM communities WHERE is_archived = FALSE AND visibility <> 'private_approval' AND lower(name) LIKE $1 LIMIT 3",
          [like]
        ),
        db.query(
          "SELECT p.id, p.title, c.slug AS comm_slug FROM posts p JOIN communities c ON c.id = p.community_id WHERE p.is_hidden = FALSE AND c.visibility = 'public' AND lower(p.title) LIKE $1 LIMIT 3",
          [like]
        ),
        db.query(
          "SELECT id, username, display_name FROM profiles WHERE account_status = 'active' AND role NOT IN ('admin', 'super_admin') AND (lower(display_name) LIKE $1 OR lower(username) LIKE $1) LIMIT 3",
          [like]
        )
      ]);
      const suggestions = [
        ...subjects.map((s) => ({
          group: "Subjects",
          label: String(s.name),
          sublabel: `${s.p_code} \xB7 ${s.sem_name}`,
          link_path: `/academic?program=${s.program_id}&semester=${s.semester_id}&subject=${s.id}`
        })),
        ...resources.map((r) => ({
          group: "Documents",
          label: String(r.title),
          sublabel: String(r.cat_name),
          link_path: `/academic?program=${r.program_id}&semester=${r.semester_id}&subject=${r.subject_id}&resource=${r.id}`
        })),
        ...communities.map((c) => ({
          group: "Communities",
          label: String(c.name),
          sublabel: "Community",
          link_path: `/communities/${c.slug}`
        })),
        ...posts.map((p) => ({
          group: "Discussions",
          label: String(p.title),
          sublabel: "Discussion",
          link_path: `/communities/${p.comm_slug}?post=${p.id}`
        })),
        ...users.map((u) => ({
          group: "People",
          label: String(u.display_name),
          sublabel: `@${u.username}`,
          link_path: `/profile/${u.username}`
        }))
      ];
      return res.json({ suggestions });
    } catch (err) {
      return next(err);
    }
  });
  router.get("/search/history", requireAuth, async (req, res, next) => {
    try {
      const rows = await db.query(
        `SELECT MAX(display_query) AS query, MAX(created_at) AS last_searched
         FROM search_events
         WHERE user_id = $1 AND cleared_by_user = FALSE
         GROUP BY query_normalized
         ORDER BY MAX(created_at) DESC
         LIMIT 8`,
        [req.user.id]
      );
      return res.json({ history: rows });
    } catch (err) {
      return next(err);
    }
  });
  router.delete("/search/history", requireAuth, async (req, res, next) => {
    try {
      await db.execute("UPDATE search_events SET cleared_by_user = TRUE WHERE user_id = $1", [req.user.id]);
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });
  router.get("/trending", async (req, res, next) => {
    try {
      const intervalStr = req.query.window === "week" ? "7 days" : "1 day";
      const [trendingSearches, trendingCommunities, popularResources, trendingDiscussions, upcomingEvents] = await Promise.all([
        db.query(
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
        )
      ]);
      const formattedSearches = trendingSearches.map((s) => {
        const recent = Number(s.recent_count || 0);
        const prior = Number(s.prior_count || 0);
        return {
          query: s.query,
          count: recent,
          growth_pct: prior > 0 ? Math.round((recent - prior) / prior * 100) : 100
        };
      });
      return res.json({
        trending_searches: formattedSearches,
        trending_communities: trendingCommunities,
        popular_resources: popularResources,
        trending_discussions: trendingDiscussions,
        upcoming_events: upcomingEvents
      });
    } catch (err) {
      return next(err);
    }
  });
  return router;
}

// server/routes/social.ts
import crypto10 from "node:crypto";
import { Router as Router7 } from "express";
import { z as z5 } from "zod";
function canonicalPair(a, b) {
  return a < b ? [a, b] : [b, a];
}
function createSocialRouter(db) {
  const router = Router7();
  router.get("/people", requireAuth, async (req, res, next) => {
    try {
      const q = String(req.query.q || "").trim().toLowerCase();
      const viewerId = req.user.id;
      const rows = await db.query(
        `SELECT u.id, u.username, u.display_name, u.avatar_url, u.bio, u.role,
                u.university_email_verified, u.program_id, u.semester_id, u.privacy_settings,
                p.name AS program_name, s.name AS semester_name
         FROM profiles u
         LEFT JOIN programs p ON p.id = u.program_id
         LEFT JOIN semesters s ON s.id = u.semester_id
         WHERE u.id <> $1 AND u.account_status = 'active'
           AND u.role NOT IN ('admin', 'super_admin')
           AND NOT EXISTS (
             SELECT 1 FROM user_blocks ub
             WHERE (ub.blocker_id = $1 AND ub.blocked_id = u.id) OR (ub.blocker_id = u.id AND ub.blocked_id = $1)
           )
           ${q ? "AND (lower(u.display_name) LIKE $2 OR lower(u.username) LIKE $2 OR lower(u.bio) LIKE $2)" : ""}
         ORDER BY u.university_email_verified DESC, u.created_at DESC
         LIMIT 40`,
        q ? [viewerId, `%${q}%`] : [viewerId]
      );
      const [myConns, myPending] = await Promise.all([
        db.query(
          "SELECT user_a_id, user_b_id FROM connections WHERE user_a_id = $1 OR user_b_id = $1",
          [viewerId]
        ),
        db.query(
          "SELECT id, sender_id, receiver_id FROM connection_requests WHERE status = 'pending' AND (sender_id = $1 OR receiver_id = $1)",
          [viewerId]
        )
      ]);
      const connPeerSet = /* @__PURE__ */ new Set();
      for (const c of myConns) {
        connPeerSet.add(String(c.user_a_id) === viewerId ? String(c.user_b_id) : String(c.user_a_id));
      }
      const pendingByPeer = /* @__PURE__ */ new Map();
      for (const pr of myPending) {
        const peer = String(pr.sender_id) === viewerId ? String(pr.receiver_id) : String(pr.sender_id);
        pendingByPeer.set(peer, { id: String(pr.id), sender_id: String(pr.sender_id) });
      }
      const people = rows.map((r) => {
        const pid = String(r.id);
        const connected = connPeerSet.has(pid);
        const pendingReq = pendingByPeer.get(pid);
        const privacy = r.privacy_settings || {
          show_program: true,
          allow_connection_requests: true
        };
        return {
          id: pid,
          username: r.username,
          display_name: r.display_name,
          avatar_url: r.avatar_url,
          bio: r.bio,
          role: r.role,
          university_email_verified: Boolean(r.university_email_verified),
          program_name: privacy.show_program ? r.program_name : null,
          semester_name: privacy.show_program ? r.semester_name : null,
          allow_connection_requests: Boolean(privacy.allow_connection_requests ?? true),
          connection_status: connected ? "connected" : pendingReq ? pendingReq.sender_id === viewerId ? "outgoing_pending" : "incoming_pending" : "none",
          pending_request_id: pendingReq?.id ?? null
        };
      });
      return res.json({ people });
    } catch (err) {
      return next(err);
    }
  });
  router.get("/connections", requireAuth, async (req, res, next) => {
    try {
      const uid = req.user.id;
      const [conns, incoming, outgoing, blocked] = await Promise.all([
        db.query(
          `SELECT c.id AS connection_id, c.created_at,
                  u.id AS peer_id, u.username, u.display_name, u.avatar_url, u.bio, u.role, u.university_email_verified,
                  p.name AS program_name, s.name AS semester_name
           FROM connections c
           JOIN profiles u ON u.id = (CASE WHEN c.user_a_id = $1 THEN c.user_b_id ELSE c.user_a_id END)
           LEFT JOIN programs p ON p.id = u.program_id
           LEFT JOIN semesters s ON s.id = u.semester_id
           WHERE (c.user_a_id = $1 OR c.user_b_id = $1) AND u.role NOT IN ('admin', 'super_admin')
           ORDER BY c.created_at DESC`,
          [uid]
        ),
        db.query(
          `SELECT cr.id, cr.note, cr.status, cr.created_at,
                  u.id AS peer_id, u.username, u.display_name, u.avatar_url, u.bio, u.role, u.university_email_verified
           FROM connection_requests cr
           JOIN profiles u ON u.id = cr.sender_id
           WHERE cr.receiver_id = $1 AND cr.status = 'pending' AND u.role NOT IN ('admin', 'super_admin')
           ORDER BY cr.created_at DESC`,
          [uid]
        ),
        db.query(
          `SELECT cr.id, cr.note, cr.status, cr.created_at,
                  u.id AS peer_id, u.username, u.display_name, u.avatar_url, u.bio, u.role, u.university_email_verified
           FROM connection_requests cr
           JOIN profiles u ON u.id = cr.receiver_id
           WHERE cr.sender_id = $1 AND cr.status = 'pending' AND u.role NOT IN ('admin', 'super_admin')
           ORDER BY cr.created_at DESC`,
          [uid]
        ),
        db.query(
          `SELECT u.id, u.username, u.display_name, ub.created_at
           FROM user_blocks ub JOIN profiles u ON u.id = ub.blocked_id
           WHERE ub.blocker_id = $1`,
          [uid]
        )
      ]);
      return res.json({
        connections: conns.map((c) => ({
          connection_id: c.connection_id,
          created_at: new Date(String(c.created_at)).toISOString(),
          peer: {
            id: c.peer_id,
            username: c.username,
            display_name: c.display_name,
            avatar_url: c.avatar_url,
            bio: c.bio,
            role: c.role,
            university_email_verified: Boolean(c.university_email_verified),
            program_name: c.program_name,
            semester_name: c.semester_name
          }
        })),
        incoming: incoming.map((r) => ({
          id: r.id,
          direction: "incoming",
          note: r.note,
          status: r.status,
          created_at: new Date(String(r.created_at)).toISOString(),
          peer: {
            id: r.peer_id,
            username: r.username,
            display_name: r.display_name,
            avatar_url: r.avatar_url,
            bio: r.bio,
            role: r.role,
            university_email_verified: Boolean(r.university_email_verified)
          }
        })),
        outgoing: outgoing.map((r) => ({
          id: r.id,
          direction: "outgoing",
          note: r.note,
          status: r.status,
          created_at: new Date(String(r.created_at)).toISOString(),
          peer: {
            id: r.peer_id,
            username: r.username,
            display_name: r.display_name,
            avatar_url: r.avatar_url,
            bio: r.bio,
            role: r.role,
            university_email_verified: Boolean(r.university_email_verified)
          }
        })),
        blocked
      });
    } catch (err) {
      return next(err);
    }
  });
  router.post("/connections/request", requireAuth, async (req, res, next) => {
    try {
      if (req.user.role === "visitor") {
        return res.status(403).json({ error: "Visitors cannot send connection requests." });
      }
      const parsed = z5.object({
        receiver_id: z5.string().min(1),
        note: z5.string().max(240).default("")
      }).safeParse(req.body);
      if (!parsed.success || !isUuid(parsed.data.receiver_id)) {
        return res.status(400).json({ error: "Invalid connection request." });
      }
      const senderId = req.user.id;
      const receiverId = parsed.data.receiver_id;
      if (senderId === receiverId) {
        return res.status(400).json({ error: "You cannot send a connection request to yourself." });
      }
      if (req.user.role === "admin" || req.user.role === "super_admin") {
        return res.status(403).json({ error: "Administrator accounts do not participate in peer connections." });
      }
      const receiver = await db.queryOne("SELECT id, role, account_status FROM profiles WHERE id = $1", [receiverId]);
      if (!receiver || receiver.account_status !== "active") {
        return res.status(404).json({ error: "Target user not found." });
      }
      if (receiver.role === "admin" || receiver.role === "super_admin") {
        return res.status(403).json({ error: "Administrator accounts are not visible or connectable in Connections." });
      }
      const blocked = await db.queryOne(
        "SELECT 1 FROM user_blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)",
        [senderId, receiverId]
      );
      if (blocked) {
        return res.status(403).json({ error: "Connection unavailable due to block settings." });
      }
      const [ua, ub] = canonicalPair(senderId, receiverId);
      const alreadyConnected = await db.queryOne(
        "SELECT 1 FROM connections WHERE user_a_id = $1 AND user_b_id = $2",
        [ua, ub]
      );
      if (alreadyConnected) {
        return res.status(409).json({ error: "You are already connected with this user." });
      }
      const pending = await db.queryOne(
        "SELECT 1 FROM connection_requests WHERE status = 'pending' AND ((sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1))",
        [senderId, receiverId]
      );
      if (pending) {
        return res.status(409).json({ error: "A pending connection request already exists between you and this user." });
      }
      const id = crypto10.randomUUID();
      await db.transaction(async (tx) => {
        await tx.execute(
          "INSERT INTO connection_requests (id, sender_id, receiver_id, note, status, created_at, updated_at) VALUES ($1, $2, $3, $4, 'pending', NOW(), NOW())",
          [id, senderId, receiverId, parsed.data.note.trim()]
        );
        await createNotification(
          tx,
          receiverId,
          "connection_request",
          "New Connection Request",
          `${req.user.display_name} wants to connect with you.`,
          "/connections"
        );
      });
      return res.status(201).json({ id, status: "pending" });
    } catch (err) {
      return next(err);
    }
  });
  router.post("/connections/requests/:id/respond", requireAuth, async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: "Pending connection request not found." });
      const parsed = z5.object({ action: z5.enum(["accept", "reject", "cancel"]) }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid action." });
      const { action } = parsed.data;
      const reqRow = await db.queryOne(
        "SELECT * FROM connection_requests WHERE id = $1",
        [req.params.id]
      );
      if (!reqRow || String(reqRow.status) !== "pending") {
        return res.status(404).json({ error: "Pending connection request not found." });
      }
      const uid = req.user.id;
      const senderId = String(reqRow.sender_id);
      const receiverId = String(reqRow.receiver_id);
      if (action === "cancel") {
        if (senderId !== uid) return res.status(403).json({ error: "Only the sender can cancel an outgoing request." });
        await db.execute("UPDATE connection_requests SET status = 'cancelled', updated_at = NOW() WHERE id = $1", [
          req.params.id
        ]);
        return res.json({ status: "cancelled" });
      }
      if (receiverId !== uid) {
        return res.status(403).json({ error: "Only the recipient can accept or reject this request." });
      }
      if (action === "reject") {
        await db.execute("UPDATE connection_requests SET status = 'rejected', updated_at = NOW() WHERE id = $1", [
          req.params.id
        ]);
        return res.json({ status: "rejected" });
      }
      await db.transaction(async (tx) => {
        await tx.execute("UPDATE connection_requests SET status = 'accepted', updated_at = NOW() WHERE id = $1", [
          req.params.id
        ]);
        const [ua, ub] = canonicalPair(senderId, receiverId);
        await tx.execute(
          "INSERT INTO connections (id, user_a_id, user_b_id, created_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (user_a_id, user_b_id) DO NOTHING",
          [crypto10.randomUUID(), ua, ub]
        );
        await createNotification(
          tx,
          senderId,
          "connection_accepted",
          "Connection Request Accepted",
          `${req.user.display_name} accepted your connection request.`,
          "/connections"
        );
      });
      return res.json({ status: "accepted" });
    } catch (err) {
      return next(err);
    }
  });
  router.delete("/connections/:connectionId", requireAuth, async (req, res, next) => {
    try {
      if (!isUuid(req.params.connectionId)) return res.status(404).json({ error: "Connection not found." });
      const conn = await db.queryOne("SELECT * FROM connections WHERE id = $1", [
        req.params.connectionId
      ]);
      if (!conn) return res.status(404).json({ error: "Connection not found." });
      if (String(conn.user_a_id) !== req.user.id && String(conn.user_b_id) !== req.user.id) {
        return res.status(403).json({ error: "Unauthorized to remove this connection." });
      }
      await db.execute("DELETE FROM connections WHERE id = $1", [req.params.connectionId]);
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });
  router.post("/users/:targetId/block", requireAuth, async (req, res, next) => {
    try {
      if (!isUuid(req.params.targetId)) return res.status(404).json({ error: "User not found." });
      const uid = req.user.id;
      const targetId = req.params.targetId;
      if (uid === targetId) return res.status(400).json({ error: "You cannot block yourself." });
      const existing = await db.queryOne(
        "SELECT 1 FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2",
        [uid, targetId]
      );
      if (existing) {
        await db.execute("DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2", [uid, targetId]);
        return res.json({ blocked: false });
      }
      const [ua, ub] = canonicalPair(uid, targetId);
      await db.transaction(async (tx) => {
        await tx.execute("INSERT INTO user_blocks (blocker_id, blocked_id, created_at) VALUES ($1, $2, NOW())", [
          uid,
          targetId
        ]);
        await tx.execute("DELETE FROM connections WHERE user_a_id = $1 AND user_b_id = $2", [ua, ub]);
        await tx.execute(
          "UPDATE connection_requests SET status = 'cancelled', updated_at = NOW() WHERE status = 'pending' AND ((sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1))",
          [uid, targetId]
        );
      });
      return res.json({ blocked: true });
    } catch (err) {
      return next(err);
    }
  });
  router.get("/notifications", requireAuth, async (req, res, next) => {
    try {
      const [items, unreadRow] = await Promise.all([
        db.query(
          "SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50",
          [req.user.id]
        ),
        db.queryOne(
          "SELECT COUNT(*) AS cnt FROM notifications WHERE user_id = $1 AND is_read = FALSE",
          [req.user.id]
        )
      ]);
      return res.json({
        notifications: items.map((n) => ({
          ...n,
          is_read: Boolean(n.is_read),
          created_at: new Date(String(n.created_at)).toISOString()
        })),
        unread_count: Number(unreadRow?.cnt || 0)
      });
    } catch (err) {
      return next(err);
    }
  });
  router.post("/notifications/:id/read", requireAuth, async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: "Notification not found." });
      await db.execute("UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2", [
        req.params.id,
        req.user.id
      ]);
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });
  router.post("/notifications/read-all", requireAuth, async (req, res, next) => {
    try {
      await db.execute("UPDATE notifications SET is_read = TRUE WHERE user_id = $1", [req.user.id]);
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });
  router.get("/messages/status", (_req, res) => {
    return res.json({
      status: "currently_in_development",
      e2ee_enabled: false,
      planned_protocol: "Matrix Olm/Megolm End-to-End Encryption",
      notice: "Private encrypted messaging is currently in development. GandakiHub intentionally does not store plaintext messages or claim end-to-end encryption prior to independent protocol verification."
    });
  });
  return router;
}

// server/routes/special.ts
import crypto11 from "node:crypto";
import { Router as Router8 } from "express";
import { z as z6 } from "zod";
async function getProfanityRules2(db) {
  return db.query("SELECT * FROM profanity_dictionary");
}
var imageUrlSchema = z6.string().regex(/^\/api\/media\/images\/[a-zA-Z0-9._-]+$/, "Invalid image reference.").nullable().optional();
function createSpecialRouter(db) {
  const router = Router8();
  router.get("/confessions", async (req, res, next) => {
    try {
      const showPending = req.query.status === "pending" && req.user && isModeratorOrAbove(req.user.role);
      const status = showPending ? "pending" : "approved";
      const rows = await db.query(
        "SELECT * FROM confessions WHERE status = $1 ORDER BY created_at DESC LIMIT 80",
        [status]
      );
      const ids = rows.map((r) => String(r.id));
      const commentsByConf = /* @__PURE__ */ new Map();
      if (ids.length > 0) {
        const cmts = await db.query(
          "SELECT id, confession_id, alias_label, body, created_at FROM confession_comments WHERE confession_id = ANY($1::uuid[]) ORDER BY created_at ASC",
          [ids]
        );
        for (const cm of cmts) {
          const cid = String(cm.confession_id);
          const list = commentsByConf.get(cid) || [];
          list.push({
            id: cm.id,
            alias_label: cm.alias_label,
            body: cm.body,
            created_at: new Date(String(cm.created_at)).toISOString()
          });
          commentsByConf.set(cid, list);
        }
      }
      return res.json({
        confessions: rows.map((c) => ({
          ...c,
          created_at: new Date(String(c.created_at)).toISOString(),
          comments: commentsByConf.get(String(c.id)) || []
        }))
      });
    } catch (err) {
      return next(err);
    }
  });
  router.post("/confessions", requireAuth, async (req, res, next) => {
    try {
      if (req.user.role === "visitor") {
        return res.status(403).json({ error: "Visitors cannot submit confessions." });
      }
      const parsed = z6.object({
        title: z6.string().max(140).default(""),
        body: z6.string().max(2e3).default(""),
        image_url: imageUrlSchema,
        category: z6.string().min(2).max(50).default("Campus Life")
      }).safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid confession." });
      }
      const cleanTitle = parsed.data.title.trim();
      const cleanBody = parsed.data.body.trim();
      const cleanImage = parsed.data.image_url || null;
      if (!cleanTitle && !cleanBody && !cleanImage) {
        return res.status(400).json({ error: "Please include text or an image for your confession." });
      }
      const rules = await getProfanityRules2(db);
      const prof = checkTextAgainstDictionary(`${cleanTitle} ${cleanBody}`, rules);
      if (prof.blocked) {
        return res.status(400).json({ error: "Submission blocked due to severe abusive terms or threats." });
      }
      const id = crypto11.randomUUID();
      await db.transaction(async (tx) => {
        await tx.execute(
          "INSERT INTO confessions (id, title, body, image_url, category, status, reaction_support, reaction_relate, comment_count, created_at) VALUES ($1, $2, $3, $4, $5, 'pending', 0, 0, 0, NOW())",
          [id, cleanTitle, cleanBody, cleanImage, parsed.data.category.trim()]
        );
        await tx.execute(
          "INSERT INTO confession_identity_vault (confession_id, author_id, created_at) VALUES ($1, $2, NOW())",
          [id, req.user.id]
        );
        await syncModerationQueue(tx, "confession", id, null, "pending");
      });
      return res.status(201).json({
        id,
        status: "pending",
        message: "Confession submitted anonymously to the moderation queue."
      });
    } catch (err) {
      return next(err);
    }
  });
  router.post("/confessions/:id/react", requireAuth, async (req, res, next) => {
    try {
      if (req.user.role === "visitor") return res.status(403).json({ error: "Sign in as a member to react." });
      if (!isUuid(req.params.id)) return res.status(404).json({ error: "Confession not found." });
      const parsed = z6.object({ reaction: z6.enum(["support", "relate"]) }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid reaction." });
      const col = parsed.data.reaction === "support" ? "reaction_support" : "reaction_relate";
      await db.execute(`UPDATE confessions SET ${col} = ${col} + 1 WHERE id = $1 AND status = 'approved'`, [
        req.params.id
      ]);
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });
  router.post("/confessions/:id/comments", requireAuth, async (req, res, next) => {
    try {
      if (req.user.role === "visitor") return res.status(403).json({ error: "Visitors cannot comment." });
      if (!isUuid(req.params.id)) return res.status(404).json({ error: "Confession not found." });
      const parsed = z6.object({ body: z6.string().min(2).max(1e3) }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Comment text is required." });
      const rules = await getProfanityRules2(db);
      const prof = checkTextAgainstDictionary(parsed.data.body, rules);
      if (prof.blocked) return res.status(400).json({ error: "Comment contains prohibited abusive terms." });
      const aliasNum = 100 + Math.floor(Math.random() * 899);
      await db.transaction(async (tx) => {
        await tx.execute(
          "INSERT INTO confession_comments (id, confession_id, alias_label, body, created_at) VALUES ($1, $2, $3, $4, NOW())",
          [crypto11.randomUUID(), req.params.id, `Anonymous Peer #${aliasNum}`, parsed.data.body.trim()]
        );
        await tx.execute("UPDATE confessions SET comment_count = comment_count + 1 WHERE id = $1", [req.params.id]);
      });
      return res.status(201).json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });
  router.post("/confessions/:id/review", requireModerator, async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: "Confession not found." });
      const parsed = z6.object({ decision: z6.enum(["approved", "rejected"]) }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid review decision." });
      const conf = await db.queryOne("SELECT * FROM confessions WHERE id = $1", [
        req.params.id
      ]);
      if (!conf) return res.status(404).json({ error: "Confession not found." });
      await db.transaction(async (tx) => {
        await tx.execute("UPDATE confessions SET status = $1 WHERE id = $2", [parsed.data.decision, req.params.id]);
        await syncModerationQueue(tx, "confession", req.params.id, null, parsed.data.decision, req.user.id);
        await writeAuditLog(tx, req.user.id, `confession_${parsed.data.decision}`, "confession", req.params.id, {});
      });
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });
  router.post("/confessions/:id/identity-lookup", requireSuperAdmin, async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: "Confession not found." });
      const parsed = z6.object({ reason: z6.string().min(10, "Provide an explicit safety/legal justification (min 10 chars).") }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message });
      const vault = await db.queryOne(
        `SELECT v.author_id, u.username, u.display_name, uc.email, u.role
         FROM confession_identity_vault v
         JOIN profiles u ON u.id = v.author_id
         JOIN user_credentials uc ON uc.user_id = u.id
         WHERE v.confession_id = $1`,
        [req.params.id]
      );
      await writeAuditLog(db, req.user.id, "SUPER_ADMIN_CONFESSION_IDENTITY_ACCESS", "confession", req.params.id, {
        justification: parsed.data.reason,
        found: Boolean(vault)
      });
      if (!vault) return res.status(404).json({ error: "Identity mapping not found." });
      return res.json({ identity: vault });
    } catch (err) {
      return next(err);
    }
  });
  router.get("/complaints", async (req, res, next) => {
    try {
      const viewer = req.user;
      const isHandler = viewer ? isAdminRole(viewer.role) || viewer.role === "community_moderator" : false;
      const rows = await db.query(
        `SELECT c.*, u.display_name AS submitter_name, h.display_name AS assigned_handler_name
         FROM complaints c
         JOIN profiles u ON u.id = c.submitter_id
         LEFT JOIN profiles h ON h.id = c.assigned_handler_id
         ORDER BY c.created_at DESC LIMIT 80`
      );
      const visible = rows.filter((r) => {
        if (!r.is_private) return true;
        if (!viewer) return false;
        return String(r.submitter_id) === viewer.id || String(r.assigned_handler_id) === viewer.id || isAdminRole(viewer.role) || isHandler;
      });
      return res.json({
        complaints: visible.map((r) => ({
          ...r,
          is_private: Boolean(r.is_private),
          created_at: new Date(String(r.created_at)).toISOString(),
          updated_at: new Date(String(r.updated_at)).toISOString(),
          submitter_name: r.is_private && (!viewer || String(r.submitter_id) !== viewer.id && !isAdminRole(viewer.role)) ? "Authorized Submitter" : r.submitter_name
        }))
      });
    } catch (err) {
      return next(err);
    }
  });
  router.post("/complaints", requireAuth, async (req, res, next) => {
    try {
      if (req.user.role === "visitor") return res.status(403).json({ error: "Visitors cannot submit complaints." });
      const parsed = z6.object({
        title: z6.string().max(180).default(""),
        body: z6.string().max(3e3).default(""),
        image_url: imageUrlSchema,
        category: z6.string().min(2).max(60),
        is_private: z6.boolean().default(false)
      }).safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid complaint." });
      }
      const cleanTitle = parsed.data.title.trim();
      const cleanBody = parsed.data.body.trim();
      const cleanImage = parsed.data.image_url || null;
      if (!cleanTitle && !cleanBody && !cleanImage) {
        return res.status(400).json({ error: "Please include text or an image." });
      }
      const id = crypto11.randomUUID();
      await db.execute(
        `INSERT INTO complaints (id, submitter_id, is_private, category, title, body, image_url, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'submitted', NOW(), NOW())`,
        [id, req.user.id, parsed.data.is_private, parsed.data.category.trim(), cleanTitle, cleanBody, cleanImage]
      );
      return res.status(201).json({ id, status: "submitted" });
    } catch (err) {
      return next(err);
    }
  });
  router.patch("/complaints/:id", requireAdmin, async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: "Complaint not found." });
      const parsed = z6.object({
        status: z6.enum(["submitted", "under_review", "in_progress", "resolved", "rejected"]).optional(),
        assigned_handler_id: z6.string().nullable().optional(),
        handler_notes: z6.string().max(1e3).nullable().optional()
      }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid complaint update." });
      const comp = await db.queryOne("SELECT * FROM complaints WHERE id = $1", [
        req.params.id
      ]);
      if (!comp) return res.status(404).json({ error: "Complaint not found." });
      await db.transaction(async (tx) => {
        await tx.execute(
          `UPDATE complaints SET
            status = COALESCE($1, status),
            assigned_handler_id = COALESCE($2, assigned_handler_id),
            handler_notes = COALESCE($3, handler_notes),
            updated_at = NOW()
           WHERE id = $4`,
          [
            parsed.data.status ?? null,
            isUuid(parsed.data.assigned_handler_id) ? parsed.data.assigned_handler_id : null,
            parsed.data.handler_notes ?? null,
            req.params.id
          ]
        );
        await createNotification(
          tx,
          String(comp.submitter_id),
          "complaint_update",
          "Complaint Status Updated",
          `"${comp.title}" is now ${parsed.data.status || comp.status}.`,
          "/complaints"
        );
        await writeAuditLog(tx, req.user.id, "update_complaint", "complaint", req.params.id, parsed.data);
      });
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });
  router.get("/ideas", async (req, res, next) => {
    try {
      const viewerId = req.user?.id || null;
      const rows = await db.query(
        `SELECT i.*, u.display_name AS author_name, u.username AS author_username,
          (SELECT value FROM votes v WHERE v.user_id = $1 AND v.target_type = 'idea' AND v.target_id = i.id) AS user_vote,
          (SELECT 1 FROM idea_followers f WHERE f.idea_id = i.id AND f.user_id = $1) AS is_following
         FROM ideas i
         JOIN profiles u ON u.id = i.author_id
         ORDER BY i.upvote_count DESC, i.created_at DESC`,
        [viewerId]
      );
      return res.json({
        ideas: rows.map((r) => ({
          ...r,
          upvote_count: Number(r.upvote_count || 0),
          follower_count: Number(r.follower_count || 0),
          user_vote: Number(r.user_vote || 0),
          is_following: Boolean(r.is_following),
          created_at: new Date(String(r.created_at)).toISOString()
        }))
      });
    } catch (err) {
      return next(err);
    }
  });
  router.post("/ideas", requireAuth, async (req, res, next) => {
    try {
      if (req.user.role === "visitor") return res.status(403).json({ error: "Visitors cannot submit ideas." });
      const parsed = z6.object({
        title: z6.string().max(180).default(""),
        problem_statement: z6.string().max(2e3).default(""),
        proposed_solution: z6.string().max(2e3).default(""),
        image_url: imageUrlSchema,
        collaborators_needed: z6.string().max(300).default(""),
        status: z6.enum(["new_idea", "under_discussion", "looking_for_collaborators", "in_progress", "completed"]).default("new_idea")
      }).safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid idea." });
      }
      const cleanTitle = parsed.data.title.trim();
      const cleanProb = parsed.data.problem_statement.trim();
      const cleanSol = parsed.data.proposed_solution.trim();
      const cleanImage = parsed.data.image_url || null;
      if (!cleanTitle && !cleanProb && !cleanSol && !cleanImage) {
        return res.status(400).json({ error: "Please provide text or an image for your idea." });
      }
      const id = crypto11.randomUUID();
      await db.transaction(async (tx) => {
        await tx.execute(
          `INSERT INTO ideas (id, author_id, title, problem_statement, proposed_solution, image_url, collaborators_needed, status, upvote_count, follower_count, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, 1, NOW())`,
          [
            id,
            req.user.id,
            cleanTitle,
            cleanProb,
            cleanSol,
            cleanImage,
            parsed.data.collaborators_needed.trim(),
            parsed.data.status
          ]
        );
        await tx.execute(
          "INSERT INTO votes (user_id, target_type, target_id, value, created_at) VALUES ($1, 'idea', $2, 1, NOW())",
          [req.user.id, id]
        );
        await tx.execute(
          "INSERT INTO idea_followers (idea_id, user_id, created_at) VALUES ($1, $2, NOW())",
          [id, req.user.id]
        );
      });
      return res.status(201).json({ id });
    } catch (err) {
      return next(err);
    }
  });
  router.patch("/ideas/:id/status", requireAuth, async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: "Idea not found." });
      const idea = await db.queryOne("SELECT * FROM ideas WHERE id = $1", [req.params.id]);
      if (!idea) return res.status(404).json({ error: "Idea not found." });
      if (String(idea.author_id) !== req.user.id && !isAdminRole(req.user.role)) {
        return res.status(403).json({ error: "Only the idea author or an administrator can update status." });
      }
      const parsed = z6.object({ status: z6.enum(["new_idea", "under_discussion", "looking_for_collaborators", "in_progress", "completed"]) }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid status." });
      await db.execute("UPDATE ideas SET status = $1 WHERE id = $2", [parsed.data.status, req.params.id]);
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });
  router.post("/ideas/:id/follow", requireAuth, async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: "Idea not found." });
      const existing = await db.queryOne(
        "SELECT 1 FROM idea_followers WHERE idea_id = $1 AND user_id = $2",
        [req.params.id, req.user.id]
      );
      if (existing) {
        await db.transaction(async (tx) => {
          await tx.execute("DELETE FROM idea_followers WHERE idea_id = $1 AND user_id = $2", [
            req.params.id,
            req.user.id
          ]);
          await tx.execute("UPDATE ideas SET follower_count = GREATEST(0, follower_count - 1) WHERE id = $1", [
            req.params.id
          ]);
        });
        return res.json({ following: false });
      }
      await db.transaction(async (tx) => {
        await tx.execute("INSERT INTO idea_followers (idea_id, user_id, created_at) VALUES ($1, $2, NOW())", [
          req.params.id,
          req.user.id
        ]);
        await tx.execute("UPDATE ideas SET follower_count = follower_count + 1 WHERE id = $1", [req.params.id]);
      });
      return res.json({ following: true });
    } catch (err) {
      return next(err);
    }
  });
  router.get("/donations", async (req, res, next) => {
    try {
      const isMod = req.user ? isModeratorOrAbove(req.user.role) : false;
      const viewerId = req.user?.id || null;
      const rows = await db.query(
        `SELECT d.*, u.display_name AS requester_name
         FROM donation_requests d
         JOIN profiles u ON u.id = d.requester_id
         ${isMod ? "" : viewerId ? "WHERE d.status IN ('approved', 'fulfilled') OR d.requester_id = $1" : "WHERE d.status IN ('approved', 'fulfilled')"}
         ORDER BY d.created_at DESC`,
        isMod || !viewerId ? [] : [viewerId]
      );
      return res.json({
        donations: rows.map((r) => ({ ...r, created_at: new Date(String(r.created_at)).toISOString() }))
      });
    } catch (err) {
      return next(err);
    }
  });
  router.post("/donations", requireAuth, async (req, res, next) => {
    try {
      if (req.user.role === "visitor") {
        return res.status(403).json({ error: "Visitors cannot submit assistance requests." });
      }
      const parsed = z6.object({
        title: z6.string().max(160).default(""),
        category: z6.string().min(2).max(60),
        description: z6.string().max(1500).default(""),
        image_url: imageUrlSchema,
        contact_method: z6.string().max(160).default("Reach via GandakiHub connection request")
      }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid assistance request." });
      const cleanTitle = parsed.data.title.trim();
      const cleanDesc = parsed.data.description.trim();
      const cleanImage = parsed.data.image_url || null;
      if (!cleanTitle && !cleanDesc && !cleanImage) {
        return res.status(400).json({ error: "Please include text or an image." });
      }
      const id = crypto11.randomUUID();
      await db.transaction(async (tx) => {
        await tx.execute(
          `INSERT INTO donation_requests (id, requester_id, title, category, description, image_url, contact_method, status, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', NOW())`,
          [
            id,
            req.user.id,
            cleanTitle,
            parsed.data.category.trim(),
            cleanDesc,
            cleanImage,
            parsed.data.contact_method.trim()
          ]
        );
        await syncModerationQueue(tx, "donation_request", id, req.user.id, "pending");
      });
      return res.status(201).json({
        id,
        status: "pending",
        message: "Request sent to moderators for verification before publishing."
      });
    } catch (err) {
      return next(err);
    }
  });
  router.post("/donations/:id/review", requireModerator, async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: "Donation request not found." });
      const parsed = z6.object({ decision: z6.enum(["approved", "rejected", "fulfilled"]), verification_notes: z6.string().max(400).default("") }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid review decision." });
      await db.transaction(async (tx) => {
        await tx.execute("UPDATE donation_requests SET status = $1, verification_notes = $2 WHERE id = $3", [
          parsed.data.decision,
          parsed.data.verification_notes.trim() || null,
          req.params.id
        ]);
        await syncModerationQueue(
          tx,
          "donation_request",
          req.params.id,
          null,
          parsed.data.decision === "fulfilled" ? "approved" : parsed.data.decision,
          req.user.id,
          parsed.data.verification_notes.trim() || null
        );
        await writeAuditLog(tx, req.user.id, `donation_${parsed.data.decision}`, "donation_request", req.params.id, {
          verification_notes: parsed.data.verification_notes
        });
      });
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });
  router.get("/opportunities", async (req, res, next) => {
    try {
      const isMod = req.user ? isModeratorOrAbove(req.user.role) : false;
      const kind = req.query.kind ? String(req.query.kind) : "";
      const clauses = [];
      const params = [];
      if (!isMod || req.query.includePending !== "true") {
        clauses.push("o.status = 'approved'");
      }
      if (kind) {
        params.push(kind);
        clauses.push(`o.kind = $${params.length}`);
      }
      const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = await db.query(
        `SELECT o.*, u.display_name AS author_name FROM opportunities o JOIN profiles u ON u.id = o.author_id ${whereSql} ORDER BY o.deadline ASC, o.created_at DESC`,
        params
      );
      return res.json({ opportunities: rows });
    } catch (err) {
      return next(err);
    }
  });
  router.post("/opportunities", requireAuth, async (req, res, next) => {
    try {
      if (req.user.role === "visitor" || req.user.role === "future_student") {
        return res.status(403).json({ error: "Only verified members, alumni, teachers, or admins can submit opportunities." });
      }
      const parsed = z6.object({
        kind: z6.enum(["internship", "job", "scholarship", "competition", "research", "workshop"]),
        title: z6.string().max(180).default(""),
        organization: z6.string().max(120).default(""),
        description: z6.string().max(2e3).default(""),
        image_url: imageUrlSchema,
        eligibility: z6.string().max(300).default("Open to eligible students"),
        deadline: z6.string().min(4).max(30),
        external_url: z6.string().max(300).default("")
      }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid opportunity details." });
      const cleanTitle = parsed.data.title.trim();
      const cleanDesc = parsed.data.description.trim();
      const cleanImage = parsed.data.image_url || null;
      if (!cleanTitle && !cleanDesc && !cleanImage) {
        return res.status(400).json({ error: "Please include text or an image." });
      }
      const id = crypto11.randomUUID();
      const status = isModeratorOrAbove(req.user.role) ? "approved" : "pending";
      await db.transaction(async (tx) => {
        await tx.execute(
          `INSERT INTO opportunities (id, author_id, kind, title, organization, description, image_url, eligibility, deadline, external_url, status, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())`,
          [
            id,
            req.user.id,
            parsed.data.kind,
            cleanTitle,
            parsed.data.organization.trim(),
            cleanDesc,
            cleanImage,
            parsed.data.eligibility.trim(),
            parsed.data.deadline.trim(),
            parsed.data.external_url.trim(),
            status
          ]
        );
        await syncModerationQueue(tx, "opportunity", id, req.user.id, status, status === "approved" ? req.user.id : null);
      });
      return res.status(201).json({ id, status });
    } catch (err) {
      return next(err);
    }
  });
  router.post("/opportunities/:id/review", requireModerator, async (req, res, next) => {
    try {
      if (!isUuid(req.params.id)) return res.status(404).json({ error: "Opportunity not found." });
      const parsed = z6.object({ decision: z6.enum(["approved", "rejected"]) }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid review decision." });
      const opp = await db.queryOne("SELECT * FROM opportunities WHERE id = $1", [
        req.params.id
      ]);
      if (!opp) return res.status(404).json({ error: "Opportunity not found." });
      await db.transaction(async (tx) => {
        await tx.execute("UPDATE opportunities SET status = $1 WHERE id = $2", [parsed.data.decision, req.params.id]);
        await syncModerationQueue(tx, "opportunity", req.params.id, String(opp.author_id), parsed.data.decision, req.user.id);
        await writeAuditLog(tx, req.user.id, `opportunity_${parsed.data.decision}`, "opportunity", req.params.id, {});
      });
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });
  router.get("/events", async (_req, res, next) => {
    try {
      const rows = await db.query(
        "SELECT e.*, u.display_name AS author_name FROM events e JOIN profiles u ON u.id = e.author_id ORDER BY e.starts_at ASC"
      );
      return res.json({ events: rows });
    } catch (err) {
      return next(err);
    }
  });
  router.post("/events", requireAuth, async (req, res, next) => {
    try {
      if (!["super_admin", "admin", "community_moderator", "verified_teacher", "verified_student"].includes(req.user.role)) {
        return res.status(403).json({ error: "Only verified campus members or faculty can publish events." });
      }
      const parsed = z6.object({
        kind: z6.enum(["event", "seminar", "announcement"]).default("event"),
        title: z6.string().max(160).default(""),
        location: z6.string().max(160).default("Gandaki University Campus"),
        starts_at: z6.string().min(4).max(50),
        description: z6.string().max(2e3).default(""),
        image_url: imageUrlSchema
      }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid event fields." });
      const cleanTitle = parsed.data.title.trim();
      const cleanDesc = parsed.data.description.trim();
      const cleanImage = parsed.data.image_url || null;
      if (!cleanTitle && !cleanDesc && !cleanImage) {
        return res.status(400).json({ error: "Please include text or an image." });
      }
      const id = crypto11.randomUUID();
      const isOfficial = isAdminRole(req.user.role) && parsed.data.kind === "announcement";
      await db.execute(
        "INSERT INTO events (id, author_id, kind, title, location, starts_at, description, image_url, is_official_notice, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())",
        [
          id,
          req.user.id,
          parsed.data.kind,
          cleanTitle,
          parsed.data.location.trim(),
          parsed.data.starts_at,
          cleanDesc,
          cleanImage,
          isOfficial
        ]
      );
      return res.status(201).json({ id });
    } catch (err) {
      return next(err);
    }
  });
  router.get("/study-groups", async (req, res, next) => {
    try {
      const viewerId = req.user?.id || null;
      const rows = await db.query(
        `SELECT sg.*, u.display_name AS creator_name, p.code AS program_code, sub.name AS subject_name,
          (SELECT 1 FROM study_group_members m WHERE m.group_id = sg.id AND m.user_id = $1) AS is_member
         FROM study_groups sg
         JOIN profiles u ON u.id = sg.creator_id
         LEFT JOIN programs p ON p.id = sg.program_id
         LEFT JOIN subjects sub ON sub.id = sg.subject_id
         ORDER BY sg.created_at DESC`,
        [viewerId]
      );
      return res.json({
        study_groups: rows.map((r) => ({
          ...r,
          member_count: Number(r.member_count || 1),
          max_members: Number(r.max_members || 15),
          is_member: Boolean(r.is_member),
          created_at: new Date(String(r.created_at)).toISOString()
        }))
      });
    } catch (err) {
      return next(err);
    }
  });
  router.post("/study-groups", requireAuth, async (req, res, next) => {
    try {
      if (!["super_admin", "admin", "community_moderator", "verified_student", "verified_teacher"].includes(req.user.role)) {
        return res.status(403).json({ error: "Only verified university members can create study groups." });
      }
      const parsed = z6.object({
        name: z6.string().min(2).max(120),
        description: z6.string().max(800).default(""),
        image_url: imageUrlSchema,
        schedule_text: z6.string().min(2).max(120),
        program_id: z6.string().nullable().optional(),
        semester_id: z6.string().nullable().optional(),
        subject_id: z6.string().nullable().optional(),
        max_members: z6.number().int().min(2).max(50).default(15)
      }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid study group." });
      const cleanDesc = parsed.data.description.trim();
      const cleanImage = parsed.data.image_url || null;
      if (!cleanDesc && !cleanImage) {
        return res.status(400).json({ error: "Please include a description or an image for the study group." });
      }
      const id = crypto11.randomUUID();
      await db.transaction(async (tx) => {
        await tx.execute(
          `INSERT INTO study_groups (id, creator_id, program_id, semester_id, subject_id, name, description, image_url, schedule_text, max_members, member_count, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1, NOW())`,
          [
            id,
            req.user.id,
            isUuid(parsed.data.program_id) ? parsed.data.program_id : null,
            isUuid(parsed.data.semester_id) ? parsed.data.semester_id : null,
            isUuid(parsed.data.subject_id) ? parsed.data.subject_id : null,
            parsed.data.name.trim(),
            cleanDesc,
            cleanImage,
            parsed.data.schedule_text.trim(),
            parsed.data.max_members
          ]
        );
        await tx.execute(
          "INSERT INTO study_group_members (group_id, user_id, joined_at) VALUES ($1, $2, NOW())",
          [id, req.user.id]
        );
      });
      return res.status(201).json({ id });
    } catch (err) {
      return next(err);
    }
  });
  router.post("/study-groups/:id/toggle-join", requireAuth, async (req, res, next) => {
    try {
      if (!["super_admin", "admin", "community_moderator", "verified_student", "verified_teacher"].includes(req.user.role)) {
        return res.status(403).json({ error: "Only verified university members can join study groups." });
      }
      if (!isUuid(req.params.id)) return res.status(404).json({ error: "Study group not found." });
      const outcome = await db.transaction(async (tx) => {
        const existing = await tx.queryOne(
          "SELECT 1 FROM study_group_members WHERE group_id = $1 AND user_id = $2",
          [req.params.id, req.user.id]
        );
        if (existing) {
          await tx.execute("DELETE FROM study_group_members WHERE group_id = $1 AND user_id = $2", [
            req.params.id,
            req.user.id
          ]);
          await tx.execute("UPDATE study_groups SET member_count = GREATEST(0, member_count - 1) WHERE id = $1", [
            req.params.id
          ]);
          return { joined: false };
        }
        const sg = await tx.queryOne(
          "SELECT member_count, max_members FROM study_groups WHERE id = $1",
          [req.params.id]
        );
        if (!sg) return { notFound: true };
        if (Number(sg.member_count) >= Number(sg.max_members)) return { full: true };
        await tx.execute(
          "INSERT INTO study_group_members (group_id, user_id, joined_at) VALUES ($1, $2, NOW())",
          [req.params.id, req.user.id]
        );
        await tx.execute("UPDATE study_groups SET member_count = member_count + 1 WHERE id = $1", [req.params.id]);
        return { joined: true };
      });
      if ("notFound" in outcome) return res.status(404).json({ error: "Study group not found." });
      if ("full" in outcome) return res.status(400).json({ error: "This study group is already full." });
      return res.json({ joined: outcome.joined });
    } catch (err) {
      return next(err);
    }
  });
  return router;
}

// server/app.ts
function isOriginAllowed(origin, requestHost) {
  if (!origin) return true;
  const normalized = origin.replace(/\/$/, "");
  if (requestHost) {
    try {
      const originHost = new URL(normalized).host.toLowerCase();
      if (originHost === requestHost.toLowerCase()) {
        return true;
      }
    } catch {
    }
  }
  const configured = (process.env.CORS_ORIGIN || "").split(",").map((o) => o.trim().replace(/\/$/, "")).filter(Boolean);
  if (configured.includes(normalized)) return true;
  if (process.env.APP_URL && normalized === process.env.APP_URL.trim().replace(/\/$/, "")) {
    return true;
  }
  if (process.env.ALLOW_VERCEL_PREVIEWS === "true" && /^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(normalized)) {
    return true;
  }
  if (process.env.NODE_ENV !== "production") {
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(normalized)) {
      return true;
    }
  }
  return configured.length === 0 && process.env.NODE_ENV !== "production";
}
function createApiApp(db, storage) {
  const app = express();
  app.set("trust proxy", 1);
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: "cross-origin" },
      contentSecurityPolicy: false
    })
  );
  app.use(
    cors((req, callback) => {
      const origin = typeof req.headers.origin === "string" ? req.headers.origin : void 0;
      const forwardedHost = typeof req.headers["x-forwarded-host"] === "string" ? req.headers["x-forwarded-host"].split(",")[0].trim() : void 0;
      const requestHost = forwardedHost || (typeof req.headers.host === "string" ? req.headers.host : void 0);
      if (isOriginAllowed(origin, requestHost)) {
        callback(null, {
          origin: true,
          credentials: true,
          exposedHeaders: ["Content-Disposition"]
        });
      } else {
        callback(new Error(`CORS policy blocked origin: ${origin}`));
      }
    })
  );
  app.use(express.json({ limit: "2mb" }));
  app.use(cookieParser());
  app.use(attachSessionMiddleware(db, storage));
  app.get("/api/health", async (_req, res) => {
    try {
      await db.queryOne("SELECT 1 AS ok");
      res.json({
        status: "ok",
        service: "GandakiHub",
        database: db.kind,
        storage: storage.kind
      });
    } catch (err) {
      res.status(503).json({
        status: "degraded",
        service: "GandakiHub",
        error: err instanceof Error ? err.message : "Database unreachable"
      });
    }
  });
  app.use("/api/auth", createAuthRouter(db));
  app.use("/api/academic", createAcademicRouter(db));
  app.use("/api", createMediaRouter());
  app.use("/api", createCommunityRouter(db));
  app.use("/api", createSpecialRouter(db));
  app.use("/api", createSocialRouter(db));
  app.use("/api", createSearchRouter(db));
  app.use("/api/admin", createAdminRouter(db));
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "API endpoint not found." });
  });
  app.use((err, _req, res, _next) => {
    console.error("[GandakiHub API Error]", err);
    const message = err instanceof Error ? err.message : "Unexpected server error";
    res.status(500).json({ error: message });
  });
  return app;
}

// server/seed.ts
var SEMESTERS = [
  "First Semester",
  "Second Semester",
  "Third Semester",
  "Fourth Semester",
  "Fifth Semester",
  "Sixth Semester",
  "Seventh Semester",
  "Eighth Semester"
];
var PROGRAMS = [
  {
    code: "BIT",
    name: "Bachelor of Information Technology",
    description: "Undergraduate IT curriculum covering programming, databases, networks, and data systems."
  },
  {
    code: "BALLB",
    name: "Bachelor of Arts Bachelor of Laws",
    description: "Integrated five-year arts and legal studies program."
  },
  {
    code: "BBA",
    name: "Bachelor of Business Administration",
    description: "Management, finance, accounting, and organizational leadership program."
  },
  {
    code: "B.Pharm",
    name: "Bachelor of Pharmacy",
    description: "Pharmaceutical sciences, pharmacology, and clinical pharmacy curriculum."
  },
  {
    code: "BSM",
    name: "Bachelor of Sports Management",
    description: "Sports administration, kinesiology, event management, and coaching studies."
  }
];
var CATEGORIES = [
  { slug: "notes", name: "Notes", description: "Lecture notes and unit summaries (PDF only).", pdf_only: true, sort_order: 1 },
  { slug: "past-questions", name: "Past Questions", description: "Previous semester and final examination papers (PDF only).", pdf_only: true, sort_order: 2 },
  { slug: "projects", name: "Projects", description: "Student project reports and documentation (PDF only).", pdf_only: true, sort_order: 3 },
  { slug: "assignments", name: "Assignments", description: "Coursework guidelines and reference assignments (PDF).", pdf_only: true, sort_order: 4 },
  { slug: "exam-prep", name: "Exam Preparation", description: "Revision sheets, formula guides, and model sets (PDF).", pdf_only: true, sort_order: 5 },
  { slug: "general-discussion", name: "General Discussion", description: "Subject syllabus discussions and Q&A.", pdf_only: false, sort_order: 6 },
  { slug: "resources", name: "Resources", description: "Reference syllabi, reading lists, and lab manuals (PDF).", pdf_only: true, sort_order: 7 }
];
var SPECIAL_COMMUNITIES = [
  { slug: "confessions", name: "Confessions", description: "Anonymous moderated campus reflections and confessions.", visibility: "public", rules: "No names, harassment, hate speech, or doxxing. All submissions undergo moderator review." },
  { slug: "complaints-suggestions", name: "Complaints & Suggestions", description: "Structured public and private feedback channels for campus improvement.", visibility: "public", rules: "Provide constructive, specific details. Private complaints are visible only to assigned handlers." },
  { slug: "getideas", name: "GetIdeas", description: "Student innovation, campus software proposals, and collaborator matching.", visibility: "public", rules: "Describe the problem clearly and state what kind of collaborators you need." },
  { slug: "student-donations", name: "Student Donations", description: "Moderated peer-assistance requests for textbooks, equipment, and urgent student support.", visibility: "public", rules: "Moderators verify requests before publishing. Do not post private medical or banking IDs." },
  { slug: "random", name: "Random", description: "Campus life, Pokhara recommendations, photography, and casual conversations.", visibility: "public", rules: "Keep discussions respectful and welcoming." },
  { slug: "future-students", name: "Future Students", description: "Admissions Q&A, entrance preparation, and campus guidance for prospective applicants.", visibility: "public", rules: "Prospective students can ask questions here; verified students and teachers provide guidance." },
  { slug: "alumni", name: "Alumni", description: "Graduate network, career transitions, and alumni mentorship.", visibility: "public", rules: "Share mentorship advice and industry insights." },
  { slug: "internship-opportunities", name: "Internship & Opportunities", description: "Internships, fellowships, scholarships, competitions, and research calls.", visibility: "public", rules: "Include accurate eligibility criteria and application deadlines." },
  { slug: "events-announcements", name: "Events & Announcements", description: "Seminars, workshops, hackathons, and student notices.", visibility: "public", rules: "Verify event dates and locations before posting." },
  { slug: "lost-found", name: "Lost & Found", description: "Report misplaced ID cards, textbooks, calculators, or found items on campus.", visibility: "public", rules: "Do not post sensitive personal contact numbers publicly; coordinate safely." },
  { slug: "study-groups", name: "Study Groups", description: "Peer study circles organized by program, semester, and exam schedule.", visibility: "university_only", rules: "Only verified university members may join academic study circles." }
];
async function seedIfEmpty(db) {
  const existing = await db.queryOne("SELECT COUNT(*) AS cnt FROM programs");
  if (Number(existing?.cnt || 0) > 0) return;
  await db.transaction(async (tx) => {
    await tx.execute(
      `INSERT INTO platform_settings (key, value) VALUES ('max_upload_mb', '10'), ('require_resource_review', 'true')
       ON CONFLICT (key) DO NOTHING`
    );
    for (const c of CATEGORIES) {
      await tx.execute(
        `INSERT INTO resource_categories (slug, name, description, pdf_only, sort_order)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (slug) DO NOTHING`,
        [c.slug, c.name, c.description, c.pdf_only, c.sort_order]
      );
    }
    for (let pIdx = 0; pIdx < PROGRAMS.length; pIdx++) {
      const p = PROGRAMS[pIdx];
      await tx.execute(
        `INSERT INTO programs (code, name, description, sort_order, is_archived)
         VALUES ($1, $2, $3, $4, FALSE)
         ON CONFLICT (code) DO NOTHING`,
        [p.code, p.name, p.description, pIdx + 1]
      );
      const progRow = await tx.queryOne("SELECT id FROM programs WHERE code = $1", [p.code]);
      if (!progRow) continue;
      const progSlug = p.code.toLowerCase().replace(/[^a-z0-9]/g, "");
      await tx.execute(
        `INSERT INTO communities (slug, name, description, kind, visibility, rules, program_id, is_archived)
         VALUES ($1, $2, $3, 'academic', 'university_only', $4, $5, FALSE)
         ON CONFLICT (slug) DO NOTHING`,
        [
          progSlug,
          `${p.code} Community`,
          `Academic discussions, course coordination, and updates for ${p.name}.`,
          "Academic integrity applies. Respect peers and faculty.",
          progRow.id
        ]
      );
      for (let sIdx = 0; sIdx < SEMESTERS.length; sIdx++) {
        const semNum = sIdx + 1;
        const semName = SEMESTERS[sIdx];
        await tx.execute(
          `INSERT INTO semesters (program_id, number, name, sort_order, is_archived)
           VALUES ($1, $2, $3, $4, FALSE)
           ON CONFLICT (program_id, number) DO NOTHING`,
          [progRow.id, semNum, semName, semNum]
        );
        const semRow = await tx.queryOne(
          "SELECT id FROM semesters WHERE program_id = $1 AND number = $2",
          [progRow.id, semNum]
        );
        if (!semRow) continue;
        const subjCount = await tx.queryOne(
          "SELECT COUNT(*) AS cnt FROM subjects WHERE semester_id = $1",
          [semRow.id]
        );
        if (Number(subjCount?.cnt || 0) === 0) {
          for (let subjIdx = 1; subjIdx <= 5; subjIdx++) {
            await tx.execute(
              `INSERT INTO subjects (program_id, semester_id, code, name, description, sort_order, is_archived)
               VALUES ($1, $2, $3, $4, $5, $6, FALSE)`,
              [
                progRow.id,
                semRow.id,
                `${p.code}-${semNum}0${subjIdx}`,
                `Subject ${subjIdx}`,
                `Initial subject slot ${subjIdx} for ${p.code} ${semName}.`,
                subjIdx
              ]
            );
          }
        }
      }
    }
    for (const sc of SPECIAL_COMMUNITIES) {
      await tx.execute(
        `INSERT INTO communities (slug, name, description, kind, visibility, rules, program_id, is_archived)
         VALUES ($1, $2, $3, 'special', $4, $5, NULL, FALSE)
         ON CONFLICT (slug) DO NOTHING`,
        [sc.slug, sc.name, sc.description, sc.visibility, sc.rules]
      );
    }
    const profanitySeeds = [
      { term: "idiot", lang: "en", sev: "low", note: "Flag for review in personal attack contexts" },
      { term: "bastard", lang: "en", sev: "medium" },
      { term: "fuck", lang: "en", sev: "high" },
      { term: "shithead", lang: "en", sev: "high" },
      { term: "kill yourself", lang: "en", sev: "high" },
      { term: "machikne", lang: "ne_romanized", sev: "high" },
      { term: "muji", lang: "ne_romanized", sev: "high" },
      { term: "randi", lang: "ne_romanized", sev: "high" },
      { term: "kutta", lang: "ne_romanized", sev: "medium" },
      { term: "gadha", lang: "ne_romanized", sev: "low" },
      { term: "\u092E\u093E\u091A\u093F\u0915\u094D\u0928\u0947", lang: "ne_devanagari", sev: "high" },
      { term: "\u092E\u0941\u091C\u0940", lang: "ne_devanagari", sev: "high" },
      { term: "\u0930\u0928\u094D\u0921\u0940", lang: "ne_devanagari", sev: "high" },
      { term: "\u0915\u0941\u0915\u0941\u0930", lang: "ne_devanagari", sev: "low", note: "Context-checked: may appear in veterinary/biology text" }
    ];
    for (const ps of profanitySeeds) {
      await tx.execute(
        `INSERT INTO profanity_dictionary (term, normalized_term, language, severity, context_exception_note)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (term) DO NOTHING`,
        [ps.term, normalizeDictionaryTerm(ps.term), ps.lang, ps.sev, ps.note ?? null]
      );
    }
    const suggestions = [
      { term: "BIT", group: "Programs", link: "/academic", weight: 10 },
      { term: "BALLB", group: "Programs", link: "/academic", weight: 9 },
      { term: "BBA", group: "Programs", link: "/academic", weight: 8 },
      { term: "B.Pharm", group: "Programs", link: "/academic", weight: 7 },
      { term: "BSM", group: "Programs", link: "/academic", weight: 6 },
      { term: "Past Questions", group: "Categories", link: "/academic", weight: 5 }
    ];
    for (const s of suggestions) {
      await tx.execute(
        `INSERT INTO search_suggestions (term, category_group, link_path, weight)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (term) DO NOTHING`,
        [s.term, s.group, s.link, s.weight]
      );
    }
  });
}

// server/storage.ts
import { createClient } from "@supabase/supabase-js";
function createSupabaseStorage(supabaseUrl, serviceRoleKey, bucket = process.env.SUPABASE_STORAGE_BUCKET || "gandakihub-private") {
  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  return {
    kind: "supabase",
    bucket,
    async uploadPrivate(objectPath, buffer, contentType) {
      const { error } = await client.storage.from(bucket).upload(objectPath, buffer, {
        contentType,
        upsert: false
      });
      if (error) {
        throw new Error(`Supabase Storage upload failed: ${error.message}`);
      }
    },
    async downloadPrivate(objectPath) {
      const { data, error } = await client.storage.from(bucket).download(objectPath);
      if (error || !data) {
        return null;
      }
      const ab = await data.arrayBuffer();
      return Buffer.from(ab);
    },
    async createSignedUrl(objectPath, expiresInSeconds = 60, downloadFilename) {
      const { data, error } = await client.storage.from(bucket).createSignedUrl(objectPath, expiresInSeconds, downloadFilename ? { download: downloadFilename } : void 0);
      if (error || !data?.signedUrl) {
        return null;
      }
      return data.signedUrl;
    },
    async deletePrivate(objectPath) {
      await client.storage.from(bucket).remove([objectPath]);
    }
  };
}
function createMemoryStorage() {
  const objects = /* @__PURE__ */ new Map();
  return {
    kind: "memory",
    bucket: "memory-private-test",
    async uploadPrivate(objectPath, buffer, contentType) {
      objects.set(objectPath, { buffer: Buffer.from(buffer), contentType });
    },
    async downloadPrivate(objectPath) {
      const entry = objects.get(objectPath);
      return entry ? Buffer.from(entry.buffer) : null;
    },
    async createSignedUrl(objectPath, expiresInSeconds = 60) {
      if (!objects.has(objectPath)) return null;
      const exp = Math.floor(Date.now() / 1e3) + expiresInSeconds;
      return `https://memory-signed.local/${encodeURIComponent(objectPath)}?exp=${exp}`;
    },
    async deletePrivate(objectPath) {
      objects.delete(objectPath);
    }
  };
}
var cachedStorage = null;
function initStorage() {
  if (cachedStorage) return cachedStorage;
  const supabaseUrl = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").trim();
  const serviceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  const bucket = (process.env.SUPABASE_STORAGE_BUCKET || "gandakihub-private").trim();
  const isProd = process.env.NODE_ENV === "production";
  if (isProd && (!supabaseUrl || !serviceRoleKey)) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required in production for private Supabase Storage."
    );
  }
  if (supabaseUrl && serviceRoleKey) {
    cachedStorage = createSupabaseStorage(supabaseUrl, serviceRoleKey, bucket);
    return cachedStorage;
  }
  console.warn(
    "[GandakiHub] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set in local dev. Using ephemeral memory storage. Configure Supabase Storage for persistence."
  );
  cachedStorage = createMemoryStorage();
  return cachedStorage;
}

// server.ts
async function startServer() {
  getSessionSecret();
  const db = await initDatabase();
  await seedIfEmpty(db);
  const storage = initStorage();
  const app = createApiApp(db, storage);
  const envPort = Number(process.env.PORT);
  const nginxPort = Number(process.env.NGINX_PORT);
  const defaultAppPort = Number(process.env.DEFAULT_APP_PORT || 3e3);
  const port = nginxPort && envPort === nginxPort ? defaultAppPort : envPort || 3e3;
  const isProd = process.env.NODE_ENV === "production";
  const distDir = path5.resolve(process.cwd(), "dist");
  const hasFrontendDist = fs2.existsSync(path5.join(distDir, "index.html"));
  if (isProd && hasFrontendDist) {
    app.use(express2.static(distDir));
    app.get("*", (_req, res) => {
      res.sendFile(path5.join(distDir, "index.html"));
    });
  } else if (isProd) {
    app.get("/", (_req, res) => {
      res.json({
        service: "GandakiHub API",
        status: "ok",
        health: "/api/health"
      });
    });
  } else {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa"
    });
    app.use(vite.middlewares);
  }
  const server = app.listen(port, "0.0.0.0", () => {
    console.info(`GandakiHub running on http://0.0.0.0:${port} (db=${db.kind}, storage=${storage.kind})`);
  });
  const shutdown = async (signal) => {
    console.info(`Received ${signal}, shutting down GandakiHub gracefully...`);
    server.close(async () => {
      try {
        await db.close();
      } finally {
        process.exit(0);
      }
    });
    setTimeout(() => process.exit(1), 8e3).unref();
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
startServer().catch((err) => {
  console.error("Failed to start GandakiHub server:", err);
  process.exit(1);
});
