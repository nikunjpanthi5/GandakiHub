export type UserRole =
  | 'super_admin'
  | 'admin'
  | 'community_moderator'
  | 'verified_student'
  | 'verified_teacher'
  | 'future_student'
  | 'alumni'
  | 'visitor';

export type AccountStatus = 'active' | 'suspended' | 'restricted';

export type ExternalReason =
  | 'future_student'
  | 'parent_guardian'
  | 'university_visitor'
  | 'researcher'
  | 'alumni'
  | 'platform_admin'
  | 'other';

export type StaffVerificationStatus = 'not_requested' | 'pending' | 'approved' | 'rejected';

export interface StaffVerificationRequest {
  id: string;
  user_id: string;
  position: string;
  department: string;
  designation: string;
  university_email: string;
  supporting_notes: string;
  has_evidence: boolean;
  evidence_original_filename: string | null;
  status: 'pending' | 'approved' | 'rejected';
  reviewer_id: string | null;
  review_notes: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
  requester_name?: string;
  requester_username?: string;
  requester_email?: string;
  requester_role?: UserRole;
}

export interface PublicProfile {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  bio: string;
  role: UserRole;
  university_email_verified: boolean;
  email_verified: boolean;
  program_id: string | null;
  program_name?: string | null;
  semester_id: string | null;
  semester_name?: string | null;
  department?: string | null;
  student_id?: string | null;
  staff_position?: string | null;
  designation?: string | null;
  interests: string[];
  account_status: AccountStatus;
  created_at: string;
  is_demo?: boolean;
}

export interface AuthUser extends PublicProfile {
  email: string;
  external_reason: ExternalReason | null;
  external_reason_detail: string | null;
  profile_completed: boolean;
  profile_completion_pct: number;
  staff_verification_status: StaffVerificationStatus;
  notification_prefs: {
    replies: boolean;
    connections: boolean;
    resources: boolean;
    events: boolean;
    announcements: boolean;
  };
  privacy_settings: {
    show_program: boolean;
    allow_connection_requests: boolean;
  };
  moderated_community_ids: string[];
}

export interface Program {
  id: string;
  code: string;
  name: string;
  description: string;
  sort_order: number;
  is_archived: boolean;
  semester_count?: number;
}

export interface Semester {
  id: string;
  program_id: string;
  number: number;
  name: string;
  sort_order: number;
  is_archived: boolean;
  subject_count?: number;
}

export interface Subject {
  id: string;
  semester_id: string;
  program_id: string;
  code: string;
  name: string;
  description: string;
  sort_order: number;
  is_archived: boolean;
  resource_count?: number;
}

export interface AcademicFolder {
  id: string;
  subject_id: string;
  parent_folder_id: string | null;
  name: string;
  sort_order: number;
  is_archived: boolean;
}

export interface ResourceCategory {
  id: string;
  slug: string;
  name: string;
  description: string;
  pdf_only: boolean;
  sort_order: number;
}

export type ModerationStatus = 'pending' | 'approved' | 'rejected' | 'changes_requested';

export interface AcademicResource {
  id: string;
  title: string;
  description: string;
  category_id: string;
  category_name: string;
  category_slug: string;
  program_id: string;
  program_code: string;
  program_name: string;
  semester_id: string;
  semester_name: string;
  subject_id: string;
  subject_name: string;
  folder_id: string | null;
  folder_name: string | null;
  academic_year: string;
  uploader_id: string;
  uploader_name: string;
  uploader_username: string;
  uploader_role: UserRole;
  status: ModerationStatus;
  current_revision_id: string | null;
  revision_number: number;
  file_size: number;
  original_filename: string;
  download_count: number;
  upvote_count: number;
  user_vote: number;
  is_bookmarked: boolean;
  has_pending_revision: boolean;
  created_at: string;
  updated_at: string;
  is_demo?: boolean;
}

export interface ResourceRevision {
  id: string;
  resource_id: string;
  revision_number: number;
  original_filename: string;
  file_size: number;
  sha256_hash: string;
  status: ModerationStatus;
  reviewer_id: string | null;
  reviewer_name: string | null;
  review_notes: string | null;
  created_at: string;
}

export type CommunityVisibility = 'public' | 'university_only' | 'private_approval';

export interface Community {
  id: string;
  slug: string;
  name: string;
  description: string;
  kind: 'academic' | 'special';
  visibility: CommunityVisibility;
  rules: string;
  program_id: string | null;
  is_archived: boolean;
  member_count: number;
  recent_posts_count: number;
  is_member: boolean;
  membership_status: 'joined' | 'pending' | 'none';
  is_moderator: boolean;
  created_at: string;
}

export interface PollOption {
  id: string;
  label: string;
  vote_count: number;
  percentage: number;
}

export interface Poll {
  id: string;
  question: string;
  closes_at: string | null;
  total_votes: number;
  user_option_id: string | null;
  options: PollOption[];
}

