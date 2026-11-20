import React, { useCallback, useEffect, useState } from 'react';
import {
  Archive,
  Check,
  Edit3,
  ExternalLink,
  Eye,
  Flag,
  FolderPlus,
  KeyRound,
  Plus,
  RotateCcw,
  Shield,
  Trash2,
  UserPlus,
  X,
} from 'lucide-react';
import { useApp } from '../../context/AppContext.tsx';
import { api, formatBytes, formatRelativeDate, formatRoleLabel, resolveApiUrl } from '../../lib/api.ts';
import type { Community, StaffVerificationRequest, UserRole } from '../../types/index.ts';

type AdminTab = 'overview' | 'academic' | 'moderation' | 'staff_verification' | 'users' | 'profanity' | 'audit';

interface ReportedTargetPreview {
  exists: boolean;
  type: string;
  id: string;
  title: string | null;
  body: string | null;
  image_url: string | null;
  context_label: string | null;
  community_slug: string | null;
  post_id: string | null;
  author_id: string | null;
  author_name: string | null;
  author_username: string | null;
  author_role: string | null;
  is_hidden: boolean;
  status: string | null;
  created_at: string | null;
}

interface AdminReportItem {
  id: string;
  target_type: string;
  target_id: string;
  reason: string;
  details?: string;
  reporter_name: string;
  reporter_username?: string;
  status: string;
  resolution_notes?: string | null;
  created_at?: string;
  target?: ReportedTargetPreview;
}

interface AdminOverviewData {
  stats: Record<string, number>;
  queues: {
    pendingResources: Array<{
      id: string;
      title: string;
      program_code: string;
      semester_name: string;
      subject_name: string;
      category_name: string;
      uploader_name: string;
      revision_id: string;
      revision_number: number;
      original_filename: string;
      file_size: number;
    }>;
    pendingConfessions: Array<{ id: string; title: string; body: string; image_url?: string | null; category: string; created_at: string }>;
    pendingOpportunities: Array<{ id: string; title: string; organization: string; kind: string; author_name: string }>;
    pendingDonations: Array<{ id: string; title: string; category: string; requester_name: string; description: string }>;
    openReports: AdminReportItem[];
  };
}

