import type { AppDatabase } from './db.ts';
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
    code: 'BIT',
    name: 'Bachelor of Information Technology',
    description: 'Undergraduate IT curriculum covering programming, databases, networks, and data systems.',
  },
  {
    code: 'BALLB',
    name: 'Bachelor of Arts Bachelor of Laws',
    description: 'Integrated five-year arts and legal studies program.',
  },
  {
    code: 'BBA',
    name: 'Bachelor of Business Administration',
    description: 'Management, finance, accounting, and organizational leadership program.',
  },
  {
    code: 'B.Pharm',
    name: 'Bachelor of Pharmacy',
    description: 'Pharmaceutical sciences, pharmacology, and clinical pharmacy curriculum.',
  },
  {
    code: 'BSM',
    name: 'Bachelor of Sports Management',
    description: 'Sports administration, kinesiology, event management, and coaching studies.',
  },
];

const CATEGORIES = [
  { slug: 'notes', name: 'Notes', description: 'Lecture notes and unit summaries (PDF only).', pdf_only: true, sort_order: 1 },
  { slug: 'past-questions', name: 'Past Questions', description: 'Previous semester and final examination papers (PDF only).', pdf_only: true, sort_order: 2 },
  { slug: 'projects', name: 'Projects', description: 'Student project reports and documentation (PDF only).', pdf_only: true, sort_order: 3 },
  { slug: 'assignments', name: 'Assignments', description: 'Coursework guidelines and reference assignments (PDF).', pdf_only: true, sort_order: 4 },
  { slug: 'exam-prep', name: 'Exam Preparation', description: 'Revision sheets, formula guides, and model sets (PDF).', pdf_only: true, sort_order: 5 },
  { slug: 'general-discussion', name: 'General Discussion', description: 'Subject syllabus discussions and Q&A.', pdf_only: false, sort_order: 6 },
  { slug: 'resources', name: 'Resources', description: 'Reference syllabi, reading lists, and lab manuals (PDF).', pdf_only: true, sort_order: 7 },
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
 * Idempotent structural seed ONLY. Runs once at startup when programs table is empty.
 * Never seeds demo users, posts, PDFs, or fake engagement metrics.
 */
export async function seedIfEmpty(db: AppDatabase): Promise<void> {
  const existing = await db.queryOne<{ cnt: string | number }>('SELECT COUNT(*) AS cnt FROM programs');
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
      const progRow = await tx.queryOne<{ id: string }>('SELECT id FROM programs WHERE code = $1', [p.code]);
      if (!progRow) continue;

      const progSlug = p.code.toLowerCase().replace(/[^a-z0-9]/g, '');
      await tx.execute(
        `INSERT INTO communities (slug, name, description, kind, visibility, rules, program_id, is_archived)
         VALUES ($1, $2, $3, 'academic', 'university_only', $4, $5, FALSE)
         ON CONFLICT (slug) DO NOTHING`,
        [
          progSlug,
          `${p.code} Community`,
          `Academic discussions, course coordination, and updates for ${p.name}.`,
          'Academic integrity applies. Respect peers and faculty.',
          progRow.id,
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
        const semRow = await tx.queryOne<{ id: string }>(
          'SELECT id FROM semesters WHERE program_id = $1 AND number = $2',
          [progRow.id, semNum]
        );
        if (!semRow) continue;

        const subjCount = await tx.queryOne<{ cnt: string | number }>(
          'SELECT COUNT(*) AS cnt FROM subjects WHERE semester_id = $1',
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
                subjIdx,
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

    const profanitySeeds: Array<{
      term: string;
      lang: 'en' | 'ne_devanagari' | 'ne_romanized';
      sev: 'low' | 'medium' | 'high';
      note?: string;
    }> = [
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
    for (const ps of profanitySeeds) {
      await tx.execute(
        `INSERT INTO profanity_dictionary (term, normalized_term, language, severity, context_exception_note)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (term) DO NOTHING`,
        [ps.term, normalizeDictionaryTerm(ps.term), ps.lang, ps.sev, ps.note ?? null]
      );
    }

    const suggestions = [
      { term: 'BIT', group: 'Programs', link: '/academic', weight: 10 },
      { term: 'BALLB', group: 'Programs', link: '/academic', weight: 9 },
      { term: 'BBA', group: 'Programs', link: '/academic', weight: 8 },
      { term: 'B.Pharm', group: 'Programs', link: '/academic', weight: 7 },
      { term: 'BSM', group: 'Programs', link: '/academic', weight: 6 },
      { term: 'Past Questions', group: 'Categories', link: '/academic', weight: 5 },
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
