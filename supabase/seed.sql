-- GandakiHub Structural Seed SQL (Idempotent, Zero Demo Users or Content)
-- Initializes only academic hierarchy (5 programs, 40 semesters, 200 subjects),
-- 7 resource categories, 16 core/program communities, platform settings,
-- baseline multilingual profanity dictionary, and search suggestions.

INSERT INTO platform_settings (key, value) VALUES
  ('max_upload_mb', '10'),
  ('require_resource_review', 'true')
ON CONFLICT (key) DO NOTHING;

INSERT INTO resource_categories (slug, name, description, pdf_only, sort_order) VALUES
  ('notes', 'Notes', 'Lecture notes and unit summaries (PDF only).', TRUE, 1),
  ('past-questions', 'Past Questions', 'Previous semester and final examination papers (PDF only).', TRUE, 2),
  ('projects', 'Projects', 'Student project reports and documentation (PDF only).', TRUE, 3),
  ('assignments', 'Assignments', 'Coursework guidelines and reference assignments (PDF).', TRUE, 4),
  ('exam-prep', 'Exam Preparation', 'Revision sheets, formula guides, and model sets (PDF).', TRUE, 5),
  ('general-discussion', 'General Discussion', 'Subject syllabus discussions and Q&A.', FALSE, 6),
  ('resources', 'Resources', 'Reference syllabi, reading lists, and lab manuals (PDF).', TRUE, 7)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO programs (code, name, description, sort_order) VALUES
  ('BIT', 'Bachelor of Information Technology', 'Undergraduate IT curriculum covering programming, databases, networks, and data systems.', 1),
  ('BALLB', 'Bachelor of Arts Bachelor of Laws', 'Integrated five-year arts and legal studies program.', 2),
  ('BBA', 'Bachelor of Business Administration', 'Management, finance, accounting, and organizational leadership program.', 3),
  ('B.Pharm', 'Bachelor of Pharmacy', 'Pharmaceutical sciences, pharmacology, and clinical pharmacy curriculum.', 4),
  ('BSM', 'Bachelor of Sports Management', 'Sports administration, kinesiology, event management, and coaching studies.', 5)
ON CONFLICT (code) DO NOTHING;

DO $$
DECLARE
  p RECORD;
  s_names TEXT[] := ARRAY[
    'First Semester',
    'Second Semester',
    'Third Semester',
    'Fourth Semester',
    'Fifth Semester',
    'Sixth Semester',
    'Seventh Semester',
    'Eighth Semester'
  ];
  sem_id UUID;
  prog_slug TEXT;
  subj_cnt INT;
  i INT;
  j INT;
BEGIN
  FOR p IN SELECT id, code, name, description FROM programs LOOP
    prog_slug := lower(regexp_replace(p.code, '[^a-zA-Z0-9]', '', 'g'));

    INSERT INTO communities (slug, name, description, kind, visibility, rules, program_id)
    VALUES (
      prog_slug,
      p.code || ' Community',
      'Academic discussions, course coordination, and updates for ' || p.name || '.',
      'academic',
      'university_only',
      'Academic integrity applies. Respect peers and faculty.',
      p.id
    )
    ON CONFLICT (slug) DO NOTHING;

    FOR i IN 1..8 LOOP
      INSERT INTO semesters (program_id, number, name, sort_order)
      VALUES (p.id, i, s_names[i], i)
      ON CONFLICT (program_id, number) DO NOTHING;

      SELECT id INTO sem_id FROM semesters WHERE program_id = p.id AND number = i LIMIT 1;

      SELECT COUNT(*) INTO subj_cnt FROM subjects WHERE semester_id = sem_id;
      IF subj_cnt = 0 THEN
        FOR j IN 1..5 LOOP
          INSERT INTO subjects (program_id, semester_id, code, name, description, sort_order)
          VALUES (
            p.id,
            sem_id,
            p.code || '-' || i || '0' || j,
            'Subject ' || j,
            'Initial subject slot ' || j || ' for ' || p.code || ' ' || s_names[i] || '.',
            j
          );
        END LOOP;
      END IF;
    END LOOP;
  END LOOP;
