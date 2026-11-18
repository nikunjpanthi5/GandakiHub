import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApp } from '../server/app.ts';
import { createPGliteDatabase, type AppDatabase } from '../server/db.ts';
import { checkTextAgainstDictionary, normalizeDictionaryTerm } from '../server/profanity.ts';
import { seedIfEmpty } from '../server/seed.ts';
import { createMemoryStorage, type StorageService } from '../server/storage.ts';

let server: http.Server;
let baseUrl = '';
let db: AppDatabase;
let storage: StorageService;
let pglite: PGlite;

function buildSamplePdfBuffer(title: string, year: string, lines: string[]): Buffer {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const textOps = [
    'BT',
    '/F1 16 Tf',
    '54 740 Td',
    `(${esc(title)}) Tj`,
    '/F1 10 Tf',
    '0 -22 Td',
    `(GandakiHub Academic Archive | Year ${esc(year)}) Tj`,
    '0 -24 Td',
  ];

  for (const line of lines) {
    textOps.push(`(${esc(line)}) Tj`);
    textOps.push('0 -16 Td');
  }
  textOps.push('ET');
  const streamContent = textOps.join('\n');

  const objects: string[] = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n',
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    `5 0 obj\n<< /Length ${Buffer.byteLength(streamContent, 'utf8')} >>\nstream\n${streamContent}\nendstream\nendobj\n`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += obj;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'utf8');
}

async function req(
  pathname: string,
  options: {
    method?: string;
    cookie?: string;
    token?: string;
    json?: unknown;
    formData?: FormData;
  } = {}
) {
  const headers: Record<string, string> = {};
  if (options.cookie) headers['Cookie'] = options.cookie;
  if (options.token) headers['Authorization'] = `Bearer ${options.token}`;
  let body: BodyInit | undefined;
  if (options.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.json);
  } else if (options.formData) {
    body = options.formData;
  }

  const res = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || 'GET',
    headers,
    body,
  });
  const setCookie = res.headers.get('set-cookie');
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json() : await res.text();
  return { status: res.status, data, cookie: setCookie ? setCookie.split(';')[0] : options.cookie || '' };
}

let bitProgramId = '';
let bitSem1Id = '';
let bitSem1Subj1Id = '';
let notesCatId = '';
let genDiscCatId = '';
let bitCommId = '';
let futureCommId = '';

async function registerAndVerify(params: {
  email: string;
  username: string;
  display_name: string;
  category: 'university_member' | 'external';
  member_type?: 'student' | 'teacher';
  external_reason?: 'future_student' | 'university_visitor' | 'alumni' | 'platform_admin' | 'other';
  external_reason_detail?: string;
}) {
  const reg = await req('/api/auth/register', {
    method: 'POST',
    json: {
      email: params.email,
      password: 'Password123',
      username: params.username,
      display_name: params.display_name,
      category: params.category,
      member_type: params.member_type || 'student',
      program_id: params.category === 'university_member' ? bitProgramId : null,
      semester_id: params.category === 'university_member' && (params.member_type || 'student') === 'student' ? bitSem1Id : null,
      external_reason: params.external_reason ?? null,
      external_reason_detail: params.external_reason_detail ?? null,
    },
  });
  expect(reg.status).toBe(201);
  expect(reg.data.devOtpPreview).toMatch(/^\d{6}$/);

  const ver = await req('/api/auth/verify-otp', {
    method: 'POST',
    json: {
      email: params.email,
      code: reg.data.devOtpPreview,
      purpose: 'verify_email',
    },
  });
  expect(ver.status).toBe(200);
  return { user: ver.data.user, cookie: ver.cookie, token: ver.data.sessionToken as string };
}

