import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { indexSearchEntity } from './db.ts';
import { normalizeDictionaryTerm } from './profanity.ts';

const SEMESTERS = [
  'First Semester',
  'Second Semester',
  'Third Semester',
  'Fourth Semester',
  'Fifth Semester',
  'Sixth Semester',
  'Seventh Semester',
  'Eighth Semester',
];

const PROGRAMS = [
  {
    id: 'prog-bit',
    code: 'BIT',
    name: 'Bachelor of Information Technology',
    description: 'Undergraduate IT curriculum covering programming, databases, networks, and data systems.',
  },
  {
    id: 'prog-ballb',
    code: 'BALLB',
    name: 'Bachelor of Arts Bachelor of Laws',
    description: 'Integrated five-year arts and legal studies program.',
  },
  {
    id: 'prog-bba',
    code: 'BBA',
    name: 'Bachelor of Business Administration',
    description: 'Management, finance, accounting, and organizational leadership program.',
  },
  {
    id: 'prog-bpharm',
    code: 'B.Pharm',
    name: 'Bachelor of Pharmacy',
    description: 'Pharmaceutical sciences, pharmacology, and clinical pharmacy curriculum.',
  },
  {
    id: 'prog-bsm',
    code: 'BSM',
    name: 'Bachelor of Sports Management',
    description: 'Sports administration, kinesiology, event management, and coaching studies.',
  },
];

const CATEGORIES = [
  { id: 'cat-notes', slug: 'notes', name: 'Notes', description: 'Lecture notes and unit summaries (PDF only).', pdf_only: 1, sort_order: 1 },
  { id: 'cat-past-questions', slug: 'past-questions', name: 'Past Questions', description: 'Previous semester and final examination papers (PDF only).', pdf_only: 1, sort_order: 2 },
  { id: 'cat-projects', slug: 'projects', name: 'Projects', description: 'Student project reports and documentation (PDF only).', pdf_only: 1, sort_order: 3 },
  { id: 'cat-assignments', slug: 'assignments', name: 'Assignments', description: 'Coursework guidelines and reference assignments (PDF).', pdf_only: 1, sort_order: 4 },
  { id: 'cat-exam-prep', slug: 'exam-prep', name: 'Exam Preparation', description: 'Revision sheets, formula guides, and model sets (PDF).', pdf_only: 1, sort_order: 5 },
  { id: 'cat-general-discussion', slug: 'general-discussion', name: 'General Discussion', description: 'Subject syllabus discussions and Q&A.', pdf_only: 0, sort_order: 6 },
  { id: 'cat-resources', slug: 'resources', name: 'Resources', description: 'Reference syllabi, reading lists, and lab manuals (PDF).', pdf_only: 1, sort_order: 7 },
];

const SPECIAL_COMMUNITIES = [
  { slug: 'confessions', name: 'Confessions', description: 'Anonymous moderated campus reflections and confessions.', visibility: 'public', rules: 'No names, harassment, hate speech, or doxxing. All submissions undergo moderator review.' },
  { slug: 'complaints-suggestions', name: 'Complaints & Suggestions', description: 'Structured public and private feedback channels for campus improvement.', visibility: 'public', rules: 'Provide constructive, specific details. Private complaints are visible only to assigned handlers.' },
  { slug: 'getideas', name: 'GetIdeas', description: 'Student innovation, campus software proposals, and collaborator matching.', visibility: 'public', rules: 'Describe the problem clearly and state what kind of collaborators you need.' },
  { slug: 'student-donations', name: 'Student Donations', description: 'Moderated peer-assistance requests for textbooks, equipment, and urgent student support.', visibility: 'public', rules: 'Moderators verify requests before publishing. Do not post private medical or banking IDs.' },
  { slug: 'random', name: 'Random', description: 'Campus life, Pokhara recommendations, photography, and casual conversations.', visibility: 'public', rules: 'Keep discussions respectful and welcoming.' },
  { slug: 'future-students', name: 'Future Students', description: 'Admissions Q&A, entrance preparation, and campus guidance for prospective applicants.', visibility: 'public', rules: 'Prospective students can ask questions here; verified students and teachers provide guidance.' },
  { slug: 'alumni', name: 'Alumni', description: 'Graduate network, career transitions, and alumni mentorship.', visibility: 'public', rules: 'Share mentorship advice and industry insights.' },
  { slug: 'internship-opportunities', name: 'Internship & Opportunities', description: 'Internships, fellowships, scholarships, competitions, and research calls.', visibility: 'public', rules: 'Include accurate eligibility criteria and application deadlines.' },
  { slug: 'events-announcements', name: 'Events & Announcements', description: 'Seminars, workshops, hackathons, and student notices.', visibility: 'public', rules: 'Verify event dates and locations before posting.' },
  { slug: 'lost-found', name: 'Lost & Found', description: 'Report misplaced ID cards, textbooks, calculators, or found items on campus.', visibility: 'public', rules: 'Do not post sensitive personal contact numbers publicly; coordinate safely.' },
  { slug: 'study-groups', name: 'Study Groups', description: 'Peer study circles organized by program, semester, and exam schedule.', visibility: 'university_only', rules: 'Only verified university members may join academic study circles.' },
];