END $$;

INSERT INTO communities (slug, name, description, kind, visibility, rules) VALUES
  ('confessions', 'Confessions', 'Anonymous moderated campus reflections and confessions.', 'special', 'public', 'No names, harassment, hate speech, or doxxing. All submissions undergo moderator review.'),
  ('complaints-suggestions', 'Complaints & Suggestions', 'Structured public and private feedback channels for campus improvement.', 'special', 'public', 'Provide constructive, specific details. Private complaints are visible only to assigned handlers.'),
  ('getideas', 'GetIdeas', 'Student innovation, campus software proposals, and collaborator matching.', 'special', 'public', 'Describe the problem clearly and state what kind of collaborators you need.'),
  ('student-donations', 'Student Donations', 'Moderated peer-assistance requests for textbooks, equipment, and urgent student support.', 'special', 'public', 'Moderators verify requests before publishing. Do not post private medical or banking IDs.'),
  ('random', 'Random', 'Campus life, Pokhara recommendations, photography, and casual conversations.', 'special', 'public', 'Keep discussions respectful and welcoming.'),
  ('future-students', 'Future Students', 'Admissions Q&A, entrance preparation, and campus guidance for prospective applicants.', 'special', 'public', 'Prospective students can ask questions here; verified students and teachers provide guidance.'),
  ('alumni', 'Alumni', 'Graduate network, career transitions, and alumni mentorship.', 'special', 'public', 'Share mentorship advice and industry insights.'),
  ('internship-opportunities', 'Internship & Opportunities', 'Internships, fellowships, scholarships, competitions, and research calls.', 'special', 'public', 'Include accurate eligibility criteria and application deadlines.'),
  ('events-announcements', 'Events & Announcements', 'Seminars, workshops, hackathons, and student notices.', 'special', 'public', 'Verify event dates and locations before posting.'),
  ('lost-found', 'Lost & Found', 'Report misplaced ID cards, textbooks, calculators, or found items on campus.', 'special', 'public', 'Do not post sensitive personal contact numbers publicly; coordinate safely.'),
  ('study-groups', 'Study Groups', 'Peer study circles organized by program, semester, and exam schedule.', 'special', 'university_only', 'Only verified university members may join academic study circles.')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO profanity_dictionary (term, normalized_term, language, severity, context_exception_note) VALUES
  ('idiot', 'idiot', 'en', 'low', 'Flag for review in personal attack contexts'),
  ('bastard', 'bastard', 'en', 'medium', NULL),
  ('fuck', 'fuck', 'en', 'high', NULL),
  ('shithead', 'shithead', 'en', 'high', NULL),
  ('kill yourself', 'kill yourself', 'en', 'high', NULL),
  ('machikne', 'machikne', 'ne_romanized', 'high', NULL),
  ('muji', 'muji', 'ne_romanized', 'high', NULL),
  ('randi', 'randi', 'ne_romanized', 'high', NULL),
  ('kutta', 'kutta', 'ne_romanized', 'medium', NULL),
  ('gadha', 'gadha', 'ne_romanized', 'low', NULL),
  ('माचिक्ने', 'माचिक्ने', 'ne_devanagari', 'high', NULL),
  ('मुजी', 'मुजी', 'ne_devanagari', 'high', NULL),
  ('रन्डी', 'रन्डी', 'ne_devanagari', 'high', NULL),
  ('कुकुर', 'कुकुर', 'ne_devanagari', 'low', 'Context-checked: may appear in veterinary/biology text')
ON CONFLICT (term) DO NOTHING;

INSERT INTO search_suggestions (term, category_group, link_path, weight) VALUES
  ('BIT', 'Programs', '/academic', 10),
  ('BALLB', 'Programs', '/academic', 9),
  ('BBA', 'Programs', '/academic', 8),
  ('B.Pharm', 'Programs', '/academic', 7),
  ('BSM', 'Programs', '/academic', 6),
  ('Past Questions', 'Categories', '/academic', 5)
ON CONFLICT (term) DO NOTHING;
