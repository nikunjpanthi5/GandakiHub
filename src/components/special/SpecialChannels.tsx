import React, { useCallback, useEffect, useState } from 'react';
import {
  ArrowBigUp,
  Briefcase,
  Calendar,
  ExternalLink,
  FileWarning,
  GraduationCap,
  HeartHandshake,
  Lightbulb,
  Lock,
  Plus,
} from 'lucide-react';
import { useApp } from '../../context/AppContext.tsx';
import { api, formatRelativeDate } from '../../lib/api.ts';
import type {
  Complaint,
  Confession,
  DonationRequest,
  Idea,
  Opportunity,
  StudyGroup,
  UniversityEvent,
} from '../../types/index.ts';
import { ImageAttachmentField } from '../common/ImageAttachmentField.tsx';

interface ConfessionWithComments extends Confession {
  comments: Array<{ id: string; alias_label: string; body: string; created_at: string }>;
}

// ================= CONFESSIONS =================
export function ConfessionsView() {
  const { user, setAuthModalOpen, notify } = useApp();
  const [items, setItems] = useState<ConfessionWithComments[]>([]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [category, setCategory] = useState('Campus Life');
  const [commentMap, setCommentMap] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const data = await api.get<{ confessions: ConfessionWithComments[] }>('/api/confessions');
    setItems(data.confessions);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return setAuthModalOpen(true);
    if (!title.trim() && !body.trim() && !imageUrl) {
      notify('Please include text or attach an image (or both).', 'error');
      return;
    }
    try {
      const res = await api.post<{ message: string }>('/api/confessions', {
        title,
        body,
        image_url: imageUrl,
        category,
      });
      setTitle('');
      setBody('');
      setImageUrl(null);
      notify(res.message, 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Submission failed.', 'error');
    }
  }

  async function react(id: string, reaction: 'support' | 'relate') {
    if (!user) return setAuthModalOpen(true);
    await api.post(`/api/confessions/${id}/react`, { reaction });
    await load();
  }

  async function addComment(id: string) {
    if (!user) return setAuthModalOpen(true);
    const text = (commentMap[id] || '').trim();
    if (!text) return;
    try {
      await api.post(`/api/confessions/${id}/comments`, { body: text });
      setCommentMap((prev) => ({ ...prev, [id]: '' }));
      await load();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Could not post comment.', 'error');
    }
  }

  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-2">
        <h1 className="font-display text-xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
          <Lock className="w-5 h-5 text-blue-700 dark:text-blue-400" />
          Anonymous Confessions
        </h1>
        <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
          Submissions enter moderator review before publication and are published without author identity in public feeds or search. Author mappings are isolated in a Super-Admin-only audited vault for legal/safety emergencies; absolute technical anonymity against compromised devices or infrastructure operators cannot be guaranteed.
        </p>
      </section>

      <form onSubmit={handleSubmit} className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3">
        <div className="flex flex-col sm:flex-row gap-3">
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Confession headline (optional if posting image or text)..."
            className="flex-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-sm"
          />
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-sm"
          >
            <option>Campus Life</option>
            <option>Academics</option>
            <option>Gratitude</option>
            <option>Advice</option>
          </select>
        </div>
        <textarea
          rows={3}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Share anonymously (optional if attaching an image)..."
          className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-sm"
        />
        <ImageAttachmentField
          imageUrl={imageUrl}
          onChange={setImageUrl}
          onError={(msg) => notify(msg, 'error')}
        />
        <div className="flex justify-end">
          <button type="submit" className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-blue-600 text-white text-xs font-medium">
            Submit to Moderation Queue
          </button>
        </div>
      </form>

      <div className="space-y-4">
        {items.length === 0 ? (
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-8 text-center text-xs text-slate-500">
            No approved confessions published yet.
          </div>
        ) : (
          items.map((c) => (
          <article key={c.id} className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3">
            <div className="text-xs text-slate-500 dark:text-slate-400">
              <span>{c.category}</span>
              <span> · </span>
              <span>Anonymous Student</span>
              <span> · </span>
              <span className="font-mono">{formatRelativeDate(c.created_at)}</span>
            </div>
            {c.title && <h2 className="font-display text-base font-semibold text-slate-900 dark:text-white">{c.title}</h2>}
            {c.body && <p className="text-sm text-slate-700 dark:text-slate-300 whitespace-pre-wrap">{c.body}</p>}
            {c.image_url && (
              <img
                src={c.image_url}
                alt={c.title || 'Confession attachment'}
                className="max-h-96 w-auto rounded-lg border border-slate-200 dark:border-slate-800 object-contain bg-slate-50 dark:bg-slate-950"
              />
            )}
            <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-slate-100 dark:border-slate-800 text-xs">
              <button type="button" onClick={() => void react(c.id, 'support')} className="px-3 py-1 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 font-mono tabular-nums">
                Support ({c.reaction_support})
              </button>
              <button type="button" onClick={() => void react(c.id, 'relate')} className="px-3 py-1 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 font-mono tabular-nums">
                Relate ({c.reaction_relate})
              </button>
            </div>
            <div className="space-y-2 pt-2">
              {c.comments.map((cm) => (
                <div key={cm.id} className="text-xs text-slate-700 dark:text-slate-300 pl-3 border-l border-slate-200 dark:border-slate-800">
                  <span className="font-medium">{cm.alias_label}: </span>
                  {cm.body}
                </div>
              ))}
              <div className="flex gap-2">
                <input
                  type="text"
                  value={commentMap[c.id] || ''}
                  onChange={(e) => setCommentMap((prev) => ({ ...prev, [c.id]: e.target.value }))}
                  placeholder="Reply anonymously..."
                  className="flex-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-1.5 text-xs"
                />
                <button type="button" onClick={() => void addComment(c.id)} className="px-3 py-1.5 rounded-lg bg-slate-900 dark:bg-blue-600 text-white text-xs">
                  Reply
                </button>
              </div>
            </div>
          </article>
          ))
        )}
      </div>
    </div>
  );
}

