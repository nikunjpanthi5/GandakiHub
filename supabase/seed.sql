-- GandakiHub Supabase Seed Data (Programs, Semesters, 5 Placeholder Subjects, Categories, Special Communities)

INSERT INTO resource_categories (slug, name, description, pdf_only, sort_order) VALUES
  ('notes', 'Notes', 'Lecture notes and unit summaries (PDF only)', TRUE, 1),
  ('past-questions', 'Past Questions', 'Previous exam papers (PDF only)', TRUE, 2),
  ('projects', 'Projects', 'Project reports and documentation (PDF only)', TRUE, 3),
  ('assignments', 'Assignments', 'Coursework and assignments (PDF)', TRUE, 4),
  ('exam-prep', 'Exam Preparation', 'Revision guides and model sets (PDF)', TRUE, 5),
  ('general-discussion', 'General Discussion', 'Course discussion and Q&A', FALSE, 6),
  ('resources', 'Resources', 'Reference syllabi and lab manuals (PDF)', TRUE, 7)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO programs (code, name, description, sort_order) VALUES
  ('BIT', 'Bachelor of Information Technology', 'Undergraduate IT curriculum.', 1),
  ('BALLB', 'Bachelor of Arts Bachelor of Laws', 'Integrated arts and legal studies program.', 2),
  ('BBA', 'Bachelor of Business Administration', 'Management and business administration.', 3),
  ('B.Pharm', 'Bachelor of Pharmacy', 'Pharmaceutical sciences curriculum.', 4),
  ('BSM', 'Bachelor of Sports Management', 'Sports administration and coaching studies.', 5)
ON CONFLICT (code) DO NOTHING;

DO $$
DECLARE
  p RECORD;
  s_names TEXT[] := ARRAY['First Semester','Second Semester','Third Semester','Fourth Semester','Fifth Semester','Sixth Semester','Seventh Semester','Eighth Semester'];
  sem_id UUID;
  i INT;
  j INT;
BEGIN
  FOR p IN SELECT id, code FROM programs LOOP
    FOR i IN 1..8 LOOP
      INSERT INTO semesters (program_id, number, name, sort_order)
      VALUES (p.id, i, s_names[i], i)
      ON CONFLICT (program_id, number) DO NOTHING
      RETURNING id INTO sem_id;

      IF sem_id IS NOT NULL THEN
        FOR j IN 1..5 LOOP
          INSERT INTO subjects (program_id, semester_id, code, name, description, sort_order)
          VALUES (p.id, sem_id, p.code || '-' || i || '0' || j, 'Subject ' || j, 'Initial demonstration subject slot ' || j, j);
        END LOOP;
      END IF;
    END LOOP;
  END LOOP;
END $$;

INSERT INTO communities (slug, name, description, kind, visibility) VALUES
  ('confessions', 'Confessions', 'Anonymous moderated campus reflections.', 'special', 'public'),
  ('complaints-suggestions', 'Complaints & Suggestions', 'Public and private feedback channels.', 'special', 'public'),
  ('getideas', 'GetIdeas', 'Student innovation and collaborator matching.', 'special', 'public'),
  ('student-donations', 'Student Donations', 'Moderated peer-assistance requests.', 'special', 'public'),
  ('random', 'Random', 'Campus life and casual discussions.', 'special', 'public'),
  ('future-students', 'Future Students', 'Admissions Q&A for prospective applicants.', 'special', 'public'),
  ('alumni', 'Alumni', 'Graduate network and career mentorship.', 'special', 'public'),
  ('internship-opportunities', 'Internship & Opportunities', 'Internships, jobs, and scholarships.', 'special', 'public'),
  ('events-announcements', 'Events & Announcements', 'Campus events, seminars, and notices.', 'special', 'public'),
  ('lost-found', 'Lost & Found', 'Lost and found items on campus.', 'special', 'public'),
  ('study-groups', 'Study Groups', 'Peer study circles by program and semester.', 'special', 'university_only')
ON CONFLICT (slug) DO NOTHING;