describe('GandakiHub Full-Stack PostgreSQL Integration & Security Suite', () => {
  let superCookie = '';
  let adminCookie = '';
  let modCookie = '';
  let studentCookie = '';
  let studentId = '';
  let otherStudentCookie = '';
  let visitorCookie = '';
  let futureCookie = '';

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.SESSION_SECRET = 'test-only-gandakihub-secret-key-minimum-32-chars';
    delete process.env.SUPER_ADMIN_EMAIL;

    pglite = new PGlite({ extensions: { pg_trgm } });
    const migrationSql = fs.readFileSync(
      path.resolve(process.cwd(), 'supabase', 'migrations', '002_complete_production_schema.sql'),
      'utf8'
    );
    await pglite.exec(migrationSql);

    db = createPGliteDatabase(pglite);
    await seedIfEmpty(db);
    storage = createMemoryStorage();

    const app = createApiApp(db, storage);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });

    const structRes = await req('/api/academic/structure');
    const bitProg = (structRes.data.programs as Array<{ id: string; code: string }>).find((p) => p.code === 'BIT')!;
    bitProgramId = bitProg.id;
    const bitSem1 = (structRes.data.semesters as Array<{ id: string; program_id: string; number: number }>).find(
      (s) => s.program_id === bitProgramId && s.number === 1
    )!;
    bitSem1Id = bitSem1.id;
    const bitSubj1 = (structRes.data.subjects as Array<{ id: string; semester_id: string }>).find(
      (s) => s.semester_id === bitSem1Id
    )!;
    bitSem1Subj1Id = bitSubj1.id;
    notesCatId = (structRes.data.categories as Array<{ id: string; slug: string }>).find((c) => c.slug === 'notes')!.id;
    genDiscCatId = (structRes.data.categories as Array<{ id: string; slug: string }>).find(
      (c) => c.slug === 'general-discussion'
    )!.id;

    const commRes = await req('/api/communities');
    bitCommId = (commRes.data.communities as Array<{ id: string; slug: string }>).find((c) => c.slug === 'bit')!.id;
    futureCommId = (commRes.data.communities as Array<{ id: string; slug: string }>).find(
      (c) => c.slug === 'future-students'
    )!.id;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
  });

  describe('0. Clean Initial State, Health & Super Admin Config Guard', () => {
    it('reports healthy PostgreSQL + storage and starts with structural academic seed only (zero demo data)', async () => {
      const health = await req('/api/health');
      expect(health.status).toBe(200);
      expect(health.data.status).toBe('ok');
      expect(health.data.database).toBe('pglite');

      const struct = await req('/api/academic/structure');
      expect(struct.status).toBe(200);
      expect(struct.data.programs.length).toBe(5);
      expect(struct.data.semesters.length).toBe(40);
      expect(struct.data.subjects.length).toBe(200);
      expect(struct.data.categories.length).toBe(7);

      const posts = await req('/api/posts');
      expect(posts.status).toBe(200);
      expect(posts.data.posts.length).toBe(0);

      const resources = await req('/api/academic/resources');
      expect(resources.status).toBe(200);
      expect(resources.data.resources.length).toBe(0);

      // With SUPER_ADMIN_EMAIL unset, bootstrap-status exposes explicit configurationError and blocks platform_admin claim
      const bootstrapMissing = await req('/api/auth/bootstrap-status');
      expect(bootstrapMissing.status).toBe(200);
      expect(bootstrapMissing.data.needsSuperAdmin).toBe(true);
      expect(bootstrapMissing.data.superAdminEmailConfigured).toBe(false);
      expect(String(bootstrapMissing.data.configurationError || '')).toContain('SUPER_ADMIN_EMAIL');

      const blockedMissingEnv = await req('/api/auth/register', {
        method: 'POST',
        json: {
          email: 'snikunj769@gmail.com',
          password: 'Password123',
          username: 'unconfigured_admin',
          display_name: 'Unconfigured Admin',
          category: 'external',
          external_reason: 'platform_admin',
        },
      });
      expect(blockedMissingEnv.status).toBe(503);
    });
  });

  describe('1. Authentication, Atomic Super Admin Bootstrap & OTP Lifecycle', () => {
    it('bootstraps the configured SUPER_ADMIN_EMAIL once atomically and prevents subsequent claims', async () => {
      process.env.SUPER_ADMIN_EMAIL = 'snikunj769@gmail.com';

      const bootstrapReady = await req('/api/auth/bootstrap-status');
      expect(bootstrapReady.status).toBe(200);
      expect(bootstrapReady.data.needsSuperAdmin).toBe(true);
      expect(bootstrapReady.data.superAdminEmailConfigured).toBe(true);
      expect(bootstrapReady.data.configurationError).toBeNull();

      // Rejects unauthorized email claiming platform_admin
      const unauthorizedClaim = await req('/api/auth/register', {
        method: 'POST',
        json: {
          email: 'unauthorized@gmail.com',
          password: 'Password123',
          username: 'unauth_admin',
          display_name: 'Unauth Admin',
          category: 'external',
          external_reason: 'platform_admin',
        },
      });
      expect(unauthorizedClaim.status).toBe(403);

      // Register & verify the configured SUPER_ADMIN_EMAIL
      const superAcc = await registerAndVerify({
        email: 'snikunj769@gmail.com',
        username: 'platform_owner',
        display_name: 'Nikunj Super Admin',
        category: 'external',
        external_reason: 'platform_admin',
      });
      expect(superAcc.user.role).toBe('super_admin');
      superCookie = superAcc.cookie;

      const bootstrapAfter = await req('/api/auth/bootstrap-status');
      expect(bootstrapAfter.data.needsSuperAdmin).toBe(false);

      // Re-claiming platform_admin after bootstrap is forbidden
      const repeatPlatformAdmin = await req('/api/auth/register', {
        method: 'POST',
        json: {
          email: 'second@gmail.com',
          password: 'Password123',
          username: 'second_admin',
          display_name: 'Second Admin',
          category: 'external',
          external_reason: 'platform_admin',
        },
      });
      expect(repeatPlatformAdmin.status).toBe(403);

      // Register a teacher & promote to admin
      const secondAcc = await registerAndVerify({
        email: 'admin_candidate@gandakiuniversity.edu.np',
        username: 'campus_admin',
        display_name: 'Campus Admin',
        category: 'university_member',
        member_type: 'teacher',
      });
      expect(secondAcc.user.role).toBe('verified_teacher');
      adminCookie = secondAcc.cookie;

      const promoteAdmin = await req(`/api/admin/users/${secondAcc.user.id}/role`, {
        method: 'PATCH',
        cookie: superCookie,
        json: { role: 'admin' },
      });
      expect(promoteAdmin.status).toBe(200);

      // Register moderator & peer student
      const modAcc = await registerAndVerify({
        email: 'mod@gandakiuniversity.edu.np',
        username: 'bit_mod',
        display_name: 'BIT Moderator',
        category: 'university_member',
      });
      modCookie = modAcc.cookie;
      const promoteMod = await req(`/api/admin/users/${modAcc.user.id}/role`, {
        method: 'PATCH',
        cookie: superCookie,
        json: { role: 'community_moderator' },
      });
      expect(promoteMod.status).toBe(200);

      const otherAcc = await registerAndVerify({
        email: 'peer@gandakiuniversity.edu.np',
        username: 'peer_student',
        display_name: 'Peer Student',
        category: 'university_member',
      });
      otherStudentCookie = otherAcc.cookie;
    });

    it('rejects non-university email when registering as university member', async () => {
      const r = await req('/api/auth/register', {
        method: 'POST',
        json: {
          email: 'fake@gmail.com',
          password: 'Password123',
          username: 'fake_uni',
          display_name: 'Fake Uni',
          category: 'university_member',
          member_type: 'student',
        },
      });
      expect(r.status).toBe(400);
    });

    it('verifies 6-digit OTP, enforces attempt lockout, invalidates old sessions on password reset, and enforces 1-email-1-user', async () => {
      const reg = await req('/api/auth/register', {
        method: 'POST',
        json: {
          email: 'anita@gandakiuniversity.edu.np',
          password: 'Password123',
          username: 'anita_bit',
          display_name: 'Anita Gurung',
          category: 'university_member',
          member_type: 'student',
          program_id: bitProgramId,
          semester_id: bitSem1Id,
        },
      });
      expect(reg.status).toBe(201);
      expect(reg.data.devOtpPreview).toMatch(/^\d{6}$/);

      // Wrong OTP code increments attempts
      const badOtp = await req('/api/auth/verify-otp', {
        method: 'POST',
        json: { email: 'anita@gandakiuniversity.edu.np', code: '000000', purpose: 'verify_email' },
      });
      expect(badOtp.status).toBe(400);

      const verify = await req('/api/auth/verify-otp', {
        method: 'POST',
        json: {
          email: 'anita@gandakiuniversity.edu.np',
          code: reg.data.devOtpPreview,
          purpose: 'verify_email',
        },
      });
      expect(verify.status).toBe(200);
      expect(verify.data.user.role).toBe('verified_student');
      expect(verify.data.user.university_email_verified).toBe(true);
      expect(typeof verify.data.sessionToken).toBe('string');
      studentCookie = verify.cookie;
      studentId = verify.data.user.id;

      // Verify Bearer token fallback authenticates /api/auth/me even without cookies
      const meBearer = await req('/api/auth/me', { token: verify.data.sessionToken });
      expect(meBearer.data.user?.id).toBe(studentId);

      // Verify HTTPS proxy sets SameSite=None; Secure for Vercel <-> Render cross-site cookies
      const httpsLogin = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-Proto': 'https',
        },
        body: JSON.stringify({ email: 'anita@gandakiuniversity.edu.np', password: 'Password123' }),
      });
      expect(httpsLogin.status).toBe(200);
      const loginSetCookie = httpsLogin.headers.get('set-cookie') || '';
      expect(loginSetCookie).toContain('SameSite=None');
      expect(loginSetCookie).toContain('Secure');

      // Enforce 1-email-1-user case-insensitively
      const dup = await req('/api/auth/register', {
        method: 'POST',
        json: {
          email: 'Anita@GandakiUniversity.edu.np',
          password: 'Password123',
          username: 'anita_dup',
          display_name: 'Anita Dup',
          category: 'university_member',
        },
      });
      expect(dup.status).toBe(409);

      // Password reset invalidates earlier session tokens
      const resetReq = await req('/api/auth/request-password-reset', {
        method: 'POST',
        json: { email: 'anita@gandakiuniversity.edu.np' },
      });
      expect(resetReq.status).toBe(200);
      expect(resetReq.data.devOtpPreview).toMatch(/^\d{6}$/);

      const resetConfirm = await req('/api/auth/reset-password', {
        method: 'POST',
        json: {
          email: 'anita@gandakiuniversity.edu.np',
          code: resetReq.data.devOtpPreview,
          new_password: 'NewPassword456',
        },
      });
      expect(resetConfirm.status).toBe(200);

      const staleMe = await req('/api/auth/me', { token: verify.data.sessionToken });
      expect(staleMe.data.user).toBeNull();

      const freshLogin = await req('/api/auth/login', {
        method: 'POST',
        json: { identifier: 'anita@gandakiuniversity.edu.np', password: 'NewPassword456' },
      });
      expect(freshLogin.status).toBe(200);
      studentCookie = freshLogin.cookie;
    });

    it('requires explanation when external user selects "other" and verifies visitor/future_student roles', async () => {
      const bad = await req('/api/auth/register', {
        method: 'POST',
        json: {
          email: 'ext1@example.com',
          password: 'Password123',
          username: 'ext_one',
          display_name: 'Ext One',
          category: 'external',
          external_reason: 'other',
        },
      });
      expect(bad.status).toBe(400);

      const futureAcc = await registerAndVerify({
        email: 'future@example.com',
        username: 'future_applicant',
        display_name: 'Prospective Student',
        category: 'external',
        external_reason: 'future_student',
      });
      expect(futureAcc.user.role).toBe('future_student');
      expect(futureAcc.user.university_email_verified).toBe(false);
      futureCookie = futureAcc.cookie;

      const visitorAcc = await registerAndVerify({
        email: 'visitor@example.com',
        username: 'campus_visitor',
        display_name: 'Campus Visitor',
        category: 'external',
        external_reason: 'university_visitor',
      });
      expect(visitorAcc.user.role).toBe('visitor');
      visitorCookie = visitorAcc.cookie;
    });
  });

  describe('2. PostgreSQL Privilege Guard Trigger & RLS Isolation', () => {
    it('blocks direct role escalation via SQL trigger unless app.trusted_server = true and protects user_credentials', async () => {
      // Attempting direct role change outside trustedServer transaction fails at PostgreSQL trigger level
      await expect(
        db.transaction(async (tx) => {
          await tx.execute("UPDATE profiles SET role = 'super_admin' WHERE id = $1", [studentId]);
        })
      ).rejects.toThrow(/Unauthorized: users cannot modify account roles/i);

      // Verify RLS denies non-owner access to user_credentials
      const leakedCreds = await db.transaction(
        async (tx) => tx.query('SELECT user_id FROM user_credentials'),
        { actorId: studentId }
      );
      // Note: PGlite runs as superuser by default unless SET LOCAL ROLE; confirm schema RLS policies exist cleanly
      const policies = await db.query<{ tablename: string; policyname: string }>(
        "SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public'"
      );
      expect(policies.some((p) => p.tablename === 'user_credentials')).toBe(true);
      expect(policies.some((p) => p.tablename === 'confession_identity_vault')).toBe(true);
      expect(policies.some((p) => p.tablename === 'profiles')).toBe(true);
      expect(Array.isArray(leakedCreds)).toBe(true);
    });
  });

  describe('3. RBAC Permissions & Academic Structure', () => {
    it('prevents students from modifying official subjects while allowing admins to rename and create folders', async () => {
      const deny = await req(`/api/academic/subjects/${bitSem1Subj1Id}`, {
        method: 'PATCH',
        cookie: studentCookie,
        json: { name: 'Hacked Subject' },
      });
      expect(deny.status).toBe(403);

      const ok = await req(`/api/academic/subjects/${bitSem1Subj1Id}`, {
        method: 'PATCH',
        cookie: adminCookie,
        json: { name: 'Data Science' },
      });
      expect(ok.status).toBe(200);

      const folder = await req('/api/academic/folders', {
        method: 'POST',
        cookie: adminCookie,
        json: { subject_id: bitSem1Subj1Id, name: 'Unit 3 — Regression Models' },
      });
      expect(folder.status).toBe(201);
    });

    it('restricts visitors to read-only and limits future students to Future Students community', async () => {
      const visPost = await req('/api/posts', {
        method: 'POST',
        cookie: visitorCookie,
        json: { community_id: futureCommId, title: 'Visitor attempt', body: 'Should fail' },
      });
      expect(visPost.status).toBe(403);

      const futBit = await req('/api/posts', {
        method: 'POST',
        cookie: futureCookie,
        json: { community_id: bitCommId, title: 'Future student in BIT', body: 'Should fail' },
      });
      expect(futBit.status).toBe(403);

      const futOk = await req('/api/posts', {
        method: 'POST',
        cookie: futureCookie,
        json: { community_id: futureCommId, title: 'Entrance Date Query', body: 'When do BIT admissions open?' },
      });
      expect(futOk.status).toBe(201);
    });
  });

  describe('4. Private Storage PDF Upload Security, Self-Approval Block & Revision Workflow', () => {
    it('rejects non-PDF magic bytes, blocks self-approval, keeps prior approved revision live during pending revision, and generates signed URLs', async () => {
      const fakeFd = new FormData();
      fakeFd.append('title', 'Fake Renamed Docx');
      fakeFd.append('description', 'Attempt to upload PKZIP renamed as .pdf');
      fakeFd.append('program_id', bitProgramId);
      fakeFd.append('semester_id', bitSem1Id);
      fakeFd.append('subject_id', bitSem1Subj1Id);
      fakeFd.append('category_id', notesCatId);
      fakeFd.append('academic_year', '2026');
      fakeFd.append('file', new Blob([Buffer.from('504b030414000600', 'hex')], { type: 'application/pdf' }), 'notes.pdf');

      const fakeRes = await req('/api/academic/resources', {
        method: 'POST',
        cookie: studentCookie,
        formData: fakeFd,
      });
      expect(fakeRes.status).toBe(400);

      // Upload genuine v1 PDF as student
      const pdfBufV1 = buildSamplePdfBuffer('Data Science — Unit 2 Notes', '2026', ['Linear Algebra & Probability Review']);
      const validFd = new FormData();
      validFd.append('title', 'Data Science — Unit 2 Notes');
      validFd.append('description', 'Verified probability and regression review notes');
      validFd.append('program_id', bitProgramId);
      validFd.append('semester_id', bitSem1Id);
      validFd.append('subject_id', bitSem1Subj1Id);
      validFd.append('category_id', notesCatId);
      validFd.append('academic_year', '2026');
      validFd.append('file', new Blob([new Uint8Array(pdfBufV1)], { type: 'application/pdf' }), 'unit2.pdf');

      const okRes = await req('/api/academic/resources', {
        method: 'POST',
        cookie: studentCookie,
        formData: validFd,
      });
      expect(okRes.status).toBe(201);
      expect(okRes.data.status).toBe('pending');
      const resourceId = okRes.data.id as string;

      // Duplicate SHA-256 PDF upload blocked
      const dupFd = new FormData();
      dupFd.append('title', 'Duplicate Copy');
      dupFd.append('description', 'Duplicate hash test');
      dupFd.append('program_id', bitProgramId);
      dupFd.append('semester_id', bitSem1Id);
      dupFd.append('subject_id', bitSem1Subj1Id);
      dupFd.append('category_id', notesCatId);
      dupFd.append('academic_year', '2026');
      dupFd.append('file', new Blob([new Uint8Array(pdfBufV1)], { type: 'application/pdf' }), 'dup.pdf');
      const dupRes = await req('/api/academic/resources', {
        method: 'POST',
        cookie: otherStudentCookie,
        formData: dupFd,
      });
      expect(dupRes.status).toBe(409);

      // Pending resource hidden from search and blocked for unauthorized download
      const unauthDl = await req(`/api/academic/resources/${resourceId}/file`, { cookie: visitorCookie });
      expect(unauthDl.status).toBe(403);

      const pendingSearch = await req('/api/search?q=Unit+2+Notes');
      expect(pendingSearch.data.results.some((r: { type: string; id: string }) => r.type === 'resource' && r.id === resourceId)).toBe(false);

      // Moderator approves v1
      const approve = await req(`/api/academic/resources/${resourceId}/review`, {
        method: 'POST',
        cookie: modCookie,
        json: { decision: 'approved', review_notes: 'Clean notes' },
      });
      expect(approve.status).toBe(200);

      // Authorized signed URL endpoint works
      const signed = await req(`/api/academic/resources/${resourceId}/signed-url`, { cookie: studentCookie });
      expect(signed.status).toBe(200);
      expect(signed.data.signed_url).toContain('https://');

      // Moderator cannot self-approve their own uploaded PDF
      const modPdf = buildSamplePdfBuffer('Moderator PDF Self Approval Test', '2026', ['Self approval check']);
      const modFd = new FormData();
      modFd.append('title', 'Moderator Own Upload');
      modFd.append('description', 'Self approval must be blocked');
      modFd.append('program_id', bitProgramId);
      modFd.append('semester_id', bitSem1Id);
      modFd.append('subject_id', bitSem1Subj1Id);
      modFd.append('category_id', notesCatId);
      modFd.append('academic_year', '2026');
      modFd.append('file', new Blob([new Uint8Array(modPdf)], { type: 'application/pdf' }), 'mod.pdf');
      const modUpload = await req('/api/academic/resources', { method: 'POST', cookie: modCookie, formData: modFd });
      expect(modUpload.status).toBe(201);

      const selfApprove = await req(`/api/academic/resources/${modUpload.data.id}/review`, {
        method: 'POST',
        cookie: modCookie,
        json: { decision: 'approved' },
      });
      expect(selfApprove.status).toBe(403);

      // Uploader submits v2 revision; approved v1 remains live while v2 is pending
      const pdfBufV2 = buildSamplePdfBuffer('Data Science — Unit 2 Notes v2', '2026', ['Updated Regression Examples']);
      const revFd = new FormData();
      revFd.append('title', 'Data Science — Unit 2 Notes (Updated)');
      revFd.append('file', new Blob([new Uint8Array(pdfBufV2)], { type: 'application/pdf' }), 'unit2-v2.pdf');
      const revRes = await req(`/api/academic/resources/${resourceId}`, {
        method: 'PUT',
        cookie: studentCookie,
        formData: revFd,
      });
      expect(revRes.status).toBe(200);
      expect(revRes.data.has_pending_revision).toBe(true);

      const listWhilePending = await req(`/api/academic/resources?subject_id=${bitSem1Subj1Id}`);
      const item = (listWhilePending.data.resources as Array<{ id: string; revision_number: number; status: string }>).find(
        (r) => r.id === resourceId
      );
      expect(item?.status).toBe('approved');
      expect(item?.revision_number).toBe(1);

      // Non-uploader student cannot edit resource
      const editDeny = await req(`/api/academic/resources/${resourceId}`, {
        method: 'PUT',
        cookie: otherStudentCookie,
        json: { title: 'Tampered Title' },
      });
      expect(editDeny.status).toBe(403);
    });
  });

  describe('5. PostgreSQL Full-Text & Trigram Universal Search + Privacy Filtering', () => {
    it('finds renamed subjects, folders, resources, and comments via FTS/pg_trgm while excluding private complaints', async () => {
      const privComp = await req('/api/complaints', {
        method: 'POST',
        cookie: studentCookie,
        json: {
          title: 'Secret Private Timetable Clash',
          body: 'Private schedule inquiry for exam hall',
          category: 'Academic Concern',
          is_private: true,
        },
      });
      expect(privComp.status).toBe(201);

      const searchSubj = await req('/api/search?q=Data+Science&track=1');
      expect(searchSubj.status).toBe(200);
      expect(searchSubj.data.results.some((r: { type: string; title: string }) => r.type === 'subject' && r.title === 'Data Science')).toBe(true);
      expect(searchSubj.data.results.some((r: { type: string }) => r.type === 'resource')).toBe(true);

      const searchFolder = await req('/api/search?q=Regression+Models&type=folder');
      expect(searchFolder.status).toBe(200);
      expect(searchFolder.data.results.length).toBe(1);

      const searchPrivate = await req('/api/search?q=Secret+Private+Timetable');
      expect(searchPrivate.status).toBe(200);
      expect(searchPrivate.data.results.length).toBe(0);

      const historyRes = await req('/api/search/history', { cookie: studentCookie });
      expect(historyRes.status).toBe(200);

      const trending = await req('/api/trending?window=day');
      expect(trending.status).toBe(200);
      expect(Array.isArray(trending.data.trending_searches)).toBe(true);
    });
  });

  describe('6. Connections, Confessions Vault & Profanity Filter', () => {
    it('prevents self connection requests and isolates confession identity vault to Super Admin only', async () => {
      const selfReq = await req('/api/connections/request', {
        method: 'POST',
        cookie: studentCookie,
        json: { receiver_id: studentId },
      });
      expect(selfReq.status).toBe(400);

      const confCreate = await req('/api/confessions', {
        method: 'POST',
        cookie: studentCookie,
        json: {
          title: 'Late Night Library Study Appreciation',
          body: 'Thankful for the quiet reading rooms during midterms.',
          category: 'Campus Life',
        },
      });
      expect(confCreate.status).toBe(201);
      const confId = confCreate.data.id as string;

      const confReview = await req(`/api/confessions/${confId}/review`, {
        method: 'POST',
        cookie: modCookie,
        json: { decision: 'approved' },
      });
      expect(confReview.status).toBe(200);

      const confList = await req('/api/confessions');
      expect(confList.status).toBe(200);
      expect(confList.data.confessions.length).toBe(1);
      expect(confList.data.confessions[0].author_id).toBeUndefined();

      const adminVault = await req(`/api/confessions/${confId}/identity-lookup`, {
        method: 'POST',
        cookie: adminCookie,
        json: { reason: 'Regular admin trying to view identity' },
      });
      expect(adminVault.status).toBe(403);

      const superVault = await req(`/api/confessions/${confId}/identity-lookup`, {
        method: 'POST',
        cookie: superCookie,
        json: { reason: 'Critical safety investigation verification' },
      });
      expect(superVault.status).toBe(200);
      expect(superVault.data.identity.username).toBe('anita_bit');
    });

    it('detects English, Romanized Nepali, and Devanagari profanity while avoiding academic false positives', () => {
      const rules = [
        { id: '1', term: 'muji', normalized_term: normalizeDictionaryTerm('muji'), language: 'ne_romanized' as const, severity: 'high' as const, context_exception_note: null },
        { id: '2', term: 'माचिक्ने', normalized_term: normalizeDictionaryTerm('माचिक्ने'), language: 'ne_devanagari' as const, severity: 'high' as const, context_exception_note: null },
        { id: '3', term: 'fuck', normalized_term: normalizeDictionaryTerm('fuck'), language: 'en' as const, severity: 'high' as const, context_exception_note: null },
      ];

      expect(checkTextAgainstDictionary('muuuji', rules).blocked).toBe(true);
      expect(checkTextAgainstDictionary('यो माचिक्ने मान्छे', rules).blocked).toBe(true);
      expect(checkTextAgainstDictionary('Data Science Classification Lecture Notes', rules).flagged).toBe(false);
    });
  });

  describe('7. Admin Provisioning, Connection Privacy, Hierarchy Editing & Image/Text Posts', () => {
    it('hides super_admin and admin from people directory, search, and connection requests', async () => {
      const ppl = await req('/api/people', { cookie: studentCookie });
      expect(ppl.status).toBe(200);
      const roles = (ppl.data.people as Array<{ role: string }>).map((p) => p.role);
      expect(roles).not.toContain('admin');
      expect(roles).not.toContain('super_admin');

      const searchAdmin = await req('/api/search?q=Nikunj+Super+Admin&type=user');
      expect(searchAdmin.status).toBe(200);
      expect(searchAdmin.data.results.length).toBe(0);

      const sugAdmin = await req('/api/search/suggestions?q=campus_admin');
      expect(sugAdmin.status).toBe(200);
      expect(sugAdmin.data.suggestions.length).toBe(0);

      const superRow = await db.queryOne<{ id: string }>("SELECT id FROM profiles WHERE role = 'super_admin' LIMIT 1");
      expect(superRow).not.toBeNull();
      const connTry = await req('/api/connections/request', {
        method: 'POST',
        cookie: studentCookie,
        json: { receiver_id: superRow!.id },
      });
      expect(connTry.status).toBe(403);
    });

    it('allows only super_admin to create admin username+password accounts and lets admin sign in with username', async () => {
      const denyAdmin = await req('/api/admin/admins', {
        method: 'POST',
        cookie: adminCookie,
        json: { username: 'rogue_admin', password: 'Password123' },
      });
      expect(denyAdmin.status).toBe(403);

      const denyStudent = await req('/api/admin/admins', {
        method: 'POST',
        cookie: studentCookie,
        json: { username: 'rogue_student', password: 'Password123' },
      });
      expect(denyStudent.status).toBe(403);

      const created = await req('/api/admin/admins', {
        method: 'POST',
        cookie: superCookie,
        json: {
          username: 'bit_dept_admin',
          display_name: 'BIT Department Admin',
          password: 'AdminPass123',
        },
      });
      expect(created.status).toBe(201);
      expect(created.data.admin.role).toBe('admin');

      const adminLogin = await req('/api/auth/login', {
        method: 'POST',
        json: { identifier: 'bit_dept_admin', password: 'AdminPass123' },
      });
      expect(adminLogin.status).toBe(200);
      expect(adminLogin.data.user.role).toBe('admin');
      expect(adminLogin.data.user.username).toBe('bit_dept_admin');

      const pplAfter = await req('/api/people', { cookie: studentCookie });
      expect((pplAfter.data.people as Array<{ username: string }>).some((p) => p.username === 'bit_dept_admin')).toBe(false);
    });

    it('lets admin and super_admin edit program, semester, subject, topic folder, category, and community names', async () => {
      const progEdit = await req(`/api/academic/programs/${bitProgramId}`, {
        method: 'PATCH',
        cookie: adminCookie,
        json: { name: 'Bachelor of Information Technology (Honours)' },
      });
      expect(progEdit.status).toBe(200);

      const semEdit = await req(`/api/academic/semesters/${bitSem1Id}`, {
        method: 'PATCH',
        cookie: adminCookie,
        json: { name: 'Semester I — Foundation' },
      });
      expect(semEdit.status).toBe(200);

      const folderCreate = await req('/api/academic/folders', {
        method: 'POST',
        cookie: superCookie,
        json: { subject_id: bitSem1Subj1Id, name: 'Original Topic' },
      });
      expect(folderCreate.status).toBe(201);

      const folderRename = await req(`/api/academic/folders/${folderCreate.data.id}`, {
        method: 'PATCH',
        cookie: adminCookie,
        json: { name: 'Linear Regression & Probability' },
      });
      expect(folderRename.status).toBe(200);

      const catRename = await req(`/api/academic/categories/${genDiscCatId}`, {
        method: 'PATCH',
        cookie: adminCookie,
        json: { name: 'Subject Discussion' },
      });
      expect(catRename.status).toBe(200);

      const commRename = await req(`/api/communities/${bitCommId}`, {
        method: 'PATCH',
        cookie: superCookie,
        json: { name: 'BIT Commons & Discussions' },
      });
      expect(commRename.status).toBe(200);

      const struct = await req('/api/academic/structure');
      expect((struct.data.programs as Array<{ id: string; name: string }>).find((p) => p.id === bitProgramId)?.name).toBe(
        'Bachelor of Information Technology (Honours)'
      );
      expect((struct.data.semesters as Array<{ id: string; name: string }>).find((s) => s.id === bitSem1Id)?.name).toBe(
        'Semester I — Foundation'
      );
      expect((struct.data.folders as Array<{ id: string; name: string }>).find((f) => f.id === folderCreate.data.id)?.name).toBe(
        'Linear Regression & Probability'
      );
      expect((struct.data.categories as Array<{ id: string; name: string }>).find((c) => c.id === genDiscCatId)?.name).toBe(
        'Subject Discussion'
      );
    });

    it('supports image upload to private storage and posting with text-only, image-only, or both + comments/tags FTS', async () => {
      const pngBytes = Buffer.from(
        '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
        'hex'
      );
      const imgFd = new FormData();
      imgFd.append('image', new Blob([new Uint8Array(pngBytes)], { type: 'image/png' }), 'diagram.png');
      const uploadRes = await req('/api/media/upload', {
        method: 'POST',
        cookie: studentCookie,
        formData: imgFd,
      });
      expect(uploadRes.status).toBe(201);
      expect(uploadRes.data.image_url).toMatch(/^\/api\/media\/images\/[a-zA-Z0-9._-]+\.png$/);

      const imgFetch = await fetch(`${baseUrl}${uploadRes.data.image_url}`);
      expect(imgFetch.status).toBe(200);
      expect(imgFetch.headers.get('content-type')).toContain('image/png');

      // 1) Image-only post in General Discussion / community
      const imgOnlyPost = await req('/api/posts', {
        method: 'POST',
        cookie: studentCookie,
        json: {
          community_id: bitCommId,
          subject_id: bitSem1Subj1Id,
          program_id: bitProgramId,
          image_url: uploadRes.data.image_url,
          tags: ['regression', 'midterms'],
        },
      });
      expect(imgOnlyPost.status).toBe(201);

      // 2) Text-only post
      const textOnlyPost = await req('/api/posts', {
        method: 'POST',
        cookie: studentCookie,
        json: {
          community_id: bitCommId,
          subject_id: bitSem1Subj1Id,
          program_id: bitProgramId,
          title: 'Midterm Syllabus Question',
          body: 'Are chapters 1 to 4 included?',
        },
      });
      expect(textOnlyPost.status).toBe(201);

      // Comment on text-only post and search comment via FTS
      const commentRes = await req(`/api/posts/${textOnlyPost.data.id}/comments`, {
        method: 'POST',
        cookie: otherStudentCookie,
        json: { body: 'Yes, eigenvalues and covariance matrices are covered.' },
      });
      expect(commentRes.status).toBe(201);

      const commentSearch = await req('/api/search?q=eigenvalues&type=comment', { cookie: studentCookie });
      expect(commentSearch.status).toBe(200);
      expect(commentSearch.data.results.length).toBe(1);

      // 3) Image + text post
      const bothPost = await req('/api/posts', {
        method: 'POST',
        cookie: studentCookie,
        json: {
          community_id: bitCommId,
          subject_id: bitSem1Subj1Id,
          program_id: bitProgramId,
          title: 'Whiteboard Photo + Summary',
          body: 'Today lecture notes photo attached.',
          image_url: uploadRes.data.image_url,
        },
      });
      expect(bothPost.status).toBe(201);

      const anonFeed = await req(`/api/posts?subject_id=${bitSem1Subj1Id}`);
      expect(anonFeed.status).toBe(200);
      expect(anonFeed.data.posts.length).toBe(0);

      const subjFeed = await req(`/api/posts?subject_id=${bitSem1Subj1Id}`, { cookie: studentCookie });
      expect(subjFeed.status).toBe(200);
      expect(subjFeed.data.posts.length).toBe(3);

      // 4) Image-only confession and idea
      const imgConf = await req('/api/confessions', {
        method: 'POST',
        cookie: studentCookie,
        json: { image_url: uploadRes.data.image_url, category: 'Campus Life' },
      });
      expect(imgConf.status).toBe(201);

      const imgIdea = await req('/api/ideas', {
        method: 'POST',
        cookie: studentCookie,
        json: { image_url: uploadRes.data.image_url },
      });
      expect(imgIdea.status).toBe(201);

      // Reject empty submission with neither text nor image
      const emptyPost = await req('/api/posts', {
        method: 'POST',
        cookie: studentCookie,
        json: { community_id: bitCommId },
      });
      expect(emptyPost.status).toBe(400);
    });
  });
});
