import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApp } from '../server/app.ts';
import { initSchema } from '../server/db.ts';
import { checkTextAgainstDictionary, normalizeDictionaryTerm } from '../server/profanity.ts';
import { seedIfEmpty } from '../server/seed.ts';

let server: http.Server;
let baseUrl = '';
let tmpStorageDir = '';
let db: DatabaseSync;

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
    json?: unknown;
    formData?: FormData;
  } = {}
) {
  const headers: Record<string, string> = {};
  if (options.cookie) headers['Cookie'] = options.cookie;
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

async function registerAndVerify(params: {
  email: string;
  username: string;
  display_name: string;
  category: 'university_member' | 'external';
  member_type?: 'student' | 'teacher';
  external_reason?: 'future_student' | 'university_visitor' | 'alumni' | 'other';
  external_reason_detail?: string;
  claim_super_admin?: boolean;
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
      program_id: params.category === 'university_member' ? 'prog-bit' : null,
      semester_id: params.category === 'university_member' && (params.member_type || 'student') === 'student' ? 'prog-bit-sem-1' : null,
      external_reason: params.external_reason ?? null,
      external_reason_detail: params.external_reason_detail ?? null,
      claim_super_admin: params.claim_super_admin ?? false,
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
  return { user: ver.data.user, cookie: ver.cookie };
}

describe('GandakiHub Full-Stack Integration & Security Suite', () => {
  let superCookie = '';
  let adminCookie = '';
  let modCookie = '';
  let studentCookie = '';
  let studentId = '';
  let otherStudentCookie = '';
  let visitorCookie = '';
  let futureCookie = '';

  beforeAll(async () => {
    tmpStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-test-storage-'));
    process.env.PRIVATE_STORAGE_DIR = tmpStorageDir;
    process.env.NODE_ENV = 'test';
    delete process.env.SUPER_ADMIN_EMAIL;

    db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    initSchema(db);
    seedIfEmpty(db);

    const app = createApiApp(db);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpStorageDir, { recursive: true, force: true });
  });

  describe('0. Clean Initial State (No Demo Data)', () => {
    it('starts with structural academic seed only and zero demo users, posts, or files', async () => {
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

      const bootstrap = await req('/api/auth/bootstrap-status');
      expect(bootstrap.status).toBe(200);
      expect(bootstrap.data.needsSuperAdmin).toBe(true);
    });
  });

  describe('1. Authentication, Super Admin Bootstrap & Registration', () => {
    it('bootstraps the first verified Super Admin once and prevents subsequent claims', async () => {
      const superAcc = await registerAndVerify({
        email: 'owner@gandakiuniversity.edu.np',
        username: 'platform_owner',
        display_name: 'Platform Owner',
        category: 'university_member',
        member_type: 'student',
        claim_super_admin: true,
      });
      expect(superAcc.user.role).toBe('super_admin');
      superCookie = superAcc.cookie;

      const bootstrapAfter = await req('/api/auth/bootstrap-status');
      expect(bootstrapAfter.data.needsSuperAdmin).toBe(false);

      const blockedPlatformAdmin = await req('/api/auth/register', {
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
      expect(blockedPlatformAdmin.status).toBe(403);

      // Subsequent attempt to claim super_admin must NOT grant super_admin
      const secondAcc = await registerAndVerify({
        email: 'admin_candidate@gandakiuniversity.edu.np',
        username: 'campus_admin',
        display_name: 'Campus Admin',
        category: 'university_member',
        member_type: 'teacher',
        claim_super_admin: true,
      });
      expect(secondAcc.user.role).toBe('verified_teacher');
      adminCookie = secondAcc.cookie;

      // Super Admin promotes admin_candidate to admin
      const promoteAdmin = await req(`/api/admin/users/${secondAcc.user.id}/role`, {
        method: 'PATCH',
        cookie: superCookie,
        json: { role: 'admin' },
      });
      expect(promoteAdmin.status).toBe(200);

      // Register moderator & students
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

    it('registers university member, verifies 6-digit OTP, and prevents duplicate email', async () => {
      const reg = await req('/api/auth/register', {
        method: 'POST',
        json: {
          email: 'anita@gandakiuniversity.edu.np',
          password: 'Password123',
          username: 'anita_bit',
          display_name: 'Anita Gurung',
          category: 'university_member',
          member_type: 'student',
          program_id: 'prog-bit',
          semester_id: 'prog-bit-sem-1',
        },
      });
      expect(reg.status).toBe(201);
      expect(reg.data.devOtpPreview).toMatch(/^\d{6}$/);

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
      const meBearer = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${verify.data.sessionToken}` },
      });
      const meJson = (await meBearer.json()) as { user: { id: string } | null };
      expect(meJson.user?.id).toBe(studentId);

      // Verify HTTPS proxy sets SameSite=None; Secure for cross-site iframes
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

  describe('2. RBAC Permissions & Academic Structure', () => {
    it('prevents students from modifying official subjects while allowing admins to rename and create folders', async () => {
      const deny = await req('/api/academic/subjects/prog-bit-sem-1-subj-1', {
        method: 'PATCH',
        cookie: studentCookie,
        json: { name: 'Hacked Subject' },
      });
      expect(deny.status).toBe(403);

      const ok = await req('/api/academic/subjects/prog-bit-sem-1-subj-1', {
        method: 'PATCH',
        cookie: adminCookie,
        json: { name: 'Data Science' },
      });
      expect(ok.status).toBe(200);

      const folder = await req('/api/academic/folders', {
        method: 'POST',
        cookie: adminCookie,
        json: { subject_id: 'prog-bit-sem-1-subj-1', name: 'Unit 3 — Regression Models' },
      });
      expect(folder.status).toBe(201);
    });

    it('restricts visitors to read-only and limits future students to Future Students community', async () => {
      const visPost = await req('/api/posts', {
        method: 'POST',
        cookie: visitorCookie,
        json: { community_id: 'comm-future-students', title: 'Visitor attempt', body: 'Should fail' },
      });
      expect(visPost.status).toBe(403);

      const futBit = await req('/api/posts', {
        method: 'POST',
        cookie: futureCookie,
        json: { community_id: 'comm-bit', title: 'Future student in BIT', body: 'Should fail' },
      });
      expect(futBit.status).toBe(403);

      const futOk = await req('/api/posts', {
        method: 'POST',
        cookie: futureCookie,
        json: { community_id: 'comm-future-students', title: 'Entrance Date Query', body: 'When do BIT admissions open?' },
      });
      expect(futOk.status).toBe(201);
    });
  });

  describe('3. PDF Upload Security & Revision Workflow', () => {
    it('rejects renamed non-PDF files (DOCX/ZIP magic bytes) and accepts genuine PDFs for review', async () => {
      const fakeFd = new FormData();
      fakeFd.append('title', 'Fake Renamed Docx');
      fakeFd.append('description', 'Attempt to upload PKZIP renamed as .pdf');
      fakeFd.append('program_id', 'prog-bit');
      fakeFd.append('semester_id', 'prog-bit-sem-1');
      fakeFd.append('subject_id', 'prog-bit-sem-1-subj-1');
      fakeFd.append('category_id', 'cat-notes');
      fakeFd.append('academic_year', '2026');
      fakeFd.append('file', new Blob([Buffer.from('504b030414000600', 'hex')], { type: 'application/pdf' }), 'notes.pdf');

      const fakeRes = await req('/api/academic/resources', {
        method: 'POST',
        cookie: studentCookie,
        formData: fakeFd,
      });
      expect(fakeRes.status).toBe(400);

      const pdfBuf = buildSamplePdfBuffer('Data Science — Unit 2 Notes', '2026', ['Linear Algebra & Probability Review']);
      const validFd = new FormData();
      validFd.append('title', 'Data Science — Unit 2 Notes');
      validFd.append('description', 'Verified probability and regression review notes');
      validFd.append('program_id', 'prog-bit');
      validFd.append('semester_id', 'prog-bit-sem-1');
      validFd.append('subject_id', 'prog-bit-sem-1-subj-1');
      validFd.append('category_id', 'cat-notes');
      validFd.append('academic_year', '2026');
      validFd.append('file', new Blob([new Uint8Array(pdfBuf)], { type: 'application/pdf' }), 'unit2.pdf');

      const okRes = await req('/api/academic/resources', {
        method: 'POST',
        cookie: studentCookie,
        formData: validFd,
      });
      expect(okRes.status).toBe(201);
      expect(okRes.data.status).toBe('pending');

      const unauthDl = await req(`/api/academic/resources/${okRes.data.id}/file`, { cookie: visitorCookie });
      expect(unauthDl.status).toBe(403);

      const approve = await req(`/api/academic/resources/${okRes.data.id}/review`, {
        method: 'POST',
        cookie: modCookie,
        json: { decision: 'approved', review_notes: 'Clean notes' },
      });
      expect(approve.status).toBe(200);

      const editDeny = await req(`/api/academic/resources/${okRes.data.id}`, {
        method: 'PUT',
        cookie: otherStudentCookie,
        json: { title: 'Tampered Title' },
      });
      expect(editDeny.status).toBe(403);
    });
  });

  describe('4. Universal Search & Privacy Filtering', () => {
    it('finds renamed Data Science subject and excludes private complaints', async () => {
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

      const searchPrivate = await req('/api/search?q=Secret+Private+Timetable');
      expect(searchPrivate.status).toBe(200);
      expect(searchPrivate.data.results.length).toBe(0);

      const trending = await req('/api/trending?window=day');
      expect(trending.status).toBe(200);
      expect(Array.isArray(trending.data.trending_searches)).toBe(true);
    });
  });

  describe('5. Connections, Confessions Vault & Profanity Filter', () => {
    it('prevents self connection requests and isolates confession identity vault to Super Admin only', async () => {
      const selfReq = await req('/api/connections/request', {
        method: 'POST',
        cookie: studentCookie,
        json: { receiver_id: studentId },
      });
      expect(selfReq.status).toBe(400);

      // Submit a confession and approve via moderator
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

      // Public confessions endpoint never returns author_id
      const confList = await req('/api/confessions');
      expect(confList.status).toBe(200);
      expect(confList.data.confessions.length).toBe(1);
      expect(confList.data.confessions[0].author_id).toBeUndefined();

      // Regular admin cannot access identity vault
      const adminVault = await req(`/api/confessions/${confId}/identity-lookup`, {
        method: 'POST',
        cookie: adminCookie,
        json: { reason: 'Regular admin trying to view identity' },
      });
      expect(adminVault.status).toBe(403);

      // Super Admin can access with mandatory audit log
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

  describe('6. Admin Provisioning, Connection Privacy, Hierarchy Editing & Image/Text Posts', () => {
    it('hides super_admin and admin from people directory, search, and connection requests', async () => {
      const ppl = await req('/api/people', { cookie: studentCookie });
      expect(ppl.status).toBe(200);
      const roles = (ppl.data.people as Array<{ role: string }>).map((p) => p.role);
      expect(roles).not.toContain('admin');
      expect(roles).not.toContain('super_admin');

      const searchAdmin = await req('/api/search?q=Platform+Owner&type=user');
      expect(searchAdmin.status).toBe(200);
      expect(searchAdmin.data.results.length).toBe(0);

      const sugAdmin = await req('/api/search/suggestions?q=campus_admin');
      expect(sugAdmin.status).toBe(200);
      expect(sugAdmin.data.suggestions.length).toBe(0);

      // Find super_admin id directly from DB to verify connection request is blocked
      const superRow = db.prepare("SELECT id FROM users WHERE role = 'super_admin' LIMIT 1").get() as { id: string };
      const connTry = await req('/api/connections/request', {
        method: 'POST',
        cookie: studentCookie,
        json: { receiver_id: superRow.id },
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

      // Newly created admin is also excluded from /api/people
      const pplAfter = await req('/api/people', { cookie: studentCookie });
      expect((pplAfter.data.people as Array<{ username: string }>).some((p) => p.username === 'bit_dept_admin')).toBe(false);
    });

    it('lets admin and super_admin edit program, semester, subject, topic folder, category, and community names', async () => {
      const progEdit = await req('/api/academic/programs/prog-bit', {
        method: 'PATCH',
        cookie: adminCookie,
        json: { name: 'Bachelor of Information Technology (Honours)' },
      });
      expect(progEdit.status).toBe(200);

      const semEdit = await req('/api/academic/semesters/prog-bit-sem-1', {
        method: 'PATCH',
        cookie: adminCookie,
        json: { name: 'Semester I — Foundation' },
      });
      expect(semEdit.status).toBe(200);

      const folderCreate = await req('/api/academic/folders', {
        method: 'POST',
        cookie: superCookie,
        json: { subject_id: 'prog-bit-sem-1-subj-1', name: 'Original Topic' },
      });
      expect(folderCreate.status).toBe(201);

      const folderRename = await req(`/api/academic/folders/${folderCreate.data.id}`, {
        method: 'PATCH',
        cookie: adminCookie,
        json: { name: 'Linear Regression & Probability' },
      });
      expect(folderRename.status).toBe(200);

      const catRename = await req('/api/academic/categories/cat-general-discussion', {
        method: 'PATCH',
        cookie: adminCookie,
        json: { name: 'Subject Discussion' },
      });
      expect(catRename.status).toBe(200);

      const commRename = await req('/api/communities/comm-bit', {
        method: 'PATCH',
        cookie: superCookie,
        json: { name: 'BIT Commons & Discussions' },
      });
      expect(commRename.status).toBe(200);

      const struct = await req('/api/academic/structure');
      expect((struct.data.programs as Array<{ id: string; name: string }>).find((p) => p.id === 'prog-bit')?.name).toBe(
        'Bachelor of Information Technology (Honours)'
      );
      expect((struct.data.semesters as Array<{ id: string; name: string }>).find((s) => s.id === 'prog-bit-sem-1')?.name).toBe(
        'Semester I — Foundation'
      );
      expect((struct.data.folders as Array<{ id: string; name: string }>).find((f) => f.id === folderCreate.data.id)?.name).toBe(
        'Linear Regression & Probability'
      );
      expect((struct.data.categories as Array<{ id: string; name: string }>).find((c) => c.id === 'cat-general-discussion')?.name).toBe(
        'Subject Discussion'
      );
    });

    it('supports image upload and posting with text-only, image-only, or both across discussions and special channels', async () => {
      // Minimal valid 1x1 PNG buffer
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

      // Verify uploaded image is served
      const imgFetch = await fetch(`${baseUrl}${uploadRes.data.image_url}`);
      expect(imgFetch.status).toBe(200);
      expect(imgFetch.headers.get('content-type')).toContain('image/png');

      // 1) Image-only post in General Discussion / community
      const imgOnlyPost = await req('/api/posts', {
        method: 'POST',
        cookie: studentCookie,
        json: {
          community_id: 'comm-bit',
          subject_id: 'prog-bit-sem-1-subj-1',
          program_id: 'prog-bit',
          image_url: uploadRes.data.image_url,
        },
      });
      expect(imgOnlyPost.status).toBe(201);

      // 2) Text-only post
      const textOnlyPost = await req('/api/posts', {
        method: 'POST',
        cookie: studentCookie,
        json: {
          community_id: 'comm-bit',
          subject_id: 'prog-bit-sem-1-subj-1',
          program_id: 'prog-bit',
          title: 'Midterm Syllabus Question',
          body: 'Are chapters 1 to 4 included?',
        },
      });
      expect(textOnlyPost.status).toBe(201);

      // 3) Image + text post
      const bothPost = await req('/api/posts', {
        method: 'POST',
        cookie: studentCookie,
        json: {
          community_id: 'comm-bit',
          subject_id: 'prog-bit-sem-1-subj-1',
          program_id: 'prog-bit',
          title: 'Whiteboard Photo + Summary',
          body: 'Today lecture notes photo attached.',
          image_url: uploadRes.data.image_url,
        },
      });
      expect(bothPost.status).toBe(201);

      const anonFeed = await req('/api/posts?subject_id=prog-bit-sem-1-subj-1');
      expect(anonFeed.status).toBe(200);
      expect(anonFeed.data.posts.length).toBe(0);

      const subjFeed = await req('/api/posts?subject_id=prog-bit-sem-1-subj-1', { cookie: studentCookie });
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
        json: { community_id: 'comm-bit' },
      });
      expect(emptyPost.status).toBe(400);
    });
  });
});

