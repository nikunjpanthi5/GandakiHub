import React, { useCallback, useEffect, useState } from 'react';
import {
  ArrowBigUp,
  Bookmark,
  ChevronRight,
  Download,
  Edit3,
  Eye,
  FileText,
  Flag,
  Folder,
  History,
  MessageSquare,
  Plus,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useApp } from '../../context/AppContext.tsx';
import { api, formatBytes, formatRelativeDate, formatRoleLabel } from '../../lib/api.ts';
import type { AcademicResource, Post, ResourceRevision } from '../../types/index.ts';
import { ImageAttachmentField } from '../common/ImageAttachmentField.tsx';

export function AcademicExplorer() {
  const { user, structure, communities, route, navigate, setAuthModalOpen, notify } = useApp();

  const [selectedProgramId, setSelectedProgramId] = useState<string>('');
  const [selectedSemesterId, setSelectedSemesterId] = useState<string>('');
  const [selectedSubjectId, setSelectedSubjectId] = useState<string>('');
  const [selectedFolderId, setSelectedFolderId] = useState<string>('');
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>('');
  const [sort, setSort] = useState<'newest' | 'downloads' | 'upvotes'>('newest');

  const [resources, setResources] = useState<AcademicResource[]>([]);
  const [loading, setLoading] = useState(true);

  // General Discussion posts when "General Discussion" category (pdf_only=false) is selected
  const [discussionPosts, setDiscussionPosts] = useState<Post[]>([]);
  const [loadingDiscussions, setLoadingDiscussions] = useState(false);
  const [discTitle, setDiscTitle] = useState('');
  const [discBody, setDiscBody] = useState('');
  const [discImageUrl, setDiscImageUrl] = useState<string | null>(null);
  const [postingDisc, setPostingDisc] = useState(false);

  const [uploadOpen, setUploadOpen] = useState(false);
  const [previewResource, setPreviewResource] = useState<AcademicResource | null>(null);
  const [previewBlobUrl, setPreviewBlobUrl] = useState<string>('');
  const [revisionsResource, setRevisionsResource] = useState<AcademicResource | null>(null);
  const [revisionsList, setRevisionsList] = useState<ResourceRevision[]>([]);
  const [editResource, setEditResource] = useState<AcademicResource | null>(null);

  useEffect(() => {
    if (!previewResource) {
      setPreviewBlobUrl('');
      return;
    }
    let active = true;
    let objectUrl = '';
    api
      .fetchBlob(`/api/academic/resources/${previewResource.id}/file`)
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setPreviewBlobUrl(objectUrl);
      })
      .catch((err) => {
        if (active) {
          notify(err instanceof Error ? err.message : 'Unable to preview PDF.', 'error');
          setPreviewResource(null);
        }
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [previewResource, notify]);

  async function handleDownloadPdf(resource: AcademicResource) {
    try {
      const blob = await api.fetchBlob(`/api/academic/resources/${resource.id}/file?download=1`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = resource.original_filename || `${resource.title}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Download failed.', 'error');
    }
  }

  // Upload form state
  const [upProg, setUpProg] = useState('');
  const [upSem, setUpSem] = useState('');
  const [upSubj, setUpSubj] = useState('');
  const [upCat, setUpCat] = useState('');
  const [upFolder, setUpFolder] = useState('');
  const [upTitle, setUpTitle] = useState('');
  const [upYear, setUpYear] = useState('2026');
  const [upDesc, setUpDesc] = useState('');
  const [upFile, setUpFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  // Edit form state
  const [editTitle, setEditTitle] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editFile, setEditFile] = useState<File | null>(null);

  // Sync URL query params into selectors
  useEffect(() => {
    if (route.query?.program) setSelectedProgramId(route.query.program);
    else if (!selectedProgramId && structure.programs.length > 0) {
      setSelectedProgramId(structure.programs[0].id);
    }
  }, [route.query?.program, structure.programs, selectedProgramId]);

  const semestersForProgram = structure.semesters.filter((s) => s.program_id === selectedProgramId);

  useEffect(() => {
    if (route.query?.semester) {
      setSelectedSemesterId(route.query.semester);
    } else if (semestersForProgram.length > 0 && !semestersForProgram.some((s) => s.id === selectedSemesterId)) {
      setSelectedSemesterId(semestersForProgram[0].id);
    }
  }, [route.query?.semester, semestersForProgram, selectedSemesterId]);

  const subjectsForSemester = structure.subjects.filter((sub) => sub.semester_id === selectedSemesterId);

  useEffect(() => {
    if (route.query?.subject) {
      setSelectedSubjectId(route.query.subject);
    } else if (selectedSubjectId && !subjectsForSemester.some((s) => s.id === selectedSubjectId)) {
      setSelectedSubjectId('');
    }
  }, [route.query?.subject, subjectsForSemester, selectedSubjectId]);

  const foldersForSubject = structure.folders.filter((f) => f.subject_id === selectedSubjectId);

  const activeCategory = structure.categories.find((c) => c.id === selectedCategoryId);
  const isGeneralDiscussion = Boolean(activeCategory && !activeCategory.pdf_only);

  const loadDiscussions = useCallback(async () => {
    if (!isGeneralDiscussion) return;
    setLoadingDiscussions(true);
    try {
      const qs = new URLSearchParams({ sort: 'latest' });
      if (selectedSubjectId) qs.set('subject_id', selectedSubjectId);
      else if (selectedProgramId) qs.set('program_id', selectedProgramId);
      const data = await api.get<{ posts: Post[] }>(`/api/posts?${qs.toString()}`);
      setDiscussionPosts(data.posts);
    } catch {
      setDiscussionPosts([]);
    } finally {
      setLoadingDiscussions(false);
    }
  }, [isGeneralDiscussion, selectedProgramId, selectedSubjectId]);

  const loadResources = useCallback(async () => {
    if (isGeneralDiscussion) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const qs = new URLSearchParams({ sort });
      if (selectedProgramId) qs.set('program_id', selectedProgramId);
      if (selectedSemesterId) qs.set('semester_id', selectedSemesterId);
      if (selectedSubjectId) qs.set('subject_id', selectedSubjectId);
      if (selectedFolderId) qs.set('folder_id', selectedFolderId);
      if (selectedCategoryId) qs.set('category_id', selectedCategoryId);
      const data = await api.get<{ resources: AcademicResource[] }>(`/api/academic/resources?${qs.toString()}`);
      setResources(data.resources);
    } catch {
      setResources([]);
    } finally {
      setLoading(false);
    }
  }, [isGeneralDiscussion, sort, selectedProgramId, selectedSemesterId, selectedSubjectId, selectedFolderId, selectedCategoryId]);

  useEffect(() => {
    void loadResources();
    void loadDiscussions();
  }, [loadResources, loadDiscussions]);

  function openUploadModal() {
    if (!user) {
      setAuthModalOpen(true);
      return;
    }
    const pId = selectedProgramId || structure.programs[0]?.id || '';
    const firstSem = structure.semesters.find((s) => s.program_id === pId)?.id || '';
    const sId = selectedSemesterId || firstSem;
    const firstSubj = structure.subjects.find((sb) => sb.semester_id === sId)?.id || '';
    setUpProg(pId);
    setUpSem(sId);
    setUpSubj(selectedSubjectId || firstSubj);
    setUpCat(selectedCategoryId || structure.categories[0]?.id || '');
    setUpFolder('');
    setUpTitle('');
    setUpDesc('');
    setUpFile(null);
    setUploadOpen(true);
  }

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    if (!upFile) {
      notify('Please choose a PDF file to upload.', 'error');
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('title', upTitle);
      fd.append('description', upDesc);
      fd.append('program_id', upProg);
      fd.append('semester_id', upSem);
      fd.append('subject_id', upSubj);
      fd.append('category_id', upCat);
      if (upFolder) fd.append('folder_id', upFolder);
      fd.append('academic_year', upYear);
      fd.append('file', upFile);

      const res = await api.upload<{ message: string }>('/api/academic/resources', fd);
      setUploadOpen(false);
      await loadResources();
      notify(res.message, 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Upload failed.', 'error');
    } finally {
      setUploading(false);
    }
  }

  async function openRevisions(resItem: AcademicResource) {
    setRevisionsResource(resItem);
    const data = await api.get<{ revisions: ResourceRevision[] }>(`/api/academic/resources/${resItem.id}/revisions`);
    setRevisionsList(data.revisions);
  }

  async function handleEditSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!editResource) return;
    const fd = new FormData();
    fd.append('title', editTitle);
    fd.append('description', editDesc);
    if (editFile) fd.append('file', editFile);
    try {
      const res = await api.upload<{ message: string }>(`/api/academic/resources/${editResource.id}`, fd, 'PUT');
      setEditResource(null);
      await loadResources();
      notify(res.message, 'info');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Update failed.', 'error');
    }
  }

  async function handleDelete(id: string) {
    await api.delete(`/api/academic/resources/${id}`);
    await loadResources();
    notify('Resource deleted.', 'info');
  }

  async function handleUpvote(id: string) {
    if (!user) return setAuthModalOpen(true);
    await api.post('/api/votes', { target_type: 'resource', target_id: id, value: 1 });
    await loadResources();
  }

  async function handleBookmark(id: string) {
    if (!user) return setAuthModalOpen(true);
    const res = await api.post<{ bookmarked: boolean }>('/api/bookmarks/toggle', { target_type: 'resource', target_id: id });
    setResources((prev) => prev.map((r) => (r.id === id ? { ...r, is_bookmarked: res.bookmarked } : r)));
  }

  async function handleReport(id: string) {
    if (!user) return setAuthModalOpen(true);
    await api.post('/api/reports', {
      target_type: 'resource',
      target_id: id,
      reason: 'Incorrect subject/category or low quality PDF',
    });
    notify('Resource flagged for moderator review.', 'info');
  }

  const activeProg = structure.programs.find((p) => p.id === selectedProgramId);
  const activeSem = structure.semesters.find((s) => s.id === selectedSemesterId);
  const activeSubj = structure.subjects.find((s) => s.id === selectedSubjectId);

  async function handleCreateDiscussionPost(e: React.FormEvent) {
    e.preventDefault();
    if (!user) {
      setAuthModalOpen(true);
      return;
    }
    if (!discTitle.trim() && !discBody.trim() && !discImageUrl) {
      notify('Please enter text or attach an image (or both) to post.', 'error');
      return;
    }
    const progSlug = activeProg ? activeProg.code.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
    const targetComm =
      communities.find((c) => c.slug === progSlug) ||
      communities.find((c) => c.slug === 'random') ||
      communities[0];
    if (!targetComm) {
      notify('No active community available for posting.', 'error');
      return;
    }
    setPostingDisc(true);
    try {
      await api.post('/api/posts', {
        community_id: targetComm.id,
        program_id: selectedProgramId || null,
        semester_id: selectedSemesterId || null,
        subject_id: selectedSubjectId || null,
        title: discTitle,
        body: discBody,
        image_url: discImageUrl,
        flair: activeCategory?.name || 'General Discussion',
        tags: activeSubj ? [activeSubj.code || activeSubj.name] : [],
      });
      setDiscTitle('');
      setDiscBody('');
      setDiscImageUrl(null);
      await loadDiscussions();
      notify('Discussion post published.', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to publish post.', 'error');
    } finally {
      setPostingDisc(false);
    }
  }

  const upSemesters = structure.semesters.filter((s) => s.program_id === upProg);
  const upSubjects = structure.subjects.filter((s) => s.semester_id === upSem);
  const upFolders = structure.folders.filter((f) => f.subject_id === upSubj);

  return (
    <div className="space-y-5">
      {/* Header & Breadcrumb */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
              <span>Academic Repository</span>
              {activeProg && (
                <>
                  <ChevronRight className="w-3.5 h-3.5" />
                  <span className="font-medium text-slate-800 dark:text-slate-200">{activeProg.code}</span>
                </>
              )}
              {activeSem && (
                <>
                  <ChevronRight className="w-3.5 h-3.5" />
                  <span>{activeSem.name}</span>
                </>
              )}
              {activeSubj && (
                <>
                  <ChevronRight className="w-3.5 h-3.5" />
                  <span className="font-medium text-blue-700 dark:text-blue-400">{activeSubj.name}</span>
                </>
              )}
            </div>
            <h1 className="font-display text-xl font-bold text-slate-900 dark:text-white mt-1">
              Hierarchical Academic Resources
            </h1>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Organized dynamically by Program, Semester, Subject, Subtopic Folder, and Category. Verified PDF-only uploads for Notes, Past Questions, and Projects.
            </p>
          </div>
          <button
            type="button"
            onClick={openUploadModal}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-slate-900 dark:bg-blue-600 text-white text-xs font-medium hover:bg-slate-800 dark:hover:bg-blue-500 whitespace-nowrap shrink-0"
          >
            <Upload className="w-3.5 h-3.5" />
            Upload PDF Resource
          </button>
        </div>

        {/* Dynamic Program Selector */}
        <div className="flex flex-wrap gap-1.5 pt-2 border-t border-slate-100 dark:border-slate-800">
          {structure.programs.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => {
                setSelectedProgramId(p.id);
                setSelectedSubjectId('');
                setSelectedFolderId('');
              }}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap ${
                selectedProgramId === p.id
                  ? 'bg-slate-900 text-white dark:bg-blue-600'
                  : 'border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
              }`}
            >
              {p.code}
            </button>
          ))}
        </div>

        {/* Dynamic Semester Selector */}
        <div className="flex flex-wrap gap-1.5">
          {semestersForProgram.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => {
                setSelectedSemesterId(s.id);
                setSelectedSubjectId('');
                setSelectedFolderId('');
              }}
              className={`px-2.5 py-1 rounded-md text-xs transition-colors whitespace-nowrap ${
                selectedSemesterId === s.id
                  ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-800 dark:text-blue-300 font-semibold border border-blue-200 dark:border-blue-800'
                  : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              {s.name}
            </button>
          ))}
        </div>

        {/* Subjects Grid */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
              Subjects in {activeSem?.name || 'Semester'}
            </span>
            {selectedSubjectId && (
              <button
                type="button"
                onClick={() => {
                  setSelectedSubjectId('');
                  setSelectedFolderId('');
                }}
                className="text-xs text-blue-700 dark:text-blue-400 hover:underline"
              >
                Show all subjects
              </button>
            )}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-2">
            {subjectsForSemester.map((sub) => (
              <button
                key={sub.id}
                type="button"
                onClick={() => {
                  setSelectedSubjectId(sub.id === selectedSubjectId ? '' : sub.id);
                  setSelectedFolderId('');
                }}
                className={`text-left p-3 rounded-lg border transition-colors ${
                  selectedSubjectId === sub.id
                    ? 'border-blue-600 bg-blue-50/70 dark:bg-blue-950/40'
                    : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'
                }`}
              >
                <div className="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate">{sub.name}</div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400 font-mono tabular-nums mt-0.5">
                  {sub.code || 'CODE'} · {sub.resource_count || 0} files
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Subtopic Folders when a subject is selected */}
        {selectedSubjectId && foldersForSubject.length > 0 && (
          <div className="pt-2 border-t border-slate-100 dark:border-slate-800 flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400 flex items-center gap-1">
              <Folder className="w-3.5 h-3.5" /> Folders:
            </span>
            <button
              type="button"
              onClick={() => setSelectedFolderId('')}
              className={`px-2.5 py-1 rounded text-xs ${
                !selectedFolderId ? 'bg-slate-900 text-white dark:bg-blue-600' : 'text-slate-600 dark:text-slate-300'
              }`}
            >
              All
            </button>
            {foldersForSubject.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setSelectedFolderId(f.id === selectedFolderId ? '' : f.id)}
                className={`px-2.5 py-1 rounded text-xs ${
                  selectedFolderId === f.id
                    ? 'bg-slate-900 text-white dark:bg-blue-600'
                    : 'border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300'
                }`}
              >
                {f.name}
              </button>
            ))}
          </div>
        )}

        {/* Categories & Sort */}
        <div className="pt-2 border-t border-slate-100 dark:border-slate-800 flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setSelectedCategoryId('')}
              className={`px-2.5 py-1 rounded text-xs font-medium ${
                !selectedCategoryId
                  ? 'bg-slate-900 text-white dark:bg-blue-600'
                  : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              All Categories
            </button>
            {structure.categories.map((cat) => (
              <button
                key={cat.id}
                type="button"
                onClick={() => setSelectedCategoryId(cat.id === selectedCategoryId ? '' : cat.id)}
                className={`px-2.5 py-1 rounded text-xs font-medium whitespace-nowrap ${
                  selectedCategoryId === cat.id
                    ? 'bg-slate-900 text-white dark:bg-blue-600'
                    : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                {cat.name}
              </button>
            ))}
          </div>

          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as 'newest' | 'downloads' | 'upvotes')}
            className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-1.5 text-xs font-medium shrink-0"
            aria-label="Sort resources"
          >
            <option value="newest">Sort: Newest</option>
            <option value="downloads">Sort: Most Downloaded</option>
            <option value="upvotes">Sort: Most Upvoted</option>
          </select>
        </div>
      </section>

      {/* General Discussion Posts OR PDF Resources */}
      {isGeneralDiscussion ? (
        <div className="space-y-4">
          <form onSubmit={handleCreateDiscussionPost} className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-slate-900 dark:text-white flex items-center gap-1.5">
                  <MessageSquare className="w-4 h-4 text-blue-700 dark:text-blue-400" />
                  {activeCategory?.name || 'General Discussion'}
                  {activeSubj ? ` — ${activeSubj.name}` : activeProg ? ` — ${activeProg.code}` : ''}
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Post questions, notes photos, or discussion prompts with text, an image, or both.
                </p>
              </div>
            </div>
            <input
              type="text"
              value={discTitle}
              onChange={(e) => setDiscTitle(e.target.value)}
              placeholder="Headline (optional if posting text or image)"
              className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-sm"
            />
            <textarea
              rows={3}
              value={discBody}
              onChange={(e) => setDiscBody(e.target.value)}
              placeholder="Write your post or question (optional if attaching an image)..."
              className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-sm"
            />
            <ImageAttachmentField
              imageUrl={discImageUrl}
              onChange={setDiscImageUrl}
              onError={(msg) => notify(msg, 'error')}
            />
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={postingDisc}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-slate-900 dark:bg-blue-600 text-white text-xs font-medium disabled:opacity-50"
              >
                <Plus className="w-3.5 h-3.5" />
                {postingDisc ? 'Publishing...' : 'Publish Post'}
              </button>
            </div>
          </form>

          {loadingDiscussions ? (
            <div className="h-28 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 animate-pulse" />
          ) : discussionPosts.length === 0 ? (
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-8 text-center text-xs text-slate-500">
              No discussion posts for this {activeSubj ? 'subject' : 'program'} yet. Start the conversation above!
            </div>
          ) : (
            <div className="space-y-3">
              {discussionPosts.map((post) => (
                <article
                  key={post.id}
                  className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-2.5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-semibold text-slate-800 dark:text-slate-200">{post.author_name}</span>
                      <span>·</span>
                      <span>{formatRoleLabel(post.author_role)}</span>
                      {post.subject_name && (
                        <>
                          <span>·</span>
                          <span className="text-blue-700 dark:text-blue-400 font-medium">{post.subject_name}</span>
                        </>
                      )}
                      <span>·</span>
                      <span className="font-mono">{formatRelativeDate(post.created_at)}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => navigate('communities', post.community_slug)}
                      className="text-blue-700 dark:text-blue-400 hover:underline"
                    >
                      Open in {post.community_name}
                    </button>
                  </div>

                  {post.title && (
                    <h3 className="font-display text-base font-semibold text-slate-900 dark:text-white">{post.title}</h3>
                  )}
                  {post.body && (
                    <p className="text-sm text-slate-700 dark:text-slate-300 whitespace-pre-wrap">{post.body}</p>
                  )}
                  {post.image_url && (
                    <img
                      src={post.image_url}
                      alt={post.title || 'Discussion attachment'}
                      className="max-h-96 w-auto rounded-lg border border-slate-200 dark:border-slate-800 object-contain bg-slate-50 dark:bg-slate-950"
                    />
                  )}

                  <div className="flex items-center gap-3 pt-2 border-t border-slate-100 dark:border-slate-800 text-xs text-slate-500">
                    <button
                      type="button"
                      onClick={async () => {
                        if (!user) return setAuthModalOpen(true);
                        await api.post('/api/votes', { target_type: 'post', target_id: post.id, value: 1 });
                        await loadDiscussions();
                      }}
                      className={`inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-200 dark:border-slate-700 font-mono tabular-nums ${
                        post.user_vote === 1 ? 'text-blue-700 dark:text-blue-400 border-blue-600 font-semibold' : ''
                      }`}
                    >
                      <ArrowBigUp className="w-3.5 h-3.5" />
                      {post.score}
                    </button>
                    <button
                      type="button"
                      onClick={() => navigate('communities', post.community_slug)}
                      className="inline-flex items-center gap-1 hover:underline"
                    >
                      <MessageSquare className="w-3.5 h-3.5" />
                      {post.comment_count} comments
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      ) : loading ? (
        <div className="space-y-3">
          {[1, 2].map((i) => (
            <div key={i} className="h-28 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 animate-pulse" />
          ))}
        </div>
      ) : resources.length === 0 ? (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-8 text-center space-y-2">
          <p className="text-sm font-medium text-slate-900 dark:text-white">No resources found in this selection</p>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Select another semester or upload a PDF document for this subject.
          </p>
          <button
            type="button"
            onClick={openUploadModal}
            className="mt-2 inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-slate-900 dark:bg-blue-600 text-white text-xs font-medium"
          >
            <Upload className="w-3.5 h-3.5" />
            Upload First PDF
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {resources.map((r) => {
            const isOwner = user?.id === r.uploader_id;
            const canDelete = isOwner || (user && ['super_admin', 'admin'].includes(user.role));
            return (
              <div
                key={r.id}
                className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
              >
                <div className="min-w-0 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                    <span className="font-semibold text-blue-700 dark:text-blue-400">{r.category_name}</span>
                    <span>·</span>
                    <span>{r.program_code}</span>
                    <span>·</span>
                    <span>{r.semester_name}</span>
                    <span>·</span>
                    <span className="font-medium text-slate-700 dark:text-slate-300">{r.subject_name}</span>
                    {r.folder_name && (
                      <>
                        <span>·</span>
                        <span>{r.folder_name}</span>
                      </>
                    )}
                    {r.status !== 'approved' && (
                      <>
                        <span>·</span>
                        <span className="font-medium text-amber-700 dark:text-amber-400">
                          Status: {r.status}
                        </span>
                      </>
                    )}
                    {r.has_pending_revision && (
                      <>
                        <span>·</span>
                        <span className="font-medium text-amber-700 dark:text-amber-400">
                          Revision under review
                        </span>
                      </>
                    )}
                  </div>

                  <h3 className="font-display text-base font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                    <FileText className="w-4 h-4 text-slate-400 shrink-0" />
                    <span className="truncate">{r.title}</span>
                  </h3>
                  <p className="text-xs text-slate-600 dark:text-slate-300 line-clamp-2">{r.description}</p>

                  <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400 font-mono tabular-nums pt-0.5">
                    <span>Uploaded by {r.uploader_name}</span>
                    <span>·</span>
                    <span>Year {r.academic_year || 'N/A'}</span>
                    <span>·</span>
                    <span>{formatBytes(r.file_size)}</span>
                    <span>·</span>
                    <span>{r.download_count} downloads</span>
                    <span>·</span>
                    <span>v{r.revision_number}</span>
                    <span>·</span>
                    <span>{formatRelativeDate(r.created_at)}</span>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => void handleUpvote(r.id)}
                    className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border text-xs font-mono tabular-nums ${
                      r.user_vote === 1
                        ? 'border-blue-600 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-400 font-semibold'
                        : 'border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300'
                    }`}
                  >
                    <ArrowBigUp className="w-3.5 h-3.5" />
                    {r.upvote_count}
                  </button>

                  <button
                    type="button"
                    onClick={() => setPreviewResource(r)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    <Eye className="w-3.5 h-3.5" />
                    Preview
                  </button>

                  <button
                    type="button"
                    onClick={() => void handleDownloadPdf(r)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 dark:bg-blue-600 text-white text-xs font-medium hover:bg-slate-800 dark:hover:bg-blue-500"
                  >
                    <Download className="w-3.5 h-3.5" />
                    PDF
                  </button>

                  <button
                    type="button"
                    onClick={() => void openRevisions(r)}
                    className="p-2 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
                    title="Revision history"
                    aria-label="Revision history"
                  >
                    <History className="w-3.5 h-3.5" />
                  </button>

                  <button
                    type="button"
                    onClick={() => void handleBookmark(r.id)}
                    className={`p-2 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 ${
                      r.is_bookmarked ? 'text-blue-700 dark:text-blue-400' : 'text-slate-500'
                    }`}
                    aria-label="Bookmark resource"
                  >
                    <Bookmark className="w-3.5 h-3.5" />
                  </button>

                  {isOwner && (
                    <button
                      type="button"
                      onClick={() => {
                        setEditResource(r);
                        setEditTitle(r.title);
                        setEditDesc(r.description);
                        setEditFile(null);
                      }}
                      className="p-2 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
                      title="Edit resource"
                    >
                      <Edit3 className="w-3.5 h-3.5" />
                    </button>
                  )}

                  {canDelete && (
                    <button
                      type="button"
                      onClick={() => void handleDelete(r.id)}
                      className="p-2 rounded-lg border border-slate-200 dark:border-slate-700 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40"
                      aria-label="Delete resource"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => void handleReport(r.id)}
                    className="p-2 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800"
                    aria-label="Report resource"
                  >
                    <Flag className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Upload PDF Modal */}
      {uploadOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
          <div className="w-full max-w-xl rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xl overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-slate-800">
              <div>
                <h2 className="text-base font-semibold text-slate-900 dark:text-white">Upload Academic PDF Resource</h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Server-verified PDF-only (max 10 MB). Enters moderator review before publishing.
                </p>
              </div>
              <button type="button" onClick={() => setUploadOpen(false)} className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleUpload} className="p-6 space-y-3.5 max-h-[80vh] overflow-y-auto">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium mb-1">Program</label>
                  <select
                    required
                    value={upProg}
                    onChange={(e) => {
                      const p = e.target.value;
                      setUpProg(p);
                      const firstSem = structure.semesters.find((s) => s.program_id === p)?.id || '';
                      setUpSem(firstSem);
                      const firstSubj = structure.subjects.find((sb) => sb.semester_id === firstSem)?.id || '';
                      setUpSubj(firstSubj);
                    }}
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm"
                  >
                    {structure.programs.map((p) => (
                      <option key={p.id} value={p.id}>{p.code} — {p.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Semester</label>
                  <select
                    required
                    value={upSem}
                    onChange={(e) => {
                      const s = e.target.value;
                      setUpSem(s);
                      const firstSubj = structure.subjects.find((sb) => sb.semester_id === s)?.id || '';
                      setUpSubj(firstSubj);
                    }}
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm"
                  >
                    {upSemesters.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium mb-1">Subject</label>
                  <select
                    required
                    value={upSubj}
                    onChange={(e) => {
                      setUpSubj(e.target.value);
                      setUpFolder('');
                    }}
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm"
                  >
                    {upSubjects.map((sb) => (
                      <option key={sb.id} value={sb.id}>{sb.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Category</label>
                  <select
                    required
                    value={upCat}
                    onChange={(e) => setUpCat(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm"
                  >
                    {structure.categories.filter((c) => c.pdf_only).map((c) => (
                      <option key={c.id} value={c.id}>{c.name} (PDF only)</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium mb-1">Subtopic Folder (Optional)</label>
                  <select
                    value={upFolder}
                    onChange={(e) => setUpFolder(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm"
                  >
                    <option value="">Root of Subject</option>
                    {upFolders.map((f) => (
                      <option key={f.id} value={f.id}>{f.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Academic / Exam Year</label>
                  <input
                    type="text"
                    required
                    value={upYear}
                    onChange={(e) => setUpYear(e.target.value)}
                    placeholder="2026"
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium mb-1">Document Title (Meaningful & Specific)</label>
                <input
                  type="text"
                  required
                  value={upTitle}
                  onChange={(e) => setUpTitle(e.target.value)}
                  placeholder="e.g. Data Science — Unit 1 Notes or 2025 Final Examination"
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-medium mb-1">Short Description</label>
                <textarea
                  rows={2}
                  required
                  value={upDesc}
                  onChange={(e) => setUpDesc(e.target.value)}
                  placeholder="Summarize what chapters, topics, or exam sections are covered..."
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-medium mb-1">PDF File (.pdf only, max 10 MB)</label>
                <input
                  type="file"
                  accept=".pdf,application/pdf"
                  required
                  onChange={(e) => setUpFile(e.target.files?.[0] || null)}
                  className="w-full text-xs file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-slate-100 dark:file:bg-slate-800 file:text-slate-900 dark:file:text-slate-100"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setUploadOpen(false)} className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-xs">
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={uploading}
                  className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-blue-600 text-white text-xs font-medium disabled:opacity-50"
                >
                  {uploading ? 'Validating & Uploading...' : 'Submit for Review'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* PDF Preview Modal */}
      {previewResource && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4">
          <div className="w-full max-w-4xl h-[85vh] rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 dark:border-slate-800">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-slate-900 dark:text-white truncate">{previewResource.title}</h3>
                <p className="text-xs text-slate-500">
                  {previewResource.program_code} · {previewResource.subject_name} · {previewResource.category_name}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => void handleDownloadPdf(previewResource)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 dark:bg-blue-600 text-white text-xs font-medium"
                >
                  <Download className="w-3.5 h-3.5" />
                  Download
                </button>
                <button type="button" onClick={() => setPreviewResource(null)} className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800">
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            {previewBlobUrl ? (
              <iframe
                src={previewBlobUrl}
                title={previewResource.title}
                className="flex-1 w-full bg-slate-100 dark:bg-slate-950"
              />
            ) : (
              <div className="flex-1 flex items-center justify-center text-xs text-slate-500">
                Loading PDF preview...
              </div>
            )}
          </div>
        </div>
      )}

      {/* Revision History Modal */}
      {revisionsResource && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
          <div className="w-full max-w-lg rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold">Revision History</h3>
              <button type="button" onClick={() => setRevisionsResource(null)} className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800">
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs text-slate-500">{revisionsResource.title}</p>
            <div className="space-y-2 max-h-72 overflow-y-auto">
              {revisionsList.map((rev) => (
                <div key={rev.id} className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 text-xs space-y-1">
                  <div className="flex items-center justify-between font-medium">
                    <span className="font-mono">Revision v{rev.revision_number}</span>
                    <span>{rev.status}</span>
                  </div>
                  <div className="text-slate-500">{rev.original_filename} · {formatBytes(rev.file_size)}</div>
                  {rev.review_notes && <div className="text-slate-600 dark:text-slate-300">Note: {rev.review_notes}</div>}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Edit Resource Modal */}
      {editResource && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
          <form onSubmit={handleEditSubmit} className="w-full max-w-lg rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold">Edit Resource</h3>
              <button type="button" onClick={() => setEditResource(null)} className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800">
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs text-slate-500">
              Updates to an already-approved resource enter review while keeping the previously approved PDF available.
            </p>
            <div>
              <label className="block text-xs font-medium mb-1">Title</label>
              <input
                type="text"
                required
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Description</label>
              <textarea
                rows={3}
                required
                value={editDesc}
                onChange={(e) => setEditDesc(e.target.value)}
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Replacement PDF (Optional)</label>
              <input
                type="file"
                accept=".pdf,application/pdf"
                onChange={(e) => setEditFile(e.target.files?.[0] || null)}
                className="w-full text-xs"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setEditResource(null)} className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-xs">
                Cancel
              </button>
              <button type="submit" className="px-4 py-1.5 rounded-lg bg-slate-900 dark:bg-blue-600 text-white text-xs font-medium">
                Submit Update
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