/**
 * Seeds ONLY the structural academic hierarchy, categories, special communities,
 * platform settings, and baseline profanity dictionary.
 * Leaves all user-generated content (users, posts, PDFs, confessions, complaints,
 * ideas, events, opportunities, connections, search trends) completely blank.
 */
export function seedIfEmpty(db: DatabaseSync): void {
  const existing = db.prepare('SELECT COUNT(*) as cnt FROM programs').get() as { cnt: number };
  if (existing.cnt > 0) return;

  const now = new Date().toISOString();

  db.exec('BEGIN');
  try {
    db.prepare('INSERT OR IGNORE INTO platform_settings (key, value) VALUES (?, ?)').run('max_upload_mb', '10');
    db.prepare('INSERT OR IGNORE INTO platform_settings (key, value) VALUES (?, ?)').run('require_resource_review', 'true');

    const insertCat = db.prepare(
      'INSERT INTO resource_categories (id, slug, name, description, pdf_only, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (const c of CATEGORIES) {
      insertCat.run(c.id, c.slug, c.name, c.description, c.pdf_only, c.sort_order);
    }

    const insertProg = db.prepare(
      'INSERT INTO programs (id, code, name, description, sort_order, is_archived, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)'
    );
    const insertSem = db.prepare(
      'INSERT INTO semesters (id, program_id, number, name, sort_order, is_archived, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)'
    );
    const insertSubj = db.prepare(
      'INSERT INTO subjects (id, program_id, semester_id, code, name, description, sort_order, is_archived, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)'
    );
    const insertComm = db.prepare(
      'INSERT INTO communities (id, slug, name, description, kind, visibility, rules, program_id, is_archived, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)'
    );

    PROGRAMS.forEach((p, pIdx) => {
      insertProg.run(p.id, p.code, p.name, p.description, pIdx + 1, now);
      indexSearchEntity(db, 'program', p.id, `${p.code} — ${p.name}`, p.description, p.code);

      const progCommId = `comm-${p.code.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
      insertComm.run(
        progCommId,
        p.code.toLowerCase().replace(/[^a-z0-9]/g, ''),
        `${p.code} Community`,
        `Academic discussions, course coordination, and updates for ${p.name}.`,
        'academic',
        'university_only',
        'Academic integrity applies. Respect peers and faculty.',
        p.id,
        now
      );
      indexSearchEntity(db, 'community', progCommId, `${p.code} Community`, p.description, 'academic');

      SEMESTERS.forEach((semName, sIdx) => {
        const semNum = sIdx + 1;
        const semId = `${p.id}-sem-${semNum}`;
        insertSem.run(semId, p.id, semNum, semName, semNum, now);

        for (let subjIdx = 1; subjIdx <= 5; subjIdx++) {
          const subjId = `${semId}-subj-${subjIdx}`;
          const subjName = `Subject ${subjIdx}`;
          const subjDesc = `Initial subject slot ${subjIdx} for ${p.code} ${semName}.`;
          insertSubj.run(
            subjId,
            p.id,
            semId,
            `${p.code}-${semNum}0${subjIdx}`,
            subjName,
            subjDesc,
            subjIdx,
            now
          );
          indexSearchEntity(
            db,
            'subject',
            subjId,
            `${subjName} (${p.code} · ${semName})`,
            subjDesc,
            `${p.code} ${semName}`
          );
        }
      });
    });

    for (const sc of SPECIAL_COMMUNITIES) {
      const cId = `comm-${sc.slug}`;
      insertComm.run(cId, sc.slug, sc.name, sc.description, 'special', sc.visibility, sc.rules, null, now);
      indexSearchEntity(db, 'community', cId, sc.name, sc.description, sc.visibility);
    }

    const profanitySeeds: Array<{ term: string; lang: 'en' | 'ne_devanagari' | 'ne_romanized'; sev: 'low' | 'medium' | 'high'; note?: string }> = [
      { term: 'idiot', lang: 'en', sev: 'low', note: 'Flag for review in personal attack contexts' },
      { term: 'bastard', lang: 'en', sev: 'medium' },
      { term: 'fuck', lang: 'en', sev: 'high' },
      { term: 'shithead', lang: 'en', sev: 'high' },
      { term: 'kill yourself', lang: 'en', sev: 'high' },
      { term: 'machikne', lang: 'ne_romanized', sev: 'high' },
      { term: 'muji', lang: 'ne_romanized', sev: 'high' },
      { term: 'randi', lang: 'ne_romanized', sev: 'high' },
      { term: 'kutta', lang: 'ne_romanized', sev: 'medium' },
      { term: 'gadha', lang: 'ne_romanized', sev: 'low' },
      { term: 'माचिक्ने', lang: 'ne_devanagari', sev: 'high' },
      { term: 'मुजी', lang: 'ne_devanagari', sev: 'high' },
      { term: 'रन्डी', lang: 'ne_devanagari', sev: 'high' },
      { term: 'कुकुर', lang: 'ne_devanagari', sev: 'low', note: 'Context-checked: may appear in veterinary/biology text' },
    ];
    const insertProf = db.prepare(
      'INSERT INTO profanity_dictionary (id, term, normalized_term, language, severity, context_exception_note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    for (const ps of profanitySeeds) {
      insertProf.run(crypto.randomUUID(), ps.term, normalizeDictionaryTerm(ps.term), ps.lang, ps.sev, ps.note ?? null, now);
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
