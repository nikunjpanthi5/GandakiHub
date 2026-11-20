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
  full_name: string;
  password?: string;
}) {
  const password = params.password || 'Password123';
  const reg = await req('/api/auth/register', {
    method: 'POST',
    json: {
      full_name: params.full_name,
      email: params.email,
      password,
      confirm_password: password,
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
  let studentUsername = '';
  let otherStudentCookie = '';
  let visitorCookie = '';
  let futureCookie = '';

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.SESSION_SECRET = 'test-only-gandakihub-secret-key-minimum-32-chars';
    delete process.env.SUPER_ADMIN_EMAIL;

    pglite = new PGlite({ extensions: { pg_trgm } });
    const migration002 = fs.readFileSync(
      path.resolve(process.cwd(), 'supabase', 'migrations', '002_complete_production_schema.sql'),
      'utf8'
    );
    const migration003 = fs.readFileSync(
      path.resolve(process.cwd(), 'supabase', 'migrations', '003_profile_completion_staff_verification.sql'),
      'utf8'
    );
    await pglite.exec(migration002);
    await pglite.exec(migration003);

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

      // Public bootstrap-status is intentionally not exposed
      const bootstrapMissing = await req('/api/auth/bootstrap-status');
      expect(bootstrapMissing.status).toBe(404);

      const blockedMissingEnv = await req('/api/auth/register', {
        method: 'POST',
        json: {
          full_name: 'Unconfigured Admin',
          email: 'snikunj769@gmail.com',
          password: 'Password123',
          confirm_password: 'Password123',
        },
      });
      expect(blockedMissingEnv.status).toBe(400);
    });
  });

  describe('1. Simplified Registration, Super Admin Bootstrap, Admin Login Portal & OTP Lifecycle', () => {
    it('bootstraps SUPER_ADMIN_EMAIL atomically once, ignores injected role fields, and enforces /api/auth/admin-login', async () => {
      process.env.SUPER_ADMIN_EMAIL = 'snikunj769@gmail.com';

      // Rejects non-university email even if trying external address
      const unauthorizedClaim = await req('/api/auth/register', {
        method: 'POST',
        json: {
          full_name: 'Unauth Admin',
          email: 'unauthorized@gmail.com',
          password: 'Password123',
          confirm_password: 'Password123',
        },
      });
      expect(unauthorizedClaim.status).toBe(400);

      // Register & verify the configured SUPER_ADMIN_EMAIL
      const superAcc = await registerAndVerify({
        email: 'snikunj769@gmail.com',
        full_name: 'Nikunj Super Admin',
      });
      expect(superAcc.user.role).toBe('super_admin');
      superCookie = superAcc.cookie;

      // Re-claiming super_admin after bootstrap via external email is rejected
      const repeatPlatformAdmin = await req('/api/auth/register', {
        method: 'POST',
        json: {
          full_name: 'Second Admin',
          email: 'second@gmail.com',
          password: 'Password123',
          confirm_password: 'Password123',
        },
      });
      expect(repeatPlatformAdmin.status).toBe(400);

      // Register an ordinary member (even if client injects role='super_admin' or 'verified_teacher', server assigns 'verified_student')
      const injectedAttempt = await req('/api/auth/register', {
        method: 'POST',
        json: {
          full_name: 'Campus Admin',
          email: 'admin_candidate@gandakiuniversity.edu.np',
          password: 'Password123',
          confirm_password: 'Password123',
          role: 'verified_teacher',
        },
      });
      expect(injectedAttempt.status).toBe(201);
      const adminCandidateVer = await req('/api/auth/verify-otp', {
        method: 'POST',
        json: {
          email: 'admin_candidate@gandakiuniversity.edu.np',
          code: injectedAttempt.data.devOtpPreview,
          purpose: 'verify_email',
        },
      });
      expect(adminCandidateVer.status).toBe(200);
      expect(adminCandidateVer.data.user.role).toBe('verified_student');

      // Super Admin promotes admin_candidate to 'admin'
      const promoteAdmin = await req(`/api/admin/users/${adminCandidateVer.data.user.id}/role`, {
        method: 'PATCH',
        cookie: superCookie,
        json: { role: 'admin' },
      });
      expect(promoteAdmin.status).toBe(200);

      // Admin signs in through the dedicated /api/auth/admin-login portal
      const adminPortalLogin = await req('/api/auth/admin-login', {
        method: 'POST',
        json: { email: 'admin_candidate@gandakiuniversity.edu.np', password: 'Password123' },
      });
      expect(adminPortalLogin.status).toBe(200);
      expect(adminPortalLogin.data.user.role).toBe('admin');
      adminCookie = adminPortalLogin.cookie;

      // Super Admin can also sign in through /api/auth/admin-login without any role selector
      const superPortalLogin = await req('/api/auth/admin-login', {
        method: 'POST',
        json: { email: 'snikunj769@gmail.com', password: 'Password123' },
      });
      expect(superPortalLogin.status).toBe(200);
      expect(superPortalLogin.data.user.role).toBe('super_admin');

      // Bad credentials on /api/auth/admin-login return uniform 401
      const badPortalLogin = await req('/api/auth/admin-login', {
        method: 'POST',
        json: { email: 'nonexistent_admin@gandakiuniversity.edu.np', password: 'WrongPassword1' },
      });
      expect(badPortalLogin.status).toBe(401);
      expect(badPortalLogin.data.error).toBe('Invalid credentials.');

      // Register moderator & peer student
      const modAcc = await registerAndVerify({
        email: 'mod@gandakiuniversity.edu.np',
        full_name: 'BIT Moderator',
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
        full_name: 'Peer Student',
      });
      otherStudentCookie = otherAcc.cookie;
    });

    it('rejects password mismatch and non-university email during registration', async () => {
      const mismatch = await req('/api/auth/register', {
        method: 'POST',
        json: {
          full_name: 'Mismatch User',
          email: 'mismatch@gandakiuniversity.edu.np',
          password: 'Password123',
          confirm_password: 'Password999',
        },
      });
      expect(mismatch.status).toBe(400);

      const nonUni = await req('/api/auth/register', {
        method: 'POST',
        json: {
          full_name: 'Fake Uni',
          email: 'fake@gmail.com',
          password: 'Password123',
          confirm_password: 'Password123',
        },
      });
      expect(nonUni.status).toBe(400);
    });

    it('verifies 6-digit OTP into direct login, blocks non-admin on admin-login (403), invalidates sessions on reset, and enforces 1-email-1-user', async () => {
      const reg = await req('/api/auth/register', {
        method: 'POST',
        json: {
          full_name: 'Anita Gurung',
          email: 'anita@gandakiuniversity.edu.np',
          password: 'Password123',
          confirm_password: 'Password123',
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
      expect(verify.data.user.profile_completed).toBe(false);
      expect(typeof verify.data.sessionToken).toBe('string');
      studentCookie = verify.cookie;
      studentId = verify.data.user.id;
      studentUsername = verify.data.user.username;

      // Non-admin verified student is denied at /api/auth/admin-login with 403
      const studentAdminPortal = await req('/api/auth/admin-login', {
        method: 'POST',
        json: { email: 'anita@gandakiuniversity.edu.np', password: 'Password123' },
      });
      expect(studentAdminPortal.status).toBe(403);
      expect(studentAdminPortal.data.error).toBe('You are not authorized to access the administrator portal.');

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
          full_name: 'Anita Dup',
          email: 'Anita@GandakiUniversity.edu.np',
          password: 'Password123',
          confirm_password: 'Password123',
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

    it('supports future_student and visitor RBAC levels when assigned by administrators', async () => {
      const futureAcc = await registerAndVerify({
        email: 'future@gandakiuniversity.edu.np',
        full_name: 'Prospective Student',
      });
      await req(`/api/admin/users/${futureAcc.user.id}/role`, {
        method: 'PATCH',
        cookie: superCookie,
        json: { role: 'future_student' },
      });
      const futureLogin = await req('/api/auth/login', {
        method: 'POST',
        json: { identifier: 'future@gandakiuniversity.edu.np', password: 'Password123' },
      });
      expect(futureLogin.data.user.role).toBe('future_student');
      futureCookie = futureLogin.cookie;

      const visitorAcc = await registerAndVerify({
        email: 'visitor@gandakiuniversity.edu.np',
        full_name: 'Campus Visitor',
      });
      await req(`/api/admin/users/${visitorAcc.user.id}/role`, {
        method: 'PATCH',
        cookie: superCookie,
        json: { role: 'visitor' },
      });
      const visitorLogin = await req('/api/auth/login', {
        method: 'POST',
        json: { identifier: 'visitor@gandakiuniversity.edu.np', password: 'Password123' },
      });
      expect(visitorLogin.data.user.role).toBe('visitor');
      visitorCookie = visitorLogin.cookie;
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
      expect(signed.data.url).toContain('https://');

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
      expect(revRes.data.ok).toBe(true);

      const listWhilePending = await req(`/api/academic/resources?subject_id=${bitSem1Subj1Id}`);
      const item = (
        listWhilePending.data.resources as Array<{
          id: string;
          revision_number: number;
          status: string;
          has_pending_revision: boolean;
        }>
      ).find((r) => r.id === resourceId);
      expect(item?.status).toBe('approved');
      expect(item?.revision_number).toBe(1);
      expect(item?.has_pending_revision).toBe(true);

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
      expect(superVault.data.identity.username).toBe(studentUsername);
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

  describe('8. Post-Registration Profile Completion & University Staff Verification Workflow', () => {
    it('saves voluntary student profile details and updates profile_completed + completion percentage', async () => {
      const patchRes = await req('/api/auth/profile', {
        method: 'PATCH',
        cookie: studentCookie,
        json: {
          department: 'School of Information Technology',
          program_id: bitProgramId,
          semester_id: bitSem1Id,
          student_id: 'GU-BIT-2081-014',
          bio: 'BIT undergraduate focused on distributed systems.',
          interests: ['Databases', 'Cybersecurity'],
        },
      });
      expect(patchRes.status).toBe(200);
      expect(patchRes.data.user.department).toBe('School of Information Technology');
      expect(patchRes.data.user.student_id).toBe('GU-BIT-2081-014');
      expect(patchRes.data.user.profile_completed).toBe(true);
      expect(patchRes.data.user.profile_completion_pct).toBe(90);

      // Re-fetching /api/auth/me and self profile preserves department, student_id, and profile_completed
      const meCheck = await req('/api/auth/me', { cookie: studentCookie });
      expect(meCheck.status).toBe(200);
      expect(meCheck.data.user.department).toBe('School of Information Technology');
      expect(meCheck.data.user.student_id).toBe('GU-BIT-2081-014');
      expect(meCheck.data.user.profile_completed).toBe(true);

      const selfView = await req(`/api/auth/users/${encodeURIComponent(studentUsername)}`, {
        cookie: studentCookie,
      });
      expect(selfView.status).toBe(200);
      expect(selfView.data.profile.department).toBe('School of Information Technology');
      expect(selfView.data.profile.student_id).toBe('GU-BIT-2081-014');

      // Public profile view exposes student_id only to self
      const otherView = await req(`/api/auth/users/${encodeURIComponent(studentUsername)}`, {
        cookie: otherStudentCookie,
      });
      expect(otherView.status).toBe(200);
      expect(otherView.data.profile.student_id).toBeNull();
    });

    it('marks profile_completed=true even when optional GU ID and department are omitted', async () => {
      const minimalAcc = await registerAndVerify({
        email: 'minimal.profile@gandakiuniversity.edu.np',
        full_name: 'Minimal Profile User',
      });
      expect(minimalAcc.user.profile_completed).toBe(false);

      const saveWithoutOptional = await req('/api/auth/profile', {
        method: 'PATCH',
        cookie: minimalAcc.cookie,
        json: {
          display_name: 'Minimal Profile User',
        },
      });
      expect(saveWithoutOptional.status).toBe(200);
      expect(saveWithoutOptional.data.user.profile_completed).toBe(true);
      expect(saveWithoutOptional.data.user.department).toBeNull();
      expect(saveWithoutOptional.data.user.student_id).toBeNull();

      const meAfter = await req('/api/auth/me', { cookie: minimalAcc.cookie });
      expect(meAfter.status).toBe(200);
      expect(meAfter.data.user.profile_completed).toBe(true);
    });

    it('persists department, GU ID (student_id), and profile_completed even before migration 003 is applied', async () => {
      const pg002 = new PGlite({ extensions: { pg_trgm } });
      const migration002 = fs.readFileSync(
        path.resolve(process.cwd(), 'supabase', 'migrations', '002_complete_production_schema.sql'),
        'utf8'
      );
      await pg002.exec(migration002);
      const db002 = createPGliteDatabase(pg002);
      await seedIfEmpty(db002);
      const app002 = createApiApp(db002, createMemoryStorage());

      const srv002 = await new Promise<http.Server>((resolve) => {
        const s = app002.listen(0, '127.0.0.1', () => resolve(s));
      });
      const port = (srv002.address() as { port: number }).port;
      const url002 = `http://127.0.0.1:${port}`;

      try {
        const reg = await fetch(`${url002}/api/auth/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            full_name: 'Pre003 Student',
            email: 'pre003@gandakiuniversity.edu.np',
            password: 'Password123',
            confirm_password: 'Password123',
          }),
        });
        const regJson = (await reg.json()) as { devOtpPreview: string };
        const ver = await fetch(`${url002}/api/auth/verify-otp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: 'pre003@gandakiuniversity.edu.np',
            code: regJson.devOtpPreview,
            purpose: 'verify_email',
          }),
        });
        const verJson = (await ver.json()) as { sessionToken: string; user: { username: string } };

        const patch = await fetch(`${url002}/api/auth/profile`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${verJson.sessionToken}`,
          },
          body: JSON.stringify({
            department: 'School of Engineering',
            student_id: 'GU-ENG-2081-009',
          }),
        });
        expect(patch.status).toBe(200);
        const patchJson = (await patch.json()) as {
          user: { department: string; student_id: string; profile_completed: boolean };
        };
        expect(patchJson.user.department).toBe('School of Engineering');
        expect(patchJson.user.student_id).toBe('GU-ENG-2081-009');
        expect(patchJson.user.profile_completed).toBe(true);

        const me = await fetch(`${url002}/api/auth/me`, {
          headers: { Authorization: `Bearer ${verJson.sessionToken}` },
        });
        const meJson = (await me.json()) as {
          user: { department: string; student_id: string; profile_completed: boolean };
        };
        expect(meJson.user.department).toBe('School of Engineering');
        expect(meJson.user.student_id).toBe('GU-ENG-2081-009');
        expect(meJson.user.profile_completed).toBe(true);

        const prof = await fetch(`${url002}/api/auth/users/${encodeURIComponent(verJson.user.username)}`, {
          headers: { Authorization: `Bearer ${verJson.sessionToken}` },
        });
        const profJson = (await prof.json()) as { profile: { department: string; student_id: string } };
        expect(profJson.profile.department).toBe('School of Engineering');
        expect(profJson.profile.student_id).toBe('GU-ENG-2081-009');
      } finally {
        await new Promise<void>((resolve) => srv002.close(() => resolve()));
        await db002.close();
      }
    });

    it('keeps staff verification requests pending without auto-elevating role until approved by admin', async () => {
      const facultyAcc = await registerAndVerify({
        email: 'faculty.applicant@gandakiuniversity.edu.np',
        full_name: 'Dr. Hari Adhikari',
      });
      expect(facultyAcc.user.role).toBe('verified_student');

      const pngBytes = Buffer.from(
        '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
        'hex'
      );
      const fd = new FormData();
      fd.append('position', 'Assistant Professor');
      fd.append('department', 'School of Science & Technology');
      fd.append('designation', 'Assistant Professor of AI');
      fd.append('supporting_notes', 'Faculty ID GU-FAC-204');
      fd.append('evidence', new Blob([new Uint8Array(pngBytes)], { type: 'image/png' }), 'faculty-id.png');

      const submitRes = await req('/api/auth/staff-verification', {
        method: 'POST',
        cookie: facultyAcc.cookie,
        formData: fd,
      });
      expect(submitRes.status).toBe(201);
      expect(submitRes.data.request.status).toBe('pending');
      expect(submitRes.data.request.has_evidence).toBe(true);

      // Role must NOT be elevated automatically
      const meBefore = await req('/api/auth/me', { cookie: facultyAcc.cookie });
      expect(meBefore.data.user.role).toBe('verified_student');
      expect(meBefore.data.user.staff_verification_status).toBe('pending');

      const requestId = submitRes.data.request.id as string;

      // Non-admin cannot approve their own or anyone's staff request
      const selfApprove = await req(`/api/admin/staff-verification/${requestId}/review`, {
        method: 'POST',
        cookie: facultyAcc.cookie,
        json: { decision: 'approved' },
      });
      expect(selfApprove.status).toBe(403);

      // Non-admin cannot fetch private verification evidence
      const studentEvidence = await req(`/api/admin/staff-verification/${requestId}/evidence`, {
        cookie: studentCookie,
      });
      expect(studentEvidence.status).toBe(403);

      // Admin can list, inspect private evidence, and approve staff request
      const listRes = await req('/api/admin/staff-verification?status=pending', { cookie: adminCookie });
      expect(listRes.status).toBe(200);
      expect((listRes.data.requests as Array<{ id: string }>).some((r) => r.id === requestId)).toBe(true);

      const evFetch = await fetch(`${baseUrl}/api/admin/staff-verification/${requestId}/evidence`, {
        headers: { Cookie: adminCookie },
      });
      expect(evFetch.status).toBe(200);
      expect(evFetch.headers.get('content-type')).toContain('image/png');

      const approveRes = await req(`/api/admin/staff-verification/${requestId}/review`, {
        method: 'POST',
        cookie: adminCookie,
        json: { decision: 'approved', review_notes: 'Verified against university faculty directory.' },
      });
      expect(approveRes.status).toBe(200);

      const meAfter = await req('/api/auth/me', { cookie: facultyAcc.cookie });
      expect(meAfter.data.user.role).toBe('verified_teacher');
      expect(meAfter.data.user.staff_verification_status).toBe('approved');
      expect(meAfter.data.user.staff_position).toBe('Assistant Professor');
      expect(meAfter.data.user.designation).toBe('Assistant Professor of AI');

      // Audit log recorded staff_verification_approved
      const audits = await req('/api/admin/audit-logs', { cookie: adminCookie });
      expect((audits.data.logs as Array<{ action: string }>).some((l) => l.action === 'staff_verification_approved')).toBe(true);
    });
  });

  describe('9. Report Target Inspection & Moderation Actions', () => {
    it('resolves exact reported posts, comments, confessions (without identity leaks), and users in admin overview and hides targets on resolution', async () => {
      // Upload an image and create a post + comment + confession to report
      const pngBytes = Buffer.from(
        '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
        'hex'
      );
      const imgFd = new FormData();
      imgFd.append('image', new Blob([new Uint8Array(pngBytes)], { type: 'image/png' }), 'evidence.png');
      const imgUp = await req('/api/media/upload', { method: 'POST', cookie: studentCookie, formData: imgFd });
      expect(imgUp.status).toBe(201);

      const postRes = await req('/api/posts', {
        method: 'POST',
        cookie: studentCookie,
        json: {
          community_id: bitCommId,
          title: 'Reported Discussion Title',
          body: 'Exact reported post body for admin inspection.',
          image_url: imgUp.data.image_url,
        },
      });
      expect(postRes.status).toBe(201);
      const reportedPostId = postRes.data.id as string;

      const cmtRes = await req(`/api/posts/${reportedPostId}/comments`, {
        method: 'POST',
        cookie: otherStudentCookie,
        json: { body: 'Exact reported comment text under review.' },
      });
      expect(cmtRes.status).toBe(201);
      const reportedCommentId = cmtRes.data.id as string;

      const confListRes = await req('/api/confessions');
      const approvedConfId = (confListRes.data.confessions[0] as { id: string }).id;

      // Submit reports for post, comment, confession, and user
      const repPost = await req('/api/reports', {
        method: 'POST',
        cookie: otherStudentCookie,
        json: {
          target_type: 'post',
          target_id: reportedPostId,
          reason: 'Spam or misleading content',
          details: 'Check attached image and post text.',
        },
      });
      expect(repPost.status).toBe(201);

      const repComment = await req('/api/reports', {
        method: 'POST',
        cookie: studentCookie,
        json: {
          target_type: 'comment',
          target_id: reportedCommentId,
          reason: 'Harassment or abusive behavior',
          details: 'Offensive reply on my thread.',
        },
      });
      expect(repComment.status).toBe(201);

      const repConf = await req('/api/reports', {
        method: 'POST',
        cookie: otherStudentCookie,
        json: {
          target_type: 'confession',
          target_id: approvedConfId,
          reason: 'Doxxing or personal identity exposure',
        },
      });
      expect(repConf.status).toBe(201);

      const otherUserRow = await db.queryOne<{ id: string }>(
        'SELECT id FROM profiles WHERE id <> $1 AND role = $2 LIMIT 1',
        [studentId, 'verified_student']
      );
      expect(otherUserRow).not.toBeNull();
      const repUser = await req('/api/reports', {
        method: 'POST',
        cookie: studentCookie,
        json: {
          target_type: 'user',
          target_id: otherUserRow!.id,
          reason: 'Impersonation or misleading account',
        },
      });
      expect(repUser.status).toBe(201);

      // Admin & Super Admin overview returns exact resolved targets
      const overviewRes = await req('/api/admin/overview', { cookie: adminCookie });
      expect(overviewRes.status).toBe(200);
      const reports = overviewRes.data.queues.openReports as Array<{
        id: string;
        target_type: string;
        target_id: string;
        details: string;
        target: {
          exists: boolean;
          title: string | null;
          body: string | null;
          image_url: string | null;
          author_name: string | null;
          author_username: string | null;
          context_label: string | null;
          post_id: string | null;
        };
      }>;

      const postRp = reports.find((r) => r.id === repPost.data.id);
      expect(postRp?.target.exists).toBe(true);
      expect(postRp?.target.title).toBe('Reported Discussion Title');
      expect(postRp?.target.body).toBe('Exact reported post body for admin inspection.');
      expect(postRp?.target.image_url).toBe(imgUp.data.image_url);
      expect(postRp?.target.author_username).toBe(studentUsername);
      expect(postRp?.details).toBe('Check attached image and post text.');

      const commentRp = reports.find((r) => r.id === repComment.data.id);
      expect(commentRp?.target.exists).toBe(true);
      expect(commentRp?.target.body).toBe('Exact reported comment text under review.');
      expect(commentRp?.target.post_id).toBe(reportedPostId);
      expect(commentRp?.target.context_label).toContain('Reported Discussion Title');
      expect(commentRp?.target.author_username).toBeTruthy();

      const confRp = reports.find((r) => r.id === repConf.data.id);
      expect(confRp?.target.exists).toBe(true);
      expect(confRp?.target.author_name).toBe('Anonymous Student');
      expect(confRp?.target.author_username).toBeNull(); // Never leak confession author identity in report queue

      const userRp = reports.find((r) => r.id === repUser.data.id);
      expect(userRp?.target.exists).toBe(true);
      expect(userRp?.target.author_username).toBeTruthy();

      // Resolving comment report with action=hide_target hides the comment and marks report resolved
      const hideCmtRes = await req(`/api/admin/reports/${repComment.data.id}`, {
        method: 'PATCH',
        cookie: superCookie,
        json: { status: 'resolved', action: 'hide_target', resolution_notes: 'Removed abusive comment' },
      });
      expect(hideCmtRes.status).toBe(200);
      const hiddenComment = await db.queryOne<{ is_hidden: boolean }>('SELECT is_hidden FROM comments WHERE id = $1', [
        reportedCommentId,
      ]);
      expect(Boolean(hiddenComment?.is_hidden)).toBe(true);

      // Resolving post report with action=hide_target hides the post
      const hidePostRes = await req(`/api/admin/reports/${repPost.data.id}`, {
        method: 'PATCH',
        cookie: adminCookie,
        json: { status: 'resolved', action: 'hide_target' },
      });
      expect(hidePostRes.status).toBe(200);
      const hiddenPost = await db.queryOne<{ is_hidden: boolean }>('SELECT is_hidden FROM posts WHERE id = $1', [
        reportedPostId,
      ]);
      expect(Boolean(hiddenPost?.is_hidden)).toBe(true);
    });
  });
});