export interface Post {
  id: string;
  community_id: string;
  community_slug: string;
  community_name: string;
  program_id: string | null;
  program_code: string | null;
  semester_id: string | null;
  semester_name: string | null;
  subject_id: string | null;
  subject_name: string | null;
  author_id: string;
  author_name: string;
  author_username: string;
  author_role: UserRole;
  author_verified: boolean;
  title: string;
  body: string;
  image_url?: string | null;
  flair: string | null;
  tags: string[];
  is_pinned: boolean;
  upvote_count: number;
  downvote_count: number;
  score: number;
  comment_count: number;
  user_vote: number;
  is_bookmarked: boolean;
  poll: Poll | null;
  created_at: string;
  updated_at: string;
  is_demo?: boolean;
}

export interface CommentItem {
  id: string;
  post_id: string;
  parent_comment_id: string | null;
  author_id: string;
  author_name: string;
  author_username: string;
  author_role: UserRole;
  author_verified: boolean;
  body: string;
  upvote_count: number;
  downvote_count: number;
  user_vote: number;
  created_at: string;
  replies?: CommentItem[];
}

export interface Confession {
  id: string;
  title: string;
  body: string;
  image_url?: string | null;
  category: string;
  status: 'pending' | 'approved' | 'rejected';
  reaction_support: number;
  reaction_relate: number;
  comment_count: number;
  created_at: string;
  is_demo?: boolean;
}

export interface Complaint {
  id: string;
  submitter_id: string;
  submitter_name?: string;
  is_private: boolean;
  category: string;
  title: string;
  body: string;
  image_url?: string | null;
  status: 'submitted' | 'under_review' | 'in_progress' | 'resolved' | 'rejected';
  assigned_handler_id: string | null;
  assigned_handler_name: string | null;
  handler_notes: string | null;
  created_at: string;
  updated_at: string;
  is_demo?: boolean;
}

export interface Idea {
  id: string;
  author_id: string;
  author_name: string;
  author_username: string;
  title: string;
  problem_statement: string;
  proposed_solution: string;
  image_url?: string | null;
  collaborators_needed: string;
  status: 'new_idea' | 'under_discussion' | 'looking_for_collaborators' | 'in_progress' | 'completed';
  upvote_count: number;
  follower_count: number;
  user_vote: number;
  is_following: boolean;
  created_at: string;
  is_demo?: boolean;
}

export interface DonationRequest {
  id: string;
  requester_id: string;
  requester_name: string;
  title: string;
  category: string;
  description: string;
  image_url?: string | null;
  contact_method: string;
  status: 'pending' | 'approved' | 'fulfilled' | 'rejected';
  verification_notes: string | null;
  created_at: string;
  is_demo?: boolean;
}

export interface Opportunity {
  id: string;
  author_id: string;
  author_name: string;
  kind: 'internship' | 'job' | 'scholarship' | 'competition' | 'research' | 'workshop';
  title: string;
  organization: string;
  description: string;
  image_url?: string | null;
  eligibility: string;
  deadline: string;
  external_url: string;
  status: 'pending' | 'approved' | 'rejected';
  created_at: string;
  is_demo?: boolean;
}

export interface UniversityEvent {
  id: string;
  author_id: string;
  author_name: string;
  kind: 'event' | 'seminar' | 'announcement';
  title: string;
  location: string;
  starts_at: string;
  ends_at: string | null;
  description: string;
  image_url?: string | null;
  is_official_notice: boolean;
  created_at: string;
  is_demo?: boolean;
}

export interface StudyGroup {
  id: string;
  creator_id: string;
  creator_name: string;
  program_id: string | null;
  program_code: string | null;
  semester_id: string | null;
  subject_id: string | null;
  subject_name: string | null;
  name: string;
  description: string;
  image_url?: string | null;
  schedule_text: string;
  max_members: number;
  member_count: number;
  is_member: boolean;
  created_at: string;
  is_demo?: boolean;
}

export interface NotificationItem {
  id: string;
  kind: string;
  title: string;
  body: string;
  link_path: string;
  is_read: boolean;
  created_at: string;
}

export interface ConnectionSummary {
  connection_id: string;
  peer: PublicProfile;
  created_at: string;
}

export interface ConnectionRequestItem {
  id: string;
  direction: 'incoming' | 'outgoing';
  peer: PublicProfile;
  note: string;
  status: 'pending' | 'accepted' | 'rejected' | 'cancelled';
  created_at: string;
}

export interface TrendingSearch {
  query: string;
  count: number;
  growth_pct: number;
}

export interface SearchResultItem {
  type:
    | 'program'
    | 'semester'
    | 'subject'
    | 'folder'
    | 'resource'
    | 'community'
    | 'post'
    | 'comment'
    | 'tag'
    | 'user'
    | 'opportunity'
    | 'event'
    | 'study_group'
    | 'idea'
    | 'confession'
    | 'complaint';
  id: string;
  title: string;
  snippet: string;
  subtitle: string;
  link_path: string;
  score: number;
  meta: Record<string, string | number | boolean | null>;
}