// ================= COMPLAINTS & SUGGESTIONS =================
export function ComplaintsView() {
  const { user, setAuthModalOpen, notify } = useApp();
  const [items, setItems] = useState<Complaint[]>([]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [category, setCategory] = useState('Facilities');
  const [isPrivate, setIsPrivate] = useState(false);

  const load = useCallback(async () => {
    const data = await api.get<{ complaints: Complaint[] }>('/api/complaints');
    setItems(data.complaints);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return setAuthModalOpen(true);
    if (!title.trim() && !body.trim() && !imageUrl) {
      notify('Please include text or attach an image (or both).', 'error');
      return;
    }
    try {
      await api.post('/api/complaints', {
        title,
        body,
        image_url: imageUrl,
        category,
        is_private: isPrivate,
      });
      setTitle('');
      setBody('');
      setImageUrl(null);
      await load();
      notify(isPrivate ? 'Private complaint submitted securely to handlers.' : 'Public feedback submitted.', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Submission failed.', 'error');
    }
  }

  async function updateStatus(id: string, status: Complaint['status']) {
    await api.patch(`/api/complaints/${id}`, { status });
    await load();
    notify('Complaint status updated.', 'info');
  }

  const isStaff = user && ['super_admin', 'admin'].includes(user.role);

  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-1.5">
        <h1 className="font-display text-xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
          <FileWarning className="w-5 h-5 text-blue-700 dark:text-blue-400" />
          Complaints & Suggestions
        </h1>
        <p className="text-xs text-slate-600 dark:text-slate-300">
          Submit public campus suggestions or private complaints. Private complaints are strictly visible only to you and assigned complaint handlers, and are excluded from search and trending.
        </p>
      </section>

      <form onSubmit={handleSubmit} className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Issue or suggestion title (optional if posting image/text)..."
            className="sm:col-span-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-sm"
          />
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-sm"
          >
            <option>Facilities</option>
            <option>Academic Concern</option>
            <option>IT & Labs</option>
            <option>Student Welfare</option>
            <option>Platform Suggestion</option>
          </select>
        </div>
        <textarea
          rows={3}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Describe the issue, location, or suggestion (optional if attaching an image)..."
          className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-sm"
        />
        <ImageAttachmentField
          imageUrl={imageUrl}
          onChange={setImageUrl}
          onError={(msg) => notify(msg, 'error')}
        />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 dark:text-slate-300">
            <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} />
            Make this a Private Complaint (visible only to handlers & you)
          </label>
          <button type="submit" className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-blue-600 text-white text-xs font-medium">
            Submit Ticket
          </button>
        </div>
      </form>

      <div className="space-y-3">
        {items.length === 0 ? (
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-8 text-center text-xs text-slate-500">
            No complaints or suggestions submitted yet.
          </div>
        ) : (
          items.map((c) => (
          <div key={c.id} className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-slate-700 dark:text-slate-300">{c.category}</span>
                <span>·</span>
                <span>{c.is_private ? 'Private Ticket' : 'Public'}</span>
                <span>·</span>
                <span className="font-mono">{formatRelativeDate(c.created_at)}</span>
              </div>
              <span className="font-mono font-semibold text-blue-700 dark:text-blue-400">
                Status: {c.status.replace('_', ' ')}
              </span>
            </div>
            {c.title && <h3 className="font-display text-base font-semibold text-slate-900 dark:text-white">{c.title}</h3>}
            {c.body && <p className="text-sm text-slate-700 dark:text-slate-300 whitespace-pre-wrap">{c.body}</p>}
            {c.image_url && (
              <img
                src={c.image_url}
                alt={c.title || 'Complaint attachment'}
                className="max-h-96 w-auto rounded-lg border border-slate-200 dark:border-slate-800 object-contain bg-slate-50 dark:bg-slate-950"
              />
            )}
            {c.handler_notes && (
              <p className="text-xs text-slate-600 dark:text-slate-400 pt-2 border-t border-slate-100 dark:border-slate-800">
                Handler note: {c.handler_notes}
              </p>
            )}
            {isStaff && (
              <div className="pt-2 flex flex-wrap items-center gap-2">
                <span className="text-xs text-slate-500">Update status:</span>
                {(['submitted', 'under_review', 'in_progress', 'resolved', 'rejected'] as const).map((st) => (
                  <button
                    key={st}
                    type="button"
                    onClick={() => void updateStatus(c.id, st)}
                    className={`px-2 py-1 rounded text-xs border ${
                      c.status === st
                        ? 'bg-slate-900 text-white border-slate-900 dark:bg-blue-600 dark:border-blue-600'
                        : 'border-slate-200 dark:border-slate-700'
                    }`}
                  >
                    {st.replace('_', ' ')}
                  </button>
                ))}
              </div>
            )}
          </div>
          ))
        )}
      </div>
    </div>
  );
}

// ================= GETIDEAS =================
export function IdeasView() {
  const { user, setAuthModalOpen, notify } = useApp();
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState('');
  const [problem, setProblem] = useState('');
  const [solution, setSolution] = useState('');
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [collab, setCollab] = useState('');

  const load = useCallback(async () => {
    const data = await api.get<{ ideas: Idea[] }>('/api/ideas');
    setIdeas(data.ideas);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() && !problem.trim() && !solution.trim() && !imageUrl) {
      notify('Please describe your idea or attach an image (or both).', 'error');
      return;
    }
    try {
      await api.post('/api/ideas', {
        title,
        problem_statement: problem,
        proposed_solution: solution,
        image_url: imageUrl,
        collaborators_needed: collab,
        status: collab.trim() ? 'looking_for_collaborators' : 'new_idea',
      });
      setTitle('');
      setProblem('');
      setSolution('');
      setImageUrl(null);
      setCollab('');
      setShowForm(false);
      await load();
      notify('Idea published to GetIdeas.', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to submit idea.', 'error');
    }
  }

  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <Lightbulb className="w-5 h-5 text-amber-600" />
            GetIdeas — Campus Innovation Board
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Propose student software tools, campus improvements, and recruit teammates across departments.
          </p>
        </div>
        <button
          type="button"
          onClick={() => (user ? setShowForm((s) => !s) : setAuthModalOpen(true))}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-slate-900 dark:bg-blue-600 text-white text-xs font-medium shrink-0"
        >
          <Plus className="w-3.5 h-3.5" /> Propose Idea
        </button>
      </section>

      {showForm && (
        <form onSubmit={handleSubmit} className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3">
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Project or Idea Title (optional if posting image/text)" className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-sm" />
          <textarea rows={2} value={problem} onChange={(e) => setProblem(e.target.value)} placeholder="Problem statement (optional if attaching an image)..." className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-sm" />
          <textarea rows={2} value={solution} onChange={(e) => setSolution(e.target.value)} placeholder="Proposed solution (optional if attaching an image)..." className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-sm" />
          <ImageAttachmentField
            imageUrl={imageUrl}
            onChange={setImageUrl}
            onError={(msg) => notify(msg, 'error')}
          />
          <input type="text" value={collab} onChange={(e) => setCollab(e.target.value)} placeholder="Collaborators needed (e.g. 2 developers, 1 designer)" className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-sm" />
          <div className="flex justify-end">
            <button type="submit" className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-blue-600 text-white text-xs font-medium">Publish Idea</button>
          </div>
        </form>
      )}

      <div className="space-y-4">
        {ideas.length === 0 ? (
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-8 text-center text-xs text-slate-500">
            No ideas posted yet.
          </div>
        ) : (
          ideas.map((idea) => (
          <div key={idea.id} className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
              <span>{idea.author_name} · {formatRelativeDate(idea.created_at)}</span>
              <span className="font-mono font-medium text-blue-700 dark:text-blue-400">{idea.status.replace(/_/g, ' ')}</span>
            </div>
            {idea.title && <h2 className="font-display text-base font-semibold text-slate-900 dark:text-white">{idea.title}</h2>}
            {idea.problem_statement && <p className="text-xs text-slate-700 dark:text-slate-300"><strong>Problem:</strong> {idea.problem_statement}</p>}
            {idea.proposed_solution && <p className="text-xs text-slate-700 dark:text-slate-300"><strong>Solution:</strong> {idea.proposed_solution}</p>}
            {idea.image_url && (
              <img
                src={idea.image_url}
                alt={idea.title || 'Idea sketch or diagram'}
                className="max-h-96 w-auto rounded-lg border border-slate-200 dark:border-slate-800 object-contain bg-slate-50 dark:bg-slate-950"
              />
            )}
            {idea.collaborators_needed && (
              <p className="text-xs text-slate-600 dark:text-slate-400"><strong>Looking for:</strong> {idea.collaborators_needed}</p>
            )}
            <div className="flex items-center gap-3 pt-2 border-t border-slate-100 dark:border-slate-800 text-xs">
              <button
                type="button"
                onClick={async () => {
                  if (!user) return setAuthModalOpen(true);
                  await api.post('/api/votes', { target_type: 'idea', target_id: idea.id, value: 1 });
                  await load();
                }}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-slate-200 dark:border-slate-700 font-mono tabular-nums"
              >
                <ArrowBigUp className="w-3.5 h-3.5" /> {idea.upvote_count}
              </button>
              <button
                type="button"
                onClick={async () => {
                  if (!user) return setAuthModalOpen(true);
                  await api.post(`/api/ideas/${idea.id}/follow`);
                  await load();
                }}
                className={`px-3 py-1 rounded-lg border text-xs ${
                  idea.is_following ? 'border-blue-600 text-blue-700 dark:text-blue-400 font-medium' : 'border-slate-200 dark:border-slate-700'
                }`}
              >
                {idea.is_following ? 'Following' : 'Follow'} ({idea.follower_count})
              </button>
            </div>
          </div>
          ))
        )}
      </div>
    </div>
  );
}

// ================= STUDENT DONATIONS =================
export function DonationsView() {
  const { user, setAuthModalOpen, notify } = useApp();
  const [items, setItems] = useState<DonationRequest[]>([]);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('Textbooks & Lab Gear');
  const [description, setDescription] = useState('');
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [contact, setContact] = useState('Reach via GandakiHub connection request');

  const load = useCallback(async () => {
    const data = await api.get<{ donations: DonationRequest[] }>('/api/donations');
    setItems(data.donations);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return setAuthModalOpen(true);
    if (!title.trim() && !description.trim() && !imageUrl) {
      notify('Please include text or attach an image (or both).', 'error');
      return;
    }
    try {
      const res = await api.post<{ message: string }>('/api/donations', {
        title,
        category,
        description,
        image_url: imageUrl,
        contact_method: contact,
      });
      setTitle('');
      setDescription('');
      setImageUrl(null);
      await load();
      notify(res.message, 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Request failed.', 'error');
    }
  }

  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-1.5">
        <h1 className="font-display text-xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
          <HeartHandshake className="w-5 h-5 text-blue-700 dark:text-blue-400" />
          Student Donations & Peer Support
        </h1>
        <p className="text-xs text-slate-600 dark:text-slate-300">
          Moderated requests for textbooks, calculators, lab coats, or peer assistance. GandakiHub does not hold or process financial transactions, and sensitive medical, banking, or ID documents are never published.
        </p>
      </section>

      <form onSubmit={handleSubmit} className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What assistance is needed? (optional if image)" className="rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-sm" />
          <select value={category} onChange={(e) => setCategory(e.target.value)} className="rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-sm">
            <option>Textbooks & Lab Gear</option>
            <option>Computing Equipment</option>
            <option>Academic Support</option>
            <option>Emergency Peer Aid</option>
          </select>
        </div>
        <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Describe your request (optional if attaching an image)..." className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-sm" />
        <ImageAttachmentField
          imageUrl={imageUrl}
          onChange={setImageUrl}
          onError={(msg) => notify(msg, 'error')}
        />
        <div className="flex flex-col sm:flex-row gap-3 items-center justify-between">
          <input type="text" value={contact} onChange={(e) => setContact(e.target.value)} className="w-full sm:flex-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-xs" />
          <button type="submit" className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-blue-600 text-white text-xs font-medium shrink-0">Submit for Verification</button>
        </div>
      </form>

      <div className="space-y-3">
        {items.length === 0 ? (
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-8 text-center text-xs text-slate-500">
            No approved student support requests yet.
          </div>
        ) : (
          items.map((d) => (
          <div key={d.id} className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-2">
            <div className="flex items-center justify-between text-xs text-slate-500">
              <span>{d.category} · Requested by {d.requester_name}</span>
              <span className="font-mono text-blue-700 dark:text-blue-400">{d.status}</span>
            </div>
            {d.title && <h2 className="font-display text-base font-semibold text-slate-900 dark:text-white">{d.title}</h2>}
            {d.description && <p className="text-sm text-slate-700 dark:text-slate-300 whitespace-pre-wrap">{d.description}</p>}
            {d.image_url && (
              <img
                src={d.image_url}
                alt={d.title || 'Donation request attachment'}
                className="max-h-96 w-auto rounded-lg border border-slate-200 dark:border-slate-800 object-contain bg-slate-50 dark:bg-slate-950"
              />
            )}
            <p className="text-xs text-slate-500">Contact: {d.contact_method}</p>
            {d.verification_notes && <p className="text-xs text-emerald-700 dark:text-emerald-400">{d.verification_notes}</p>}
          </div>
          ))
        )}
      </div>
    </div>
  );
}

// ================= OPPORTUNITIES =================
export function OpportunitiesView() {
  const { user, setAuthModalOpen, notify } = useApp();
  const [items, setItems] = useState<Opportunity[]>([]);
  const [kindFilter, setKindFilter] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [kind, setKind] = useState<Opportunity['kind']>('internship');
  const [title, setTitle] = useState('');
  const [org, setOrg] = useState('');
  const [desc, setDesc] = useState('');
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [elig, setElig] = useState('');
  const [deadline, setDeadline] = useState('2026-12-30');
  const [url, setUrl] = useState('');

  const load = useCallback(async () => {
    const qs = kindFilter ? `?kind=${kindFilter}` : '';
    const data = await api.get<{ opportunities: Opportunity[] }>(`/api/opportunities${qs}`);
    setItems(data.opportunities);
  }, [kindFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() && !desc.trim() && !imageUrl) {
      notify('Please include text or attach an image (or both).', 'error');
      return;
    }
    try {
      await api.post('/api/opportunities', {
        kind,
        title,
        organization: org,
        description: desc,
        image_url: imageUrl,
        eligibility: elig,
        deadline,
        external_url: url,
      });
      setShowForm(false);
      setTitle('');
      setOrg('');
      setDesc('');
      setImageUrl(null);
      await load();
      notify('Opportunity submitted (moderated before listing if required).', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Submission failed.', 'error');
    }
  }

  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <Briefcase className="w-5 h-5 text-blue-700 dark:text-blue-400" />
            Internships, Jobs & Scholarships
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Verified internships, research calls, scholarships, and competitions for university students.
          </p>
        </div>
        <button
          type="button"
          onClick={() => (user ? setShowForm((s) => !s) : setAuthModalOpen(true))}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-slate-900 dark:bg-blue-600 text-white text-xs font-medium shrink-0"
        >
          <Plus className="w-3.5 h-3.5" /> Post Opportunity
        </button>
      </section>

      <div className="flex flex-wrap gap-1.5">
        {['', 'internship', 'job', 'scholarship', 'competition', 'research', 'workshop'].map((k) => (
          <button
            key={k || 'all'}
            type="button"
            onClick={() => setKindFilter(k)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium capitalize ${
              kindFilter === k ? 'bg-slate-900 text-white dark:bg-blue-600' : 'border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'
            }`}
          >
            {k || 'All'}
          </button>
        ))}
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <select value={kind} onChange={(e) => setKind(e.target.value as Opportunity['kind'])} className="rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-sm">
              <option value="internship">Internship</option>
              <option value="job">Job</option>
              <option value="scholarship">Scholarship</option>
              <option value="competition">Competition</option>
              <option value="research">Research</option>
              <option value="workshop">Workshop</option>
            </select>
            <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Opportunity title (optional if posting image/text)" className="sm:col-span-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-sm" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <input type="text" value={org} onChange={(e) => setOrg(e.target.value)} placeholder="Organization (optional)" className="rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-sm" />
            <input type="text" value={elig} onChange={(e) => setElig(e.target.value)} placeholder="Eligibility (e.g. BIT 6th Sem+)" className="rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-sm" />
            <input type="date" required value={deadline} onChange={(e) => setDeadline(e.target.value)} className="rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-sm" />
          </div>
          <textarea rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Role description and application notes (optional if attaching poster/image)..." className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-sm" />
          <ImageAttachmentField
            imageUrl={imageUrl}
            onChange={setImageUrl}
            onError={(msg) => notify(msg, 'error')}
          />
          <div className="flex gap-3">
            <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://application-link" className="flex-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-sm" />
            <button type="submit" className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-blue-600 text-white text-xs font-medium">Submit</button>
          </div>
        </form>
      )}

      <div className="space-y-3">
        {items.length === 0 ? (
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-8 text-center text-xs text-slate-500">
            No opportunities listed in this category yet.
          </div>
        ) : (
          items.map((o) => (
          <div key={o.id} className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
              <span className="capitalize font-semibold text-blue-700 dark:text-blue-400">
                {o.kind}{o.organization ? ` · ${o.organization}` : ''}
              </span>
              <span className="font-mono tabular-nums">Deadline: {o.deadline}</span>
            </div>
            {o.title && <h2 className="font-display text-base font-semibold text-slate-900 dark:text-white">{o.title}</h2>}
            {o.description && <p className="text-sm text-slate-700 dark:text-slate-300 whitespace-pre-wrap">{o.description}</p>}
            {o.image_url && (
              <img
                src={o.image_url}
                alt={o.title || 'Opportunity flyer or image'}
                className="max-h-96 w-auto rounded-lg border border-slate-200 dark:border-slate-800 object-contain bg-slate-50 dark:bg-slate-950"
              />
            )}
            <div className="flex flex-wrap items-center justify-between gap-2 pt-2 text-xs text-slate-500">
              <span>Eligibility: {o.eligibility}</span>
              {o.external_url && (
                <a href={o.external_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-blue-700 dark:text-blue-400 font-medium hover:underline">
                  Application Details <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </div>
          </div>
          ))
        )}
      </div>
    </div>
  );
}

// ================= EVENTS & STUDY GROUPS =================
export function EventsView() {
  const { user, setAuthModalOpen, notify } = useApp();
  const [events, setEvents] = useState<UniversityEvent[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState('');
  const [location, setLocation] = useState('');
  const [startsAt, setStartsAt] = useState('2026-12-01T10:00');
  const [kind, setKind] = useState<'event' | 'seminar' | 'announcement'>('event');
  const [desc, setDesc] = useState('');
  const [imageUrl, setImageUrl] = useState<string | null>(null);

  const load = useCallback(async () => {
    const data = await api.get<{ events: UniversityEvent[] }>('/api/events');
    setEvents(data.events);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() && !desc.trim() && !imageUrl) {
      notify('Please include text or attach an image (or both).', 'error');
      return;
    }
    try {
      await api.post('/api/events', {
        title,
        location: location.trim() || 'Gandaki University Campus',
        starts_at: startsAt,
        kind,
        description: desc,
        image_url: imageUrl,
      });
      setShowForm(false);
      setTitle('');
      setDesc('');
      setImageUrl(null);
      await load();
      notify('Event published.', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to publish event.', 'error');
    }
  }

  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <Calendar className="w-5 h-5 text-blue-700 dark:text-blue-400" />
            Campus Events & Seminars
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Workshops, seminars, and student-organized meetups across campus.
          </p>
        </div>
        <button
          type="button"
          onClick={() => (user ? setShowForm((s) => !s) : setAuthModalOpen(true))}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-slate-900 dark:bg-blue-600 text-white text-xs font-medium shrink-0"
        >
          <Plus className="w-3.5 h-3.5" /> Add Event
        </button>
      </section>

      {showForm && (
        <form onSubmit={handleSubmit} className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <select value={kind} onChange={(e) => setKind(e.target.value as 'event' | 'seminar' | 'announcement')} className="rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-sm">
              <option value="event">Event</option>
              <option value="seminar">Seminar</option>
              <option value="announcement">Announcement</option>
            </select>
            <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Event title (optional if posting image/text)" className="sm:col-span-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-sm" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <input type="text" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Campus location or room" className="rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-sm" />
            <input type="datetime-local" required value={startsAt} onChange={(e) => setStartsAt(e.target.value)} className="rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-sm" />
          </div>
          <textarea rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Agenda & participant details (optional if attaching flyer/image)..." className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-sm" />
          <ImageAttachmentField
            imageUrl={imageUrl}
            onChange={setImageUrl}
            onError={(msg) => notify(msg, 'error')}
          />
          <div className="flex justify-end">
            <button type="submit" className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-blue-600 text-white text-xs font-medium">Publish</button>
          </div>
        </form>
      )}

      <div className="space-y-3">
        {events.length === 0 ? (
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-8 text-center text-xs text-slate-500">
            No campus events scheduled yet.
          </div>
        ) : (
          events.map((ev) => (
          <div key={ev.id} className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
              <span className="capitalize font-semibold text-blue-700 dark:text-blue-400">{ev.kind} · {ev.location}</span>
              <span className="font-mono">{new Date(ev.starts_at).toLocaleString()}</span>
            </div>
            {ev.title && <h2 className="font-display text-base font-semibold text-slate-900 dark:text-white">{ev.title}</h2>}
            {ev.description && <p className="text-sm text-slate-700 dark:text-slate-300 whitespace-pre-wrap">{ev.description}</p>}
            {ev.image_url && (
              <img
                src={ev.image_url}
                alt={ev.title || 'Event poster or attachment'}
                className="max-h-96 w-auto rounded-lg border border-slate-200 dark:border-slate-800 object-contain bg-slate-50 dark:bg-slate-950"
              />
            )}
            <div className="text-xs text-slate-500">Organized by {ev.author_name}</div>
          </div>
          ))
        )}
      </div>
    </div>
  );
}

export function StudyGroupsView() {
  const { user, structure, setAuthModalOpen, notify } = useApp();
  const [groups, setGroups] = useState<StudyGroup[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [schedule, setSchedule] = useState('');
  const [progId, setProgId] = useState('');

  const load = useCallback(async () => {
    const data = await api.get<{ study_groups: StudyGroup[] }>('/api/study-groups');
    setGroups(data.study_groups);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!desc.trim() && !imageUrl) {
      notify('Please include a description or attach an image (or both).', 'error');
      return;
    }
    try {
      await api.post('/api/study-groups', {
        name,
        description: desc,
        image_url: imageUrl,
        schedule_text: schedule,
        program_id: progId || null,
      });
      setShowForm(false);
      setName('');
      setDesc('');
      setImageUrl(null);
      setSchedule('');
      await load();
      notify('Study group created.', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to create study group.', 'error');
    }
  }

  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <GraduationCap className="w-5 h-5 text-blue-700 dark:text-blue-400" />
            Peer Study Groups
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Verified student & faculty study circles organized around subjects and exam prep.
          </p>
        </div>
        <button
          type="button"
          onClick={() => (user ? setShowForm((s) => !s) : setAuthModalOpen(true))}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-slate-900 dark:bg-blue-600 text-white text-xs font-medium shrink-0"
        >
          <Plus className="w-3.5 h-3.5" /> Start Study Group
        </button>
      </section>

      {showForm && (
        <form onSubmit={handleSubmit} className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <input type="text" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Study group name" className="rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-sm" />
            <select value={progId} onChange={(e) => setProgId(e.target.value)} className="rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-sm">
              <option value="">All Programs</option>
              {structure.programs.map((p) => (
                <option key={p.id} value={p.id}>{p.code}</option>
              ))}
            </select>
          </div>
          <input type="text" required value={schedule} onChange={(e) => setSchedule(e.target.value)} placeholder="Meeting schedule (e.g. Mon/Wed 4:00 PM)" className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-sm" />
          <textarea rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Topics and goals (optional if attaching an image)..." className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-sm" />
          <ImageAttachmentField
            imageUrl={imageUrl}
            onChange={setImageUrl}
            onError={(msg) => notify(msg, 'error')}
          />
          <div className="flex justify-end">
            <button type="submit" className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-blue-600 text-white text-xs font-medium">Create Group</button>
          </div>
        </form>
      )}

      {groups.length === 0 ? (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-8 text-center text-xs text-slate-500">
          No study groups created yet.
        </div>
      ) : (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {groups.map((sg) => (
          <div key={sg.id} className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 flex flex-col justify-between gap-3">
            <div className="space-y-1.5">
              <div className="text-xs text-slate-500">
                {sg.program_code || 'Cross-Program'} · {sg.schedule_text}
              </div>
              <h2 className="font-display text-base font-semibold text-slate-900 dark:text-white">{sg.name}</h2>
              {sg.description && <p className="text-xs text-slate-600 dark:text-slate-300 whitespace-pre-wrap">{sg.description}</p>}
              {sg.image_url && (
                <img
                  src={sg.image_url}
                  alt={sg.name}
                  className="max-h-60 w-auto rounded-lg border border-slate-200 dark:border-slate-800 object-contain bg-slate-50 dark:bg-slate-950"
                />
              )}
            </div>
            <div className="flex items-center justify-between pt-3 border-t border-slate-100 dark:border-slate-800">
              <span className="font-mono tabular-nums text-xs text-slate-500">{sg.member_count} / {sg.max_members} members</span>
              <button
                type="button"
                onClick={async () => {
                  if (!user) return setAuthModalOpen(true);
                  try {
                    const res = await api.post<{ joined: boolean }>(`/api/study-groups/${sg.id}/toggle-join`);
                    await load();
                    notify(res.joined ? 'Joined study group.' : 'Left study group.', 'info');
                  } catch (err) {
                    notify(err instanceof Error ? err.message : 'Action failed.', 'error');
                  }
                }}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium ${
                  sg.is_member ? 'border border-slate-300 dark:border-slate-700' : 'bg-slate-900 dark:bg-blue-600 text-white'
                }`}
              >
                {sg.is_member ? 'Joined' : 'Join Circle'}
              </button>
            </div>
          </div>
        ))}
      </div>
      )}
    </div>
  );
}