export function AdminDashboard() {
  const { user, structure, refreshStructure, refreshCommunities, navigate, notify } = useApp();
  const [tab, setTab] = useState<AdminTab>('overview');
  const [overview, setOverview] = useState<AdminOverviewData | null>(null);
  const [staffRequests, setStaffRequests] = useState<StaffVerificationRequest[]>([]);
  const [staffFilter, setStaffFilter] = useState<'pending' | 'approved' | 'rejected' | 'all'>('pending');
  const [staffReviewNotes, setStaffReviewNotes] = useState<Record<string, string>>({});
  const [reportFilter, setReportFilter] = useState<'open' | 'all'>('open');
  const [reportNotes, setReportNotes] = useState<Record<string, string>>({});
  const [usersList, setUsersList] = useState<Array<{ id: string; email: string; username: string; display_name: string; role: UserRole; account_status: string; university_email_verified: boolean | number; program_code: string | null }>>([]);
  const [userSearch, setUserSearch] = useState('');
  const [profanityList, setProfanityList] = useState<Array<{ id: string; term: string; language: string; severity: string; context_exception_note: string | null }>>([]);
  const [auditLogs, setAuditLogs] = useState<Array<{ id: string; actor_name: string | null; actor_role: string | null; action: string; target_type: string; target_id: string; metadata?: Record<string, unknown> | string | null; metadata_json?: string | null; created_at: string }>>([]);

  // Academic Structure Management State
  const [fullStruct, setFullStruct] = useState(structure);
  const [adminCommunities, setAdminCommunities] = useState<Community[]>([]);
  const [selectedProgId, setSelectedProgId] = useState('');
  const [selectedSemId, setSelectedSemId] = useState('');
  const [selectedSubjId, setSelectedSubjId] = useState('');

  // Create & Edit Academic Structure forms
  const [newProgCode, setNewProgCode] = useState('');
  const [newProgName, setNewProgName] = useState('');
  const [editingProgId, setEditingProgId] = useState<string | null>(null);
  const [editProgCode, setEditProgCode] = useState('');
  const [editProgName, setEditProgName] = useState('');

  const [editingSemId, setEditingSemId] = useState<string | null>(null);
  const [editSemName, setEditSemName] = useState('');

  const [newSubjName, setNewSubjName] = useState('');
  const [newSubjCode, setNewSubjCode] = useState('');
  const [newFolderName, setNewFolderName] = useState('');
  const [renamingSubjId, setRenamingSubjId] = useState<string | null>(null);
  const [renameSubjVal, setRenameSubjVal] = useState('');
  const [renameSubjCode, setRenameSubjCode] = useState('');

  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [renameFolderVal, setRenameFolderVal] = useState('');

  const [editingCatId, setEditingCatId] = useState<string | null>(null);
  const [editCatName, setEditCatName] = useState('');
  const [editCatDesc, setEditCatDesc] = useState('');

  const [editingCommId, setEditingCommId] = useState<string | null>(null);
  const [editCommName, setEditCommName] = useState('');
  const [editCommDesc, setEditCommDesc] = useState('');

  // Super Admin: Create & manage Admin accounts
  const [adminUsername, setAdminUsername] = useState('');
  const [adminDisplayName, setAdminDisplayName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [creatingAdmin, setCreatingAdmin] = useState(false);
  const [resetAdminId, setResetAdminId] = useState<string | null>(null);
  const [resetAdminPassword, setResetAdminPassword] = useState('');

  // Profanity form
  const [newTerm, setNewTerm] = useState('');
  const [newLang, setNewLang] = useState<'en' | 'ne_devanagari' | 'ne_romanized'>('ne_romanized');
  const [newSev, setNewSev] = useState<'low' | 'medium' | 'high'>('medium');

  // Super Admin Identity Vault Modal
  const [vaultTargetId, setVaultTargetId] = useState<string | null>(null);
  const [vaultReason, setVaultReason] = useState('');
  const [vaultResult, setVaultResult] = useState<{ username: string; display_name: string; email: string; role: string } | null>(null);

  // Authorized PDF / Evidence inspection modal
  const [inspectPdfModal, setInspectPdfModal] = useState<{ title: string; blobUrl: string; isImage?: boolean } | null>(null);

  const isStaff = user && ['super_admin', 'admin', 'community_moderator'].includes(user.role);
  const isAdmin = user && ['super_admin', 'admin'].includes(user.role);
  const isSuperAdmin = user?.role === 'super_admin';

  const loadOverview = useCallback(async () => {
    if (!isStaff) return;
    const data = await api.get<AdminOverviewData>('/api/admin/overview');
    setOverview(data);
  }, [isStaff]);

  const loadAllAcademic = useCallback(async () => {
    const [data, commsRes] = await Promise.all([
      api.get<typeof structure>('/api/academic/structure?includeArchived=true'),
      api.get<{ communities: Community[] }>('/api/communities?includeArchived=true'),
    ]);
    setFullStruct(data);
    setAdminCommunities(commsRes.communities);
  }, []);

  const loadUsers = useCallback(async () => {
    if (!isAdmin) return;
    const data = await api.get<{ users: typeof usersList }>(`/api/admin/users?q=${encodeURIComponent(userSearch)}`);
    setUsersList(data.users);
  }, [isAdmin, userSearch]);

  const loadProfanity = useCallback(async () => {
    if (!isStaff) return;
    const data = await api.get<{ terms: typeof profanityList }>('/api/admin/profanity');
    setProfanityList(data.terms);
  }, [isStaff]);

  const loadAudit = useCallback(async () => {
    if (!isAdmin) return;
    const data = await api.get<{ logs: typeof auditLogs }>('/api/admin/audit-logs');
    setAuditLogs(data.logs);
  }, [isAdmin]);

  const loadStaffRequests = useCallback(async () => {
    if (!isAdmin) return;
    const data = await api.get<{ requests: StaffVerificationRequest[] }>(
      `/api/admin/staff-verification?status=${encodeURIComponent(staffFilter)}`
    );
    setStaffRequests(data.requests);
  }, [isAdmin, staffFilter]);

  useEffect(() => {
    void loadOverview();
    void loadAllAcademic();
    void loadProfanity();
  }, [loadOverview, loadAllAcademic, loadProfanity]);

  useEffect(() => {
    if (!selectedProgId && fullStruct.programs.length > 0) {
      const firstProg = fullStruct.programs[0].id;
      setSelectedProgId(firstProg);
      const firstSem = fullStruct.semesters.find((s) => s.program_id === firstProg);
      if (firstSem) setSelectedSemId(firstSem.id);
    } else if (selectedProgId && !selectedSemId) {
      const firstSem = fullStruct.semesters.find((s) => s.program_id === selectedProgId);
      if (firstSem) setSelectedSemId(firstSem.id);
    }
  }, [fullStruct.programs, fullStruct.semesters, selectedProgId, selectedSemId]);

  useEffect(() => {
    if (tab === 'users') void loadUsers();
    if (tab === 'audit') void loadAudit();
    if (tab === 'staff_verification') void loadStaffRequests();
  }, [tab, loadUsers, loadAudit, loadStaffRequests]);

  if (!isStaff) {
    return (
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-8 text-center space-y-3">
        <Shield className="w-8 h-8 text-slate-400 mx-auto" />
        <h1 className="font-display text-lg font-bold">Administrative Access Required</h1>
        <p className="text-xs text-slate-500 max-w-md mx-auto">
          Only authorized Moderators, Administrators, and Super Admins can view this console.
        </p>
        <button
          type="button"
          onClick={() => navigate('home')}
          className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-medium hover:bg-slate-50 dark:hover:bg-slate-800"
        >
          Return Home
        </button>
      </div>
    );
  }

  async function handleCreateProgram(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api.post('/api/academic/programs', { code: newProgCode, name: newProgName });
      setNewProgCode('');
      setNewProgName('');
      await Promise.all([loadAllAcademic(), refreshStructure()]);
      notify('Academic program created with 8 semesters.', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to create program.', 'error');
    }
  }

  async function handleSaveProgram(progId: string) {
    if (!editProgName.trim() || !editProgCode.trim()) return;
    try {
      await api.patch(`/api/academic/programs/${progId}`, {
        code: editProgCode.trim(),
        name: editProgName.trim(),
      });
      setEditingProgId(null);
      await Promise.all([loadAllAcademic(), refreshStructure()]);
      notify('Program updated.', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to update program.', 'error');
    }
  }

  async function handleSaveSemester(semId: string) {
    if (!editSemName.trim()) return;
    try {
      await api.patch(`/api/academic/semesters/${semId}`, { name: editSemName.trim() });
      setEditingSemId(null);
      await Promise.all([loadAllAcademic(), refreshStructure()]);
      notify('Semester renamed.', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to rename semester.', 'error');
    }
  }

  async function handleCreateSubject(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api.post('/api/academic/subjects', {
        program_id: selectedProgId,
        semester_id: selectedSemId,
        code: newSubjCode,
        name: newSubjName,
      });
      setNewSubjName('');
      setNewSubjCode('');
      await Promise.all([loadAllAcademic(), refreshStructure()]);
      notify('Subject created and indexed in search.', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to create subject.', 'error');
    }
  }

  async function handleRenameSubject(subjId: string) {
    if (!renameSubjVal.trim()) return;
    try {
      await api.patch(`/api/academic/subjects/${subjId}`, {
        name: renameSubjVal.trim(),
        code: renameSubjCode.trim(),
      });
      setRenamingSubjId(null);
      await Promise.all([loadAllAcademic(), refreshStructure()]);
      notify('Subject updated immediately across platform.', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to update subject.', 'error');
    }
  }

  async function handleArchiveSubject(subjId: string, archived: boolean) {
    await api.patch(`/api/academic/subjects/${subjId}`, { is_archived: archived });
    await Promise.all([loadAllAcademic(), refreshStructure()]);
    notify(archived ? 'Subject archived.' : 'Subject restored.', 'info');
  }

  async function handleCreateFolder(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedSubjId || !newFolderName.trim()) return;
    try {
      await api.post('/api/academic/folders', { subject_id: selectedSubjId, name: newFolderName });
      setNewFolderName('');
      await Promise.all([loadAllAcademic(), refreshStructure()]);
      notify('Subtopic folder created.', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to create folder.', 'error');
    }
  }

  async function handleRenameFolder(folderId: string) {
    if (!renameFolderVal.trim()) return;
    try {
      await api.patch(`/api/academic/folders/${folderId}`, { name: renameFolderVal.trim() });
      setRenamingFolderId(null);
      await Promise.all([loadAllAcademic(), refreshStructure()]);
      notify('Subtopic / folder renamed.', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to rename folder.', 'error');
    }
  }

  async function handleArchiveFolder(folderId: string, archived: boolean) {
    await api.patch(`/api/academic/folders/${folderId}`, { is_archived: archived });
    await Promise.all([loadAllAcademic(), refreshStructure()]);
    notify(archived ? 'Topic folder archived.' : 'Topic folder restored.', 'info');
  }

  async function handleSaveCategory(catId: string) {
    if (!editCatName.trim()) return;
    try {
      await api.patch(`/api/academic/categories/${catId}`, {
        name: editCatName.trim(),
        description: editCatDesc.trim(),
      });
      setEditingCatId(null);
      await Promise.all([loadAllAcademic(), refreshStructure()]);
      notify('Category updated.', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to update category.', 'error');
    }
  }

  async function handleSaveCommunity(commId: string) {
    if (!editCommName.trim()) return;
    try {
      await api.patch(`/api/communities/${commId}`, {
        name: editCommName.trim(),
        description: editCommDesc.trim(),
      });
      setEditingCommId(null);
      await Promise.all([loadAllAcademic(), refreshCommunities()]);
      notify('Community updated.', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to update community.', 'error');
    }
  }

  async function handleCreateAdmin(e: React.FormEvent) {
    e.preventDefault();
    setCreatingAdmin(true);
    try {
      await api.post('/api/admin/admins', {
        username: adminUsername.trim(),
        display_name: adminDisplayName.trim() || undefined,
        email: adminEmail.trim() || undefined,
        password: adminPassword,
      });
      setAdminUsername('');
      setAdminDisplayName('');
      setAdminEmail('');
      setAdminPassword('');
      await loadUsers();
      notify('Admin account created. They can now sign in with that username and password.', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Could not create admin account.', 'error');
    } finally {
      setCreatingAdmin(false);
    }
  }

  async function handleResetAdminPassword(adminId: string) {
    if (!resetAdminPassword) return;
    try {
      await api.patch(`/api/admin/admins/${adminId}`, { password: resetAdminPassword });
      setResetAdminId(null);
      setResetAdminPassword('');
      notify('Admin password updated.', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Password update failed.', 'error');
    }
  }

  async function handleVaultReveal(e: React.FormEvent) {
    e.preventDefault();
    if (!vaultTargetId) return;
    try {
      const res = await api.post<{ identity: typeof vaultResult }>(`/api/confessions/${vaultTargetId}/identity-lookup`, {
        reason: vaultReason,
      });
      setVaultResult(res.identity);
      notify('Identity vault access logged in security audit trail.', 'info');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Lookup failed.', 'error');
    }
  }

  async function handleInspectPendingPdf(resourceId: string, revisionId: string, title: string) {
    try {
      const blob = await api.fetchBlob(
        `/api/academic/resources/${encodeURIComponent(resourceId)}/file?revisionId=${encodeURIComponent(revisionId)}`
      );
      const blobUrl = URL.createObjectURL(blob);
      setInspectPdfModal((prev) => {
        if (prev) URL.revokeObjectURL(prev.blobUrl);
        return { title, blobUrl };
      });
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Unable to open PDF.', 'error');
    }
  }

  async function handleInspectStaffEvidence(reqId: string, title: string) {
    try {
      const blob = await api.fetchBlob(`/api/admin/staff-verification/${encodeURIComponent(reqId)}/evidence`);
      const blobUrl = URL.createObjectURL(blob);
      const isImage = blob.type.startsWith('image/');
      setInspectPdfModal((prev) => {
        if (prev) URL.revokeObjectURL(prev.blobUrl);
        return { title, blobUrl, isImage };
      });
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Unable to open supporting document.', 'error');
    }
  }

  async function handleReviewStaffRequest(reqId: string, decision: 'approved' | 'rejected') {
    try {
      await api.post(`/api/admin/staff-verification/${encodeURIComponent(reqId)}/review`, {
        decision,
        review_notes: (staffReviewNotes[reqId] || '').trim(),
      });
      await Promise.all([loadStaffRequests(), loadOverview(), loadUsers()]);
      notify(
        decision === 'approved'
          ? 'Staff verification approved and user promoted to Verified Teacher.'
          : 'Staff verification request declined.',
        decision === 'approved' ? 'success' : 'info'
      );
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Review action failed.', 'error');
    }
  }

  async function handleResolveReport(
    reportId: string,
    status: 'resolved' | 'dismissed',
    action: 'none' | 'hide_target' = 'none'
  ) {
    try {
      const note = (reportNotes[reportId] || '').trim();
      await api.patch(`/api/admin/reports/${encodeURIComponent(reportId)}`, {
        status,
        action,
        resolution_notes:
          note ||
          (action === 'hide_target'
            ? 'Reported content hidden and resolved by moderator'
            : status === 'resolved'
              ? 'Reviewed by moderator'
              : 'Dismissed after review'),
      });
      setReportNotes((prev) => {
        const next = { ...prev };
        delete next[reportId];
        return next;
      });
      await loadOverview();
      notify(
        action === 'hide_target'
          ? 'Reported content hidden and report marked resolved.'
          : status === 'resolved'
            ? 'Report marked as resolved.'
            : 'Report dismissed.',
        status === 'resolved' ? 'success' : 'info'
      );
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Unable to update report.', 'error');
    }
  }

  function formatReportTargetLabel(type: string): string {
    switch (type) {
      case 'post':
        return 'Discussion Post';
      case 'comment':
        return 'Comment';
      case 'resource':
        return 'Academic Resource';
      case 'confession':
        return 'Confession';
      case 'user':
        return 'User Account';
      default:
        return type;
    }
  }

  const semsForProg = fullStruct.semesters.filter((s) => s.program_id === selectedProgId);
  const subjsForSem = fullStruct.subjects.filter((s) => s.semester_id === selectedSemId);
  const foldersForSubj = fullStruct.folders.filter((f) => f.subject_id === selectedSubjId);

  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <h1 className="font-display text-xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <Shield className="w-5 h-5 text-blue-700 dark:text-blue-400" />
              Administration & Moderation Console
            </h1>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Signed in as {user.display_name} ({formatRoleLabel(user.role)})
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="px-2.5 py-1 rounded-md border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200">
              {formatRoleLabel(user.role)} Session Active
            </span>
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5 pt-2 border-t border-slate-100 dark:border-slate-800">
          {([
            { id: 'overview', label: 'Overview' },
            { id: 'moderation', label: 'Review Queues' },
            ...(isAdmin ? [{ id: 'staff_verification', label: `Staff Verification${overview?.stats?.pending_staff_verifications ? ` (${overview.stats.pending_staff_verifications})` : ''}` }] : []),
            ...(isAdmin ? [{ id: 'academic', label: 'Academic Structure' }] : []),
            ...(isAdmin ? [{ id: 'users', label: 'Users & Roles' }] : []),
            { id: 'profanity', label: 'Profanity Filter' },
            ...(isAdmin ? [{ id: 'audit', label: 'Audit Logs' }] : []),
          ] as Array<{ id: AdminTab; label: string }>).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap ${
                tab === t.id ? 'bg-slate-900 text-white dark:bg-blue-600' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </section>

      {/* OVERVIEW */}
      {tab === 'overview' && overview && (
        <div className="space-y-5">
          <section className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {[
              { label: 'Registered Users', value: overview.stats.total_users },
              { label: 'Verified Students', value: overview.stats.verified_students },
              { label: 'Verified Teachers', value: overview.stats.verified_teachers },
              { label: 'Approved Resources', value: overview.stats.total_resources },
              { label: 'Pending PDFs / Revisions', value: overview.stats.pending_resources },
              { label: 'Pending Staff Verifications', value: overview.stats.pending_staff_verifications ?? 0 },
              { label: 'Pending Confessions', value: overview.stats.pending_confessions },
              { label: 'Pending Complaints', value: overview.stats.pending_complaints },
              { label: 'Open Reports', value: overview.stats.open_reports },
            ].map((m) => (
              <div key={m.label} className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
                <div className="text-xs text-slate-500 dark:text-slate-400">{m.label}</div>
                <div className="font-mono tabular-nums text-2xl font-bold text-slate-900 dark:text-white mt-1">
                  {m.value}
                </div>
              </div>
            ))}
          </section>

          {overview.queues.openReports.some((r) => r.status === 'open') && (
            <section className="rounded-xl border border-red-200 dark:border-red-900/60 bg-white dark:bg-slate-900 p-5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                  <Flag className="w-4 h-4 text-red-600 dark:text-red-400" />
                  Open Reports Requiring Review ({overview.queues.openReports.filter((r) => r.status === 'open').length})
                </h2>
                <button
                  type="button"
                  onClick={() => setTab('moderation')}
                  className="px-3 py-1.5 rounded-lg bg-slate-900 dark:bg-blue-600 text-white text-xs font-medium"
                >
                  Inspect &amp; Moderate in Review Queues
                </button>
              </div>
              <div className="divide-y divide-slate-100 dark:divide-slate-800">
                {overview.queues.openReports
                  .filter((r) => r.status === 'open')
                  .slice(0, 3)
                  .map((rp) => (
                    <div key={rp.id} className="py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
                      <div className="min-w-0 space-y-0.5">
                        <div className="font-medium text-slate-900 dark:text-slate-100 truncate">
                          [{formatReportTargetLabel(rp.target_type)}] {rp.target?.title || rp.target?.body || rp.target_id}
                        </div>
                        <div className="text-slate-500 truncate">
                          Reason: {rp.reason} · Reported by {rp.reporter_name}
                          {rp.target?.author_name ? ` · Author: ${rp.target.author_name}` : ''}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setTab('moderation')}
                        className="px-2.5 py-1 rounded border border-slate-200 dark:border-slate-700 text-xs shrink-0 hover:bg-slate-50 dark:hover:bg-slate-800"
                      >
                        Inspect Report
                      </button>
                    </div>
                  ))}
              </div>
            </section>
          )}
        </div>
      )}

      {/* ACADEMIC STRUCTURE MANAGEMENT */}
      {tab === 'academic' && isAdmin && (
        <div className="space-y-5">
          <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4">
            <h2 className="text-sm font-semibold">1. Programs (Add or Edit Program Name &amp; Code)</h2>
            <form onSubmit={handleCreateProgram} className="flex flex-col sm:flex-row gap-2">
              <input type="text" required value={newProgCode} onChange={(e) => setNewProgCode(e.target.value)} placeholder="Code (e.g. BSc.CS)" className="sm:w-36 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-xs" />
              <input type="text" required value={newProgName} onChange={(e) => setNewProgName(e.target.value)} placeholder="Full Program Name" className="flex-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-xs" />
              <button type="submit" className="inline-flex items-center gap-1 px-4 py-2 rounded-lg bg-slate-900 dark:bg-blue-600 text-white text-xs font-medium shrink-0">
                <Plus className="w-3.5 h-3.5" /> Add Program
              </button>
            </form>

            <div className="flex flex-wrap gap-2">
              {fullStruct.programs.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    setSelectedProgId(p.id);
                    setEditingProgId(null);
                    const firstSem = fullStruct.semesters.find((s) => s.program_id === p.id);
                    if (firstSem) setSelectedSemId(firstSem.id);
                    setSelectedSubjId('');
                  }}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium ${
                    selectedProgId === p.id ? 'bg-slate-900 text-white dark:bg-blue-600' : 'border border-slate-200 dark:border-slate-700'
                  }`}
                >
                  {p.code}
                </button>
              ))}
            </div>

            {(() => {
              const activeProg = fullStruct.programs.find((p) => p.id === selectedProgId);
              if (!activeProg) return null;
              return (
                <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2 text-xs">
                  {editingProgId === activeProg.id ? (
                    <div className="flex flex-wrap items-center gap-2 flex-1">
                      <input
                        type="text"
                        value={editProgCode}
                        onChange={(e) => setEditProgCode(e.target.value)}
                        placeholder="Program code"
                        className="w-28 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1 text-xs"
                      />
                      <input
                        type="text"
                        value={editProgName}
                        onChange={(e) => setEditProgName(e.target.value)}
                        placeholder="Program full name"
                        className="flex-1 min-w-48 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1 text-xs"
                      />
                      <button type="button" onClick={() => void handleSaveProgram(activeProg.id)} className="px-3 py-1 rounded bg-slate-900 dark:bg-blue-600 text-white text-xs">
                        Save
                      </button>
                      <button type="button" onClick={() => setEditingProgId(null)} className="text-xs text-slate-500">
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="text-slate-700 dark:text-slate-300">
                        <span className="font-mono font-semibold">{activeProg.code}</span> — {activeProg.name}
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingProgId(activeProg.id);
                          setEditProgCode(activeProg.code);
                          setEditProgName(activeProg.name);
                        }}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
                      >
                        <Edit3 className="w-3 h-3" /> Edit Program Name
                      </button>
                    </>
                  )}
                </div>
              );
            })()}
          </section>

          <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4">
            <h2 className="text-sm font-semibold">2. Semesters, Subjects &amp; Topics (Rename, Create, Archive, Restore)</h2>
            <div className="flex flex-wrap gap-1.5">
              {semsForProg.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => {
                    setSelectedSemId(s.id);
                    setEditingSemId(null);
                    setSelectedSubjId('');
                  }}
                  className={`px-2.5 py-1 rounded text-xs ${
                    selectedSemId === s.id ? 'bg-blue-50 dark:bg-blue-950 text-blue-800 dark:text-blue-300 font-semibold border border-blue-200 dark:border-blue-800' : 'border border-slate-200 dark:border-slate-800'
                  }`}
                >
                  {s.name}
                </button>
              ))}
            </div>

            {(() => {
              const activeSem = semsForProg.find((s) => s.id === selectedSemId);
              if (!activeSem) return null;
              return (
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs pb-2 border-b border-slate-100 dark:border-slate-800">
                  {editingSemId === activeSem.id ? (
                    <div className="flex items-center gap-2 flex-1">
                      <input
                        type="text"
                        value={editSemName}
                        onChange={(e) => setEditSemName(e.target.value)}
                        className="w-60 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1 text-xs"
                      />
                      <button type="button" onClick={() => void handleSaveSemester(activeSem.id)} className="px-2.5 py-1 rounded bg-slate-900 dark:bg-blue-600 text-white text-xs">
                        Save
                      </button>
                      <button type="button" onClick={() => setEditingSemId(null)} className="text-xs text-slate-500">
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <>
                      <span className="text-slate-600 dark:text-slate-400">
                        Selected Semester: <strong className="text-slate-900 dark:text-slate-100">{activeSem.name}</strong>
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingSemId(activeSem.id);
                          setEditSemName(activeSem.name);
                        }}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
                      >
                        <Edit3 className="w-3 h-3" /> Rename Semester
                      </button>
                    </>
                  )}
                </div>
              );
            })()}

            <form onSubmit={handleCreateSubject} className="flex flex-col sm:flex-row gap-2">
              <input type="text" value={newSubjCode} onChange={(e) => setNewSubjCode(e.target.value)} placeholder="Code (e.g. BIT-101)" className="sm:w-32 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-xs" />
              <input type="text" required value={newSubjName} onChange={(e) => setNewSubjName(e.target.value)} placeholder="New subject name (e.g. Data Science)" className="flex-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-xs" />
              <button type="submit" className="inline-flex items-center gap-1 px-4 py-2 rounded-lg bg-slate-900 dark:bg-blue-600 text-white text-xs font-medium shrink-0">
                <Plus className="w-3.5 h-3.5" /> Add Subject
              </button>
            </form>

            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {subjsForSem.map((sub) => (
                <div key={sub.id} className="py-2.5 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    {renamingSubjId === sub.id ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          type="text"
                          value={renameSubjCode}
                          onChange={(e) => setRenameSubjCode(e.target.value)}
                          placeholder="Code"
                          className="w-24 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1 text-xs font-mono"
                        />
                        <input
                          type="text"
                          value={renameSubjVal}
                          onChange={(e) => setRenameSubjVal(e.target.value)}
                          placeholder="Subject name"
                          className="min-w-52 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1 text-xs"
                        />
                        <button type="button" onClick={() => void handleRenameSubject(sub.id)} className="px-2.5 py-1 rounded bg-slate-900 dark:bg-blue-600 text-white text-xs">
                          Save
                        </button>
                        <button type="button" onClick={() => setRenamingSubjId(null)} className="text-xs text-slate-500">
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setSelectedSubjId(sub.id)}
                        className={`text-left text-sm font-medium hover:text-blue-700 dark:hover:text-blue-400 ${
                          sub.is_archived ? 'line-through text-slate-400' : ''
                        }`}
                      >
                        {sub.name} <span className="font-mono text-xs text-slate-400">({sub.code || 'NO CODE'})</span>
                      </button>
                    )}
                  </div>

                  <div className="flex items-center gap-2 text-xs">
                    <button
                      type="button"
                      onClick={() => {
                        setRenamingSubjId(sub.id);
                        setRenameSubjVal(sub.name);
                        setRenameSubjCode(sub.code || '');
                      }}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
                    >
                      <Edit3 className="w-3 h-3" /> Edit Subject
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelectedSubjId(sub.id)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
                    >
                      <FolderPlus className="w-3 h-3" /> Topics
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleArchiveSubject(sub.id, !sub.is_archived)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-200 dark:border-slate-700"
                    >
                      {sub.is_archived ? <RotateCcw className="w-3 h-3" /> : <Archive className="w-3 h-3" />}
                      {sub.is_archived ? 'Restore' : 'Archive'}
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {selectedSubjId && (
              <div className="pt-3 border-t border-slate-200 dark:border-slate-800 space-y-3">
                <div className="text-xs font-semibold">
                  Topics / Subtopic Folders for {fullStruct.subjects.find((s) => s.id === selectedSubjId)?.name}
                </div>
                <form onSubmit={handleCreateFolder} className="flex gap-2">
                  <input
                    type="text"
                    required
                    value={newFolderName}
                    onChange={(e) => setNewFolderName(e.target.value)}
                    placeholder="New topic / subtopic folder name"
                    className="flex-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-1.5 text-xs"
                  />
                  <button type="submit" className="px-3 py-1.5 rounded-lg bg-slate-900 dark:bg-blue-600 text-white text-xs font-medium">
                    Add Topic
                  </button>
                </form>
                <div className="divide-y divide-slate-100 dark:divide-slate-800">
                  {foldersForSubj.length === 0 ? (
                    <p className="text-xs text-slate-500 py-1">No topics added under this subject yet.</p>
                  ) : (
                    foldersForSubj.map((f) => (
                      <div key={f.id} className="py-2 flex flex-wrap items-center justify-between gap-2 text-xs">
                        {renamingFolderId === f.id ? (
                          <div className="flex items-center gap-2 flex-1">
                            <input
                              type="text"
                              value={renameFolderVal}
                              onChange={(e) => setRenameFolderVal(e.target.value)}
                              className="flex-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1 text-xs"
                            />
                            <button type="button" onClick={() => void handleRenameFolder(f.id)} className="px-2.5 py-1 rounded bg-slate-900 dark:bg-blue-600 text-white">
                              Save
                            </button>
                            <button type="button" onClick={() => setRenamingFolderId(null)} className="text-slate-500">
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <>
                            <span className={f.is_archived ? 'line-through text-slate-400' : 'font-medium text-slate-800 dark:text-slate-200'}>
                              {f.name}
                            </span>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => {
                                  setRenamingFolderId(f.id);
                                  setRenameFolderVal(f.name);
                                }}
                                className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
                              >
                                <Edit3 className="w-3 h-3" /> Rename
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleArchiveFolder(f.id, !f.is_archived)}
                                className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-200 dark:border-slate-700"
                              >
                                {f.is_archived ? <RotateCcw className="w-3 h-3" /> : <Archive className="w-3 h-3" />}
                                {f.is_archived ? 'Restore' : 'Archive'}
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </section>

          <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4">
            <h2 className="text-sm font-semibold">3. Resource Categories &amp; Discussion Communities (Rename &amp; Edit)</h2>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              <div className="space-y-2">
                <div className="text-xs font-semibold text-slate-700 dark:text-slate-300">Resource Categories</div>
                <div className="divide-y divide-slate-100 dark:divide-slate-800">
                  {fullStruct.categories.map((cat) => (
                    <div key={cat.id} className="py-2 flex flex-wrap items-center justify-between gap-2 text-xs">
                      {editingCatId === cat.id ? (
                        <div className="w-full space-y-2">
                          <input
                            type="text"
                            value={editCatName}
                            onChange={(e) => setEditCatName(e.target.value)}
                            placeholder="Category name"
                            className="w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1 text-xs"
                          />
                          <input
                            type="text"
                            value={editCatDesc}
                            onChange={(e) => setEditCatDesc(e.target.value)}
                            placeholder="Description"
                            className="w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1 text-xs"
                          />
                          <div className="flex gap-2">
                            <button type="button" onClick={() => void handleSaveCategory(cat.id)} className="px-2.5 py-1 rounded bg-slate-900 dark:bg-blue-600 text-white">Save</button>
                            <button type="button" onClick={() => setEditingCatId(null)} className="text-slate-500">Cancel</button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="min-w-0">
                            <div className="font-medium text-slate-900 dark:text-slate-100">{cat.name}</div>
                            <div className="text-slate-500 truncate">{cat.description}</div>
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingCatId(cat.id);
                              setEditCatName(cat.name);
                              setEditCatDesc(cat.description || '');
                            }}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-200 dark:border-slate-700 shrink-0"
                          >
                            <Edit3 className="w-3 h-3" /> Edit
                          </button>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <div className="text-xs font-semibold text-slate-700 dark:text-slate-300">Communities</div>
                <div className="divide-y divide-slate-100 dark:divide-slate-800 max-h-80 overflow-y-auto pr-1">
                  {adminCommunities.map((comm) => (
                    <div key={comm.id} className="py-2 flex flex-wrap items-center justify-between gap-2 text-xs">
                      {editingCommId === comm.id ? (
                        <div className="w-full space-y-2">
                          <input
                            type="text"
                            value={editCommName}
                            onChange={(e) => setEditCommName(e.target.value)}
                            placeholder="Community name"
                            className="w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1 text-xs"
                          />
                          <input
                            type="text"
                            value={editCommDesc}
                            onChange={(e) => setEditCommDesc(e.target.value)}
                            placeholder="Description"
                            className="w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1 text-xs"
                          />
                          <div className="flex gap-2">
                            <button type="button" onClick={() => void handleSaveCommunity(comm.id)} className="px-2.5 py-1 rounded bg-slate-900 dark:bg-blue-600 text-white">Save</button>
                            <button type="button" onClick={() => setEditingCommId(null)} className="text-slate-500">Cancel</button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="min-w-0">
                            <div className="font-medium text-slate-900 dark:text-slate-100">{comm.name}</div>
                            <div className="text-slate-500 truncate">{comm.description}</div>
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingCommId(comm.id);
                              setEditCommName(comm.name);
                              setEditCommDesc(comm.description || '');
                            }}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-200 dark:border-slate-700 shrink-0"
                          >
                            <Edit3 className="w-3 h-3" /> Edit
                          </button>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </section>
        </div>
      )}

      {/* MODERATION QUEUES */}
      {tab === 'moderation' && overview && (
        <div className="space-y-5">
          {/* Pending PDF Resources */}
          <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3">
            <h2 className="text-sm font-semibold">Pending Academic PDFs & Revisions ({overview.queues.pendingResources.length})</h2>
            {overview.queues.pendingResources.length === 0 ? (
              <p className="text-xs text-slate-500">Resource review queue is clear.</p>
            ) : (
              <div className="divide-y divide-slate-100 dark:divide-slate-800">
                {overview.queues.pendingResources.map((r) => (
                  <div key={r.revision_id} className="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="text-xs space-y-0.5">
                      <div className="font-semibold text-sm text-slate-900 dark:text-white">{r.title}</div>
                      <div className="text-slate-500">
                        {r.program_code} · {r.semester_name} · {r.subject_name} · {r.category_name} · v{r.revision_number} ({formatBytes(r.file_size)})
                      </div>
                      <div className="text-slate-400">Uploaded by {r.uploader_name}</div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => void handleInspectPendingPdf(r.id, r.revision_id, r.title)}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs"
                      >
                        <Eye className="w-3.5 h-3.5" /> Inspect PDF
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            await api.post(`/api/academic/resources/${r.id}/review`, { decision: 'approved', revision_id: r.revision_id, review_notes: 'Approved after verification' });
                            await loadOverview();
                            notify('Resource approved and published.', 'success');
                          } catch (err) {
                            notify(err instanceof Error ? err.message : 'Approval failed.', 'error');
                          }
                        }}
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-700 text-white text-xs font-medium"
                      >
                        <Check className="w-3.5 h-3.5" /> Approve
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            await api.post(`/api/academic/resources/${r.id}/review`, { decision: 'rejected', revision_id: r.revision_id, review_notes: 'Does not meet academic guidelines' });
                            await loadOverview();
                            notify('Resource rejected.', 'info');
                          } catch (err) {
                            notify(err instanceof Error ? err.message : 'Rejection failed.', 'error');
                          }
                        }}
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-red-600 text-white text-xs font-medium"
                      >
                        <X className="w-3.5 h-3.5" /> Reject
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Pending Confessions */}
          <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3">
            <h2 className="text-sm font-semibold">Pending Confessions ({overview.queues.pendingConfessions.length})</h2>
            {overview.queues.pendingConfessions.length === 0 ? (
              <p className="text-xs text-slate-500">No pending confessions.</p>
            ) : (
              <div className="divide-y divide-slate-100 dark:divide-slate-800">
                {overview.queues.pendingConfessions.map((c) => (
                  <div key={c.id} className="py-3 space-y-2">
                    {c.title && <div className="text-sm font-semibold">{c.title}</div>}
                    {c.body && <p className="text-xs text-slate-600 dark:text-slate-300">{c.body}</p>}
                    {c.image_url && (
                      <img
                        src={resolveApiUrl(c.image_url)}
                        alt={c.title || 'Pending confession attachment'}
                        className="max-h-56 w-auto rounded-lg border border-slate-200 dark:border-slate-800 object-contain"
                      />
                    )}
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={async () => {
                          await api.post(`/api/confessions/${c.id}/review`, { decision: 'approved' });
                          await loadOverview();
                          notify('Confession published anonymously.', 'success');
                        }}
                        className="px-3 py-1 rounded bg-emerald-700 text-white text-xs"
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          await api.post(`/api/confessions/${c.id}/review`, { decision: 'rejected' });
                          await loadOverview();
                          notify('Confession rejected.', 'info');
                        }}
                        className="px-3 py-1 rounded bg-red-600 text-white text-xs"
                      >
                        Reject
                      </button>
                      {isSuperAdmin && (
                        <button
                          type="button"
                          onClick={() => {
                            setVaultTargetId(c.id);
                            setVaultReason('');
                            setVaultResult(null);
                          }}
                          className="px-3 py-1 rounded border border-amber-500 text-amber-700 dark:text-amber-400 text-xs"
                        >
                          Super Admin: Audited Identity Lookup
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Pending Opportunities & Donations */}
          {(overview.queues.pendingOpportunities.length > 0 || overview.queues.pendingDonations.length > 0) && (
            <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3">
              <h2 className="text-sm font-semibold">Pending Opportunities &amp; Donations</h2>
              {overview.queues.pendingOpportunities.map((o) => (
                <div key={o.id} className="py-2 flex items-center justify-between border-b border-slate-100 dark:border-slate-800 text-xs">
                  <span>Opportunity: <strong>{o.title}</strong> ({o.organization})</span>
                  <div className="flex gap-2">
                    <button type="button" onClick={async () => { await api.post(`/api/opportunities/${o.id}/review`, { decision: 'approved' }); await loadOverview(); }} className="px-2.5 py-1 rounded bg-emerald-700 text-white">Approve</button>
                    <button type="button" onClick={async () => { await api.post(`/api/opportunities/${o.id}/review`, { decision: 'rejected' }); await loadOverview(); }} className="px-2.5 py-1 rounded bg-red-600 text-white">Reject</button>
                  </div>
                </div>
              ))}
              {overview.queues.pendingDonations.map((d) => (
                <div key={d.id} className="py-2 flex items-center justify-between border-b border-slate-100 dark:border-slate-800 text-xs">
                  <span>Donation Request: <strong>{d.title}</strong> by {d.requester_name}</span>
                  <div className="flex gap-2">
                    <button type="button" onClick={async () => { await api.post(`/api/donations/${d.id}/review`, { decision: 'approved', verification_notes: 'Verified by moderator' }); await loadOverview(); }} className="px-2.5 py-1 rounded bg-emerald-700 text-white">Approve</button>
                    <button type="button" onClick={async () => { await api.post(`/api/donations/${d.id}/review`, { decision: 'rejected' }); await loadOverview(); }} className="px-2.5 py-1 rounded bg-red-600 text-white">Reject</button>
                  </div>
                </div>
              ))}
            </section>
          )}

          {/* Reported Content & Accounts */}
          <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold flex items-center gap-2">
                  <Flag className="w-4 h-4 text-red-600 dark:text-red-400" />
                  Reported Content &amp; Accounts ({overview.queues.openReports.filter((r) => (reportFilter === 'open' ? r.status === 'open' : true)).length})
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Inspect the exact reported post, comment, resource, confession, or account before resolving or hiding content.
                </p>
              </div>
              <div className="flex items-center gap-1.5">
                {(['open', 'all'] as const).map((st) => (
                  <button
                    key={st}
                    type="button"
                    onClick={() => setReportFilter(st)}
                    className={`px-2.5 py-1 rounded-md text-xs font-medium capitalize ${
                      reportFilter === st
                        ? 'bg-slate-900 text-white dark:bg-blue-600'
                        : 'border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'
                    }`}
                  >
                    {st === 'open' ? 'Open Reports' : 'All Recent'}
                  </button>
                ))}
              </div>
            </div>

            {(() => {
              const filteredReports = overview.queues.openReports.filter((r) =>
                reportFilter === 'open' ? r.status === 'open' : true
              );
              if (filteredReports.length === 0) {
                return (
                  <p className="text-xs text-slate-500">
                    {reportFilter === 'open' ? 'No open reports waiting review.' : 'No reports recorded yet.'}
                  </p>
                );
              }
              return (
                <div className="space-y-4">
                  {filteredReports.map((rp) => {
                    const target = rp.target;
                    const canHideTarget =
                      Boolean(target?.exists) &&
                      ['post', 'comment', 'confession', 'resource'].includes(rp.target_type) &&
                      !target?.is_hidden &&
                      target?.status !== 'rejected';

                    return (
                      <div
                        key={rp.id}
                        className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 p-4 space-y-3"
                      >
                        {/* Report Metadata Header */}
                        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2">
                          <div className="space-y-1 text-xs">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="px-2 py-0.5 rounded bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-900 text-red-700 dark:text-red-300 font-semibold">
                                {formatReportTargetLabel(rp.target_type)}
                              </span>
                              <span className="px-2 py-0.5 rounded border border-slate-200 dark:border-slate-700 font-mono uppercase text-[10px] text-slate-600 dark:text-slate-300">
                                {rp.status}
                              </span>
                              {rp.created_at && (
                                <span className="font-mono text-[11px] text-slate-400">
                                  {formatRelativeDate(rp.created_at)}
                                </span>
                              )}
                            </div>
                            <div className="text-slate-900 dark:text-slate-100 font-semibold">
                              Reason: {rp.reason}
                            </div>
                            <div className="text-slate-500 dark:text-slate-400">
                              Reported by{' '}
                              {rp.reporter_username ? (
                                <button
                                  type="button"
                                  onClick={() => navigate('profile', rp.reporter_username)}
                                  className="font-medium text-slate-700 dark:text-slate-200 hover:underline"
                                >
                                  {rp.reporter_name} (@{rp.reporter_username})
                                </button>
                              ) : (
                                <span className="font-medium text-slate-700 dark:text-slate-200">{rp.reporter_name}</span>
                              )}
                            </div>
                            {rp.details && (
                              <div className="text-slate-600 dark:text-slate-300">
                                <span className="font-medium">Reporter Details:</span> {rp.details}
                              </div>
                            )}
                          </div>
                          <div className="text-[11px] font-mono text-slate-400 shrink-0">
                            ID: {rp.target_id.slice(0, 8)}
                          </div>
                        </div>

                        {/* Exact Reported Item Preview */}
                        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3.5 space-y-2">
                          {!target || !target.exists ? (
                            <p className="text-xs text-slate-500 italic">
                              Reported {formatReportTargetLabel(rp.target_type).toLowerCase()} is no longer available (already deleted or removed).
                            </p>
                          ) : (
                            <>
                              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                                <div className="flex flex-wrap items-center gap-1.5 text-slate-500 dark:text-slate-400">
                                  <span className="font-semibold text-slate-800 dark:text-slate-200">
                                    {target.type === 'confession' ? 'Author: Anonymous Student' : 'Author:'}
                                  </span>
                                  {target.type !== 'confession' && (
                                    target.author_username ? (
                                      <button
                                        type="button"
                                        onClick={() => navigate('profile', target.author_username || undefined)}
                                        className="font-medium text-blue-700 dark:text-blue-400 hover:underline"
                                      >
                                        {target.author_name || 'Unknown'} (@{target.author_username})
                                      </button>
                                    ) : (
                                      <span className="font-medium text-slate-700 dark:text-slate-300">
                                        {target.author_name || 'Unknown'}
                                      </span>
                                    )
                                  )}
                                  {target.author_role && (
                                    <span>· {formatRoleLabel(target.author_role as UserRole)}</span>
                                  )}
                                  {target.context_label && <span>· {target.context_label}</span>}
                                  {target.created_at && (
                                    <span className="font-mono text-[11px]">· {formatRelativeDate(target.created_at)}</span>
                                  )}
                                </div>
                                {(target.is_hidden || (target.status && !['active', 'approved'].includes(target.status))) && (
                                  <span className="px-2 py-0.5 rounded bg-amber-50 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-800 text-amber-800 dark:text-amber-300 font-mono text-[10px] uppercase">
                                    {target.status || 'hidden'}
                                  </span>
                                )}
                              </div>

                              {target.title && (
                                <div className="text-sm font-semibold text-slate-900 dark:text-white">
                                  {target.title}
                                </div>
                              )}
                              {target.body && (
                                <p className="text-xs text-slate-700 dark:text-slate-300 whitespace-pre-wrap leading-relaxed">
                                  {target.body}
                                </p>
                              )}
                              {target.image_url && (
                                <img
                                  src={resolveApiUrl(target.image_url)}
                                  alt={target.title || 'Reported attachment'}
                                  className="max-h-64 w-auto rounded-lg border border-slate-200 dark:border-slate-800 object-contain bg-slate-50 dark:bg-slate-950"
                                />
                              )}

                              <div className="flex flex-wrap items-center gap-2 pt-1 text-xs">
                                {target.community_slug && (
                                  <button
                                    type="button"
                                    onClick={() => navigate('communities', target.community_slug || undefined)}
                                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
                                  >
                                    <ExternalLink className="w-3 h-3" /> Open Community
                                  </button>
                                )}
                                {target.type === 'resource' && (
                                  <button
                                    type="button"
                                    onClick={() => navigate('academic')}
                                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
                                  >
                                    <ExternalLink className="w-3 h-3" /> Open Academic Explorer
                                  </button>
                                )}
                                {target.type === 'user' && target.author_username && (
                                  <>
                                    <button
                                      type="button"
                                      onClick={() => navigate('profile', target.author_username || undefined)}
                                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
                                    >
                                      <ExternalLink className="w-3 h-3" /> View Profile
                                    </button>
                                    {isAdmin && (
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setUserSearch(target.author_username || '');
                                          setTab('users');
                                        }}
                                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
                                      >
                                        Manage User Account
                                      </button>
                                    )}
                                  </>
                                )}
                                {target.type === 'confession' && isSuperAdmin && (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setVaultTargetId(target.id);
                                      setVaultReason('');
                                      setVaultResult(null);
                                    }}
                                    className="px-2.5 py-1 rounded border border-amber-500 text-amber-700 dark:text-amber-400"
                                  >
                                    Super Admin: Audited Identity Lookup
                                  </button>
                                )}
                              </div>
                            </>
                          )}
                        </div>

                        {/* Moderation Actions */}
                        {rp.status === 'open' ? (
                          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                            <input
                              type="text"
                              value={reportNotes[rp.id] || ''}
                              onChange={(e) => setReportNotes((prev) => ({ ...prev, [rp.id]: e.target.value }))}
                              placeholder="Optional moderation resolution note..."
                              className="flex-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs"
                            />
                            <div className="flex flex-wrap items-center gap-2 shrink-0">
                              {canHideTarget && (
                                <button
                                  type="button"
                                  onClick={() => void handleResolveReport(rp.id, 'resolved', 'hide_target')}
                                  className="px-3 py-1.5 rounded-lg bg-red-600 text-white text-xs font-medium hover:bg-red-700"
                                >
                                  Hide Content &amp; Resolve
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => void handleResolveReport(rp.id, 'resolved', 'none')}
                                className="px-3 py-1.5 rounded-lg bg-slate-900 dark:bg-blue-600 text-white text-xs font-medium"
                              >
                                Resolve
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleResolveReport(rp.id, 'dismissed', 'none')}
                                className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-xs"
                              >
                                Dismiss
                              </button>
                            </div>
                          </div>
                        ) : (
                          rp.resolution_notes && (
                            <div className="text-xs text-slate-500 dark:text-slate-400">
                              <strong>Resolution Notes:</strong> {rp.resolution_notes}
                            </div>
                          )
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })()}
          </section>
        </div>
      )}

      {/* STAFF VERIFICATION REQUESTS */}
      {tab === 'staff_verification' && isAdmin && (
        <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold">University Staff Verification Requests</h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Review applicant position, department, university email, and private supporting documents before elevating privileges.
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              {(['pending', 'approved', 'rejected', 'all'] as const).map((st) => (
                <button
                  key={st}
                  type="button"
                  onClick={() => setStaffFilter(st)}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium capitalize ${
                    staffFilter === st
                      ? 'bg-slate-900 text-white dark:bg-blue-600'
                      : 'border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'
                  }`}
                >
                  {st}
                </button>
              ))}
            </div>
          </div>

          {staffRequests.length === 0 ? (
            <p className="text-xs text-slate-500">No {staffFilter === 'all' ? '' : staffFilter} staff verification requests.</p>
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {staffRequests.map((req) => (
                <div key={req.id} className="py-4 space-y-3">
                  <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2">
                    <div className="space-y-1 text-xs">
                      <div className="text-sm font-semibold text-slate-900 dark:text-white">
                        {req.requester_name || 'Applicant'}{' '}
                        <span className="font-mono text-xs text-slate-500">@{req.requester_username}</span>
                      </div>
                      <div className="text-slate-600 dark:text-slate-300">
                        <strong>Position:</strong> {req.position} · <strong>Designation:</strong> {req.designation} ·{' '}
                        <strong>Department:</strong> {req.department}
                      </div>
                      <div className="font-mono text-[11px] text-slate-500">
                        University Email: {req.university_email} · Current Role: {formatRoleLabel((req.requester_role || 'verified_student') as UserRole)}
                      </div>
                      {req.supporting_notes && (
                        <p className="text-slate-600 dark:text-slate-300 pt-1">
                          Notes: {req.supporting_notes}
                        </p>
                      )}
                      {req.review_notes && (
                        <p className="text-slate-500 pt-1">
                          Review Notes: {req.review_notes}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="px-2 py-0.5 rounded border border-slate-200 dark:border-slate-700 text-[11px] font-mono uppercase">
                        {req.status}
                      </span>
                      {req.has_evidence && (
                        <button
                          type="button"
                          onClick={() => void handleInspectStaffEvidence(req.id, `${req.requester_name || req.university_email} — Verification Evidence`)}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs hover:bg-slate-50 dark:hover:bg-slate-800"
                        >
                          <Eye className="w-3.5 h-3.5" /> View Evidence
                        </button>
                      )}
                    </div>
                  </div>

                  {req.status === 'pending' && (
                    <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                      <input
                        type="text"
                        value={staffReviewNotes[req.id] || ''}
                        onChange={(e) => setStaffReviewNotes((prev) => ({ ...prev, [req.id]: e.target.value }))}
                        placeholder="Optional review notes for applicant..."
                        className="flex-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-1.5 text-xs"
                      />
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => void handleReviewStaffRequest(req.id, 'approved')}
                          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-700 text-white text-xs font-medium"
                        >
                          <Check className="w-3.5 h-3.5" /> Approve Staff
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleReviewStaffRequest(req.id, 'rejected')}
                          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-red-600 text-white text-xs font-medium"
                        >
                          <X className="w-3.5 h-3.5" /> Reject
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* USERS & ROLES */}
      {tab === 'users' && isAdmin && (
        <div className="space-y-5">
          {isSuperAdmin && (
            <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3">
              <div>
                <h2 className="text-sm font-semibold flex items-center gap-2">
                  <UserPlus className="w-4 h-4 text-blue-700 dark:text-blue-400" />
                  Create Admin Account (Super Admin Only)
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  Provision an administrator username and password directly. Admins sign in using this username &amp; password and are hidden from Connections.
                </p>
              </div>
              <form onSubmit={handleCreateAdmin} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2.5">
                <input
                  type="text"
                  required
                  value={adminUsername}
                  onChange={(e) => setAdminUsername(e.target.value)}
                  placeholder="Admin username (e.g. bit_admin)"
                  className="rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-xs"
                />
                <input
                  type="text"
                  value={adminDisplayName}
                  onChange={(e) => setAdminDisplayName(e.target.value)}
                  placeholder="Display name (optional)"
                  className="rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-xs"
                />
                <input
                  type="email"
                  value={adminEmail}
                  onChange={(e) => setAdminEmail(e.target.value)}
                  placeholder="Email (optional)"
                  className="rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-xs"
                />
                <input
                  type="password"
                  required
                  minLength={8}
                  value={adminPassword}
                  onChange={(e) => setAdminPassword(e.target.value)}
                  placeholder="Password (8+ chars, letter + num)"
                  className="rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-xs"
                />
                <button
                  type="submit"
                  disabled={creatingAdmin}
                  className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-slate-900 dark:bg-blue-600 text-white text-xs font-medium disabled:opacity-50"
                >
                  <UserPlus className="w-3.5 h-3.5" />
                  {creatingAdmin ? 'Creating...' : 'Create Admin'}
                </button>
              </form>
            </section>
          )}

          <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">User &amp; Role Management</h2>
              <input
                type="search"
                value={userSearch}
                onChange={(e) => setUserSearch(e.target.value)}
                placeholder="Search username, display name, or email..."
                className="sm:w-72 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-1.5 text-xs"
              />
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500">
                    <th className="py-2 pr-3">User</th>
                    <th className="py-2 pr-3">Email</th>
                    <th className="py-2 pr-3">Role</th>
                    <th className="py-2 pr-3">Status</th>
                    <th className="py-2">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {usersList.map((u) => (
                    <tr key={u.id}>
                      <td className="py-2.5 pr-3">
                        <div className="font-medium text-slate-900 dark:text-slate-100">{u.display_name}</div>
                        <div className="text-slate-500">@{u.username}</div>
                      </td>
                      <td className="py-2.5 pr-3 font-mono">{u.email}</td>
                      <td className="py-2.5 pr-3">
                        <select
                          value={u.role}
                          onChange={async (e) => {
                            try {
                              await api.patch(`/api/admin/users/${u.id}/role`, { role: e.target.value });
                              await loadUsers();
                              notify('Role updated and audited.', 'success');
                            } catch (err) {
                              notify(err instanceof Error ? err.message : 'Role update denied.', 'error');
                            }
                          }}
                          className="rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1 text-xs"
                        >
                          {(['super_admin', 'admin', 'community_moderator', 'verified_student', 'verified_teacher', 'future_student', 'alumni', 'visitor'] as UserRole[]).map((r) => (
                            <option key={r} value={r}>{formatRoleLabel(r)}</option>
                          ))}
                        </select>
                      </td>
                      <td className="py-2.5 pr-3 font-mono">{u.account_status}</td>
                      <td className="py-2.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <button
                            type="button"
                            onClick={async () => {
                              const next = u.account_status === 'active' ? 'suspended' : 'active';
                              await api.patch(`/api/admin/users/${u.id}/status`, { account_status: next });
                              await loadUsers();
                              notify(`User status set to ${next}.`, 'info');
                            }}
                            className="px-2.5 py-1 rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
                          >
                            {u.account_status === 'active' ? 'Suspend' : 'Restore'}
                          </button>
                          {isSuperAdmin && u.role === 'admin' && (
                            resetAdminId === u.id ? (
                              <div className="flex items-center gap-1">
                                <input
                                  type="password"
                                  value={resetAdminPassword}
                                  onChange={(e) => setResetAdminPassword(e.target.value)}
                                  placeholder="New password"
                                  className="w-32 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1 text-xs"
                                />
                                <button
                                  type="button"
                                  onClick={() => void handleResetAdminPassword(u.id)}
                                  className="px-2 py-1 rounded bg-slate-900 dark:bg-blue-600 text-white"
                                >
                                  Save
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setResetAdminId(null);
                                    setResetAdminPassword('');
                                  }}
                                  className="text-slate-500 px-1"
                                >
                                  Cancel
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() => {
                                  setResetAdminId(u.id);
                                  setResetAdminPassword('');
                                }}
                                className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
                              >
                                <KeyRound className="w-3 h-3" /> Reset Password
                              </button>
                            )
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}

      {/* PROFANITY DICTIONARY */}
      {tab === 'profanity' && (
        <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4">
          <div>
            <h2 className="text-sm font-semibold">Multilingual Profanity & Harassment Dictionary</h2>
            <p className="text-xs text-slate-500">
              Covers English, Nepali Devanagari (नेपाली), and Romanized Nepali with Unicode NFKC normalization and leetspeak detection.
            </p>
          </div>
          {isAdmin && (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                await api.post('/api/admin/profanity', { term: newTerm, language: newLang, severity: newSev });
                setNewTerm('');
                await loadProfanity();
                notify('Moderation term added.', 'success');
              }}
              className="flex flex-col sm:flex-row gap-2"
            >
              <input type="text" required value={newTerm} onChange={(e) => setNewTerm(e.target.value)} placeholder="Term (English, Devanagari, or Romanized)" className="flex-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-xs" />
              <select value={newLang} onChange={(e) => setNewLang(e.target.value as typeof newLang)} className="rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-xs">
                <option value="en">English</option>
                <option value="ne_romanized">Romanized Nepali</option>
                <option value="ne_devanagari">Nepali Devanagari</option>
              </select>
              <select value={newSev} onChange={(e) => setNewSev(e.target.value as typeof newSev)} className="rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-xs">
                <option value="low">Low (Flag)</option>
                <option value="medium">Medium (Flag)</option>
                <option value="high">High (Block)</option>
              </select>
              <button type="submit" className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-blue-600 text-white text-xs font-medium">Add Term</button>
            </form>
          )}
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {profanityList.map((p) => (
              <div key={p.id} className="py-2 flex items-center justify-between text-xs">
                <div>
                  <span className="font-mono font-semibold mr-2">{p.term}</span>
                  <span className="text-slate-500">{p.language} · severity: {p.severity}</span>
                  {p.context_exception_note && <span className="text-slate-400 ml-2">({p.context_exception_note})</span>}
                </div>
                {isAdmin && (
                  <button
                    type="button"
                    onClick={async () => {
                      await api.delete(`/api/admin/profanity/${p.id}`);
                      await loadProfanity();
                    }}
                    className="p-1 text-red-600"
                    aria-label="Remove term"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* AUDIT LOGS */}
      {tab === 'audit' && isAdmin && (
        <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3">
          <h2 className="text-sm font-semibold">Security & Administrative Audit Logs</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500">
                  <th className="py-2 pr-3">Time</th>
                  <th className="py-2 pr-3">Actor</th>
                  <th className="py-2 pr-3">Action</th>
                  <th className="py-2 pr-3">Target</th>
                  <th className="py-2">Metadata</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-mono">
                {auditLogs.map((l) => {
                  const metaText =
                    typeof l.metadata === 'string'
                      ? l.metadata
                      : l.metadata && Object.keys(l.metadata).length > 0
                        ? JSON.stringify(l.metadata)
                        : l.metadata_json || '';
                  return (
                    <tr key={l.id}>
                      <td className="py-2 pr-3 whitespace-nowrap">{new Date(l.created_at).toLocaleString()}</td>
                      <td className="py-2 pr-3 font-sans">{l.actor_name || 'System'}</td>
                      <td className="py-2 pr-3 font-semibold">{l.action}</td>
                      <td className="py-2 pr-3">{l.target_type}:{l.target_id.slice(0, 12)}</td>
                      <td className="py-2 text-slate-500 max-w-xs truncate">{metaText}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Super Admin Audited Vault Modal */}
      {vaultTargetId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
          <form onSubmit={handleVaultReveal} className="w-full max-w-md rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-4">
            <h3 className="text-base font-semibold">Super Admin Audited Identity Vault</h3>
            <p className="text-xs text-slate-500">
              Accessing a confession&apos;s isolated author mapping is logged permanently in the security audit trail. Provide justification:
            </p>
            <textarea
              rows={3}
              required
              minLength={10}
              value={vaultReason}
              onChange={(e) => setVaultReason(e.target.value)}
              placeholder="Safety, self-harm prevention, or legal compliance justification..."
              className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-xs"
            />
            {vaultResult && (
              <div className="p-3 rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 text-xs space-y-1">
                <div><strong>Display Name:</strong> {vaultResult.display_name}</div>
                <div><strong>Username:</strong> @{vaultResult.username}</div>
                <div><strong>Email:</strong> {vaultResult.email}</div>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setVaultTargetId(null)} className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-xs">
                Close
              </button>
              <button type="submit" className="px-4 py-1.5 rounded-lg bg-amber-700 text-white text-xs font-medium">
                Log Access & Reveal
              </button>
            </div>
          </form>
        </div>
      )}

      {inspectPdfModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 p-4">
          <div className="w-full max-w-5xl h-[86vh] rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex flex-col overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <span className="text-sm font-semibold text-slate-900 dark:text-white truncate">{inspectPdfModal.title}</span>
              <button
                type="button"
                onClick={() => {
                  URL.revokeObjectURL(inspectPdfModal.blobUrl);
                  setInspectPdfModal(null);
                }}
                className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800"
                aria-label="Close document preview"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            {inspectPdfModal.isImage ? (
              <div className="flex-1 overflow-auto flex items-center justify-center bg-slate-100 dark:bg-slate-950 p-4">
                <img
                  src={inspectPdfModal.blobUrl}
                  alt={inspectPdfModal.title}
                  className="max-h-full max-w-full object-contain rounded-lg"
                />
              </div>
            ) : (
              <iframe
                src={inspectPdfModal.blobUrl}
                title={inspectPdfModal.title}
                className="flex-1 w-full bg-slate-100 dark:bg-slate-950"
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
