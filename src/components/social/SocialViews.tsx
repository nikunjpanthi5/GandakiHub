import React, { useCallback, useEffect, useState } from 'react';
import {
  Bell,
  Check,
  LockKeyhole,
  MessageSquareLock,
  Search,
  ShieldAlert,
  UserCheck,
  UserMinus,
  UserPlus,
  X,
} from 'lucide-react';
import { useApp } from '../../context/AppContext.tsx';
import { api, formatRelativeDate, formatRoleLabel, resolveApiUrl } from '../../lib/api.ts';
import type {
  ConnectionRequestItem,
  ConnectionSummary,
  NotificationItem,
  PublicProfile,
  UserRole,
} from '../../types/index.ts';

interface DiscoverPerson {
  id: string;
  username: string;
  display_name: string;
  bio: string;
  role: UserRole;
  university_email_verified: boolean;
  program_name: string | null;
  semester_name: string | null;
  connection_status: 'connected' | 'outgoing_pending' | 'incoming_pending' | 'none';
  pending_request_id: string | null;
}

// ================= CONNECTIONS =================
export function ConnectionsView() {
  const { user, setAuthModalOpen, navigate, notify } = useApp();
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [incoming, setIncoming] = useState<ConnectionRequestItem[]>([]);
  const [outgoing, setOutgoing] = useState<ConnectionRequestItem[]>([]);
  const [blocked, setBlocked] = useState<Array<{ id: string; username: string; display_name: string }>>([]);
  const [people, setPeople] = useState<DiscoverPerson[]>([]);
  const [searchQ, setSearchQ] = useState('');

  const loadAll = useCallback(async () => {
    if (!user) return;
    const [connData, pplData] = await Promise.all([
      api.get<{
        connections: ConnectionSummary[];
        incoming: ConnectionRequestItem[];
        outgoing: ConnectionRequestItem[];
        blocked: Array<{ id: string; username: string; display_name: string }>;
      }>('/api/connections'),
      api.get<{ people: DiscoverPerson[] }>(`/api/people?q=${encodeURIComponent(searchQ)}`),
    ]);
    setConnections(connData.connections);
    setIncoming(connData.incoming);
    setOutgoing(connData.outgoing);
    setBlocked(connData.blocked);
    setPeople(pplData.people);
  }, [user, searchQ]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  if (!user) {
    return (
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-8 text-center space-y-3">
        <UserCheck className="w-8 h-8 text-slate-400 mx-auto" />
        <h1 className="font-display text-lg font-bold">Student & Faculty Connections</h1>
        <p className="text-xs text-slate-500 max-w-md mx-auto">
          Sign in to discover peers, send private connection requests, and manage your academic network. Connection lists remain strictly private.
        </p>
        <button type="button" onClick={() => setAuthModalOpen(true)} className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-blue-600 text-white text-xs font-medium">
          Sign In
        </button>
      </div>
    );
  }

  async function sendRequest(receiverId: string) {
    try {
      await api.post('/api/connections/request', { receiver_id: receiverId });
      await loadAll();
      notify('Connection request sent.', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Request failed.', 'error');
    }
  }

  async function respond(reqId: string, action: 'accept' | 'reject' | 'cancel') {
    await api.post(`/api/connections/requests/${reqId}/respond`, { action });
    await loadAll();
    notify(`Request ${action}ed.`, 'info');
  }

  async function removeConnection(connId: string) {
    await api.delete(`/api/connections/${connId}`);
    await loadAll();
    notify('Connection removed.', 'info');
  }

  async function toggleBlock(targetId: string) {
    const res = await api.post<{ blocked: boolean }>(`/api/users/${targetId}/block`);
    await loadAll();
    notify(res.blocked ? 'User blocked.' : 'User unblocked.', 'info');
  }

  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-1">
        <h1 className="font-display text-xl font-bold text-slate-900 dark:text-white">Private Network & Connections</h1>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Your connections and pending requests are private and never visible to other users. Only accepted connections will be eligible for E2EE messaging once launched.
        </p>
      </section>

      {/* Incoming & Outgoing Requests */}
      {(incoming.length > 0 || outgoing.length > 0) && (
        <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3">
          <h2 className="text-sm font-semibold">Pending Requests</h2>
          <div className="space-y-2">
            {incoming.map((r) => (
              <div key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-2 border-b border-slate-100 dark:border-slate-800 last:border-0">
                <div>
                  <div className="text-sm font-medium">{r.peer.display_name} <span className="text-xs text-slate-400">@{r.peer.username}</span></div>
                  {r.note && <div className="text-xs text-slate-500">"{r.note}"</div>}
                </div>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => void respond(r.id, 'accept')} className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-900 dark:bg-blue-600 text-white text-xs font-medium">
                    <Check className="w-3.5 h-3.5" /> Accept
                  </button>
                  <button type="button" onClick={() => void respond(r.id, 'reject')} className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-xs">
                    <X className="w-3.5 h-3.5" /> Decline
                  </button>
                </div>
              </div>
            ))}
            {outgoing.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-3 py-2 border-b border-slate-100 dark:border-slate-800 last:border-0">
                <div className="text-sm">{r.peer.display_name} <span className="text-xs text-slate-500">(Outgoing pending)</span></div>
                <button type="button" onClick={() => void respond(r.id, 'cancel')} className="px-3 py-1 rounded-lg border border-slate-300 dark:border-slate-700 text-xs">
                  Cancel Request
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Accepted Connections */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3">
        <h2 className="text-sm font-semibold font-mono tabular-nums">Your Connections ({connections.length})</h2>
        {connections.length === 0 ? (
          <p className="text-xs text-slate-500">No accepted connections yet. Discover students and faculty below.</p>
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {connections.map((c) => (
              <div key={c.connection_id} className="py-3 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <button type="button" onClick={() => navigate('profile', c.peer.username)} className="text-sm font-semibold hover:text-blue-700 dark:hover:text-blue-400">
                    {c.peer.display_name}
                  </button>
                  <div className="text-xs text-slate-500">
                    @{c.peer.username} · {formatRoleLabel(c.peer.role)} {c.peer.program_name ? `· ${c.peer.program_name}` : ''}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => void removeConnection(c.connection_id)} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs">
                    <UserMinus className="w-3.5 h-3.5" /> Remove
                  </button>
                  <button type="button" onClick={() => void toggleBlock(c.peer.id)} className="px-2.5 py-1.5 rounded-lg text-xs text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40">
                    Block
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Discover Peers */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">Discover Campus Members</h2>
          <div className="relative w-full sm:w-64">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="search"
              value={searchQ}
              onChange={(e) => setSearchQ(e.target.value)}
              placeholder="Filter by name or username..."
              className="w-full pl-8 pr-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-xs"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {people.map((p) => (
            <div key={p.id} className="p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <button type="button" onClick={() => navigate('profile', p.username)} className="text-sm font-semibold text-slate-900 dark:text-white hover:underline truncate block">
                  {p.display_name}
                </button>
                <div className="text-xs text-slate-500 truncate">
                  {formatRoleLabel(p.role)} {p.program_name ? `· ${p.program_name}` : ''}
                </div>
              </div>
              <div className="shrink-0">
                {p.connection_status === 'connected' ? (
                  <span className="text-xs font-medium text-emerald-700 dark:text-emerald-400">Connected</span>
                ) : p.connection_status === 'outgoing_pending' ? (
                  <span className="text-xs text-slate-500">Pending</span>
                ) : p.connection_status === 'incoming_pending' ? (
                  <button type="button" onClick={() => p.pending_request_id && void respond(p.pending_request_id, 'accept')} className="px-3 py-1.5 rounded-lg bg-slate-900 dark:bg-blue-600 text-white text-xs font-medium">
                    Accept
                  </button>
                ) : (
                  <button type="button" onClick={() => void sendRequest(p.id)} className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-medium hover:bg-slate-50 dark:hover:bg-slate-800">
                    <UserPlus className="w-3.5 h-3.5" /> Connect
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {blocked.length > 0 && (
        <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-2">
          <h2 className="text-xs font-semibold text-slate-500 flex items-center gap-1.5">
            <ShieldAlert className="w-3.5 h-3.5" /> Blocked Accounts
          </h2>
          {blocked.map((b) => (
            <div key={b.id} className="flex items-center justify-between text-xs py-1">
              <span>{b.display_name} (@{b.username})</span>
              <button type="button" onClick={() => void toggleBlock(b.id)} className="text-blue-700 dark:text-blue-400 hover:underline">
                Unblock
              </button>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

// ================= MESSAGES (CURRENTLY IN DEVELOPMENT) =================
export function MessagesView() {
  const { navigate } = useApp();

  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 sm:p-8 space-y-6">
      <div className="flex items-start gap-4">
        <div className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 shrink-0">
          <MessageSquareLock className="w-6 h-6 text-blue-700 dark:text-blue-400" />
        </div>
        <div className="space-y-1">
          <div className="text-xs font-mono font-semibold text-amber-700 dark:text-amber-400">
            Status: Currently in Development
          </div>
          <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-white">
            Private Messaging — Currently in Development
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-300 max-w-2xl leading-relaxed">
            GandakiHub will only launch private direct messaging once genuine, audited end-to-end encryption (E2EE) is implemented and independently verified. We intentionally do not store plaintext messages in the database or simulate fake conversations.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2 border-t border-slate-200 dark:border-slate-800">
        <div className="p-4 rounded-lg border border-slate-200 dark:border-slate-800 space-y-1.5">
          <div className="text-xs font-semibold text-slate-900 dark:text-white flex items-center gap-1.5">
            <LockKeyhole className="w-4 h-4 text-blue-700 dark:text-blue-400" />
            Planned Matrix Olm / Megolm Architecture
          </div>
          <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
            Messages and attachments will be encrypted client-side on the sender&apos;s device so only authorized recipient devices with verified keys can decrypt them—with zero plaintext access or administrator backdoors on the server.
          </p>
        </div>

        <div className="p-4 rounded-lg border border-slate-200 dark:border-slate-800 space-y-1.5">
          <div className="text-xs font-semibold text-slate-900 dark:text-white">
            Prepare Your Network Now
          </div>
          <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
            Only mutually accepted connections will be eligible to initiate encrypted rooms when messaging launches. Build your verified connections today.
          </p>
          <button
            type="button"
            onClick={() => navigate('connections')}
            className="mt-1 inline-block text-xs font-medium text-blue-700 dark:text-blue-400 hover:underline"
          >
            Manage Connections →
          </button>
        </div>
      </div>
    </div>
  );
}

// ================= NOTIFICATIONS =================
export function NotificationsView() {
  const { user, setAuthModalOpen, refreshNotificationsCount, navigate } = useApp();
  const [items, setItems] = useState<NotificationItem[]>([]);

  const load = useCallback(async () => {
    if (!user) return;
    const data = await api.get<{ notifications: NotificationItem[] }>('/api/notifications');
    setItems(data.notifications);
    await refreshNotificationsCount();
  }, [user, refreshNotificationsCount]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!user) {
    return (
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-8 text-center space-y-3">
        <Bell className="w-8 h-8 text-slate-400 mx-auto" />
        <h1 className="font-display text-lg font-bold">Notifications</h1>
        <p className="text-xs text-slate-500">Sign in to view replies, connection requests, and moderation updates.</p>
        <button type="button" onClick={() => setAuthModalOpen(true)} className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-blue-600 text-white text-xs font-medium">
          Sign In
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 flex items-center justify-between">
        <div>
          <h1 className="font-display text-xl font-bold text-slate-900 dark:text-white">Notification Center</h1>
          <p className="text-xs text-slate-500">Replies, connection activity, resource approvals, and role updates.</p>
        </div>
        <button
          type="button"
          onClick={async () => {
            await api.post('/api/notifications/read-all');
            await load();
          }}
          className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-medium"
        >
          Mark All Read
        </button>
      </section>

      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 divide-y divide-slate-100 dark:divide-slate-800">
        {items.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-500">No notifications yet.</div>
        ) : (
          items.map((n) => (
            <div
              key={n.id}
              className={`p-4 flex items-start justify-between gap-3 ${!n.is_read ? 'bg-blue-50/40 dark:bg-blue-950/20' : ''}`}
            >
              <button
                type="button"
                onClick={async () => {
                  if (!n.is_read) {
                    await api.post(`/api/notifications/${n.id}/read`);
                    await load();
                  }
                  const seg = n.link_path.replace(/^\/+/, '').split('/')[0] || 'home';
                  navigate(seg as Parameters<typeof navigate>[0]);
                }}
                className="text-left space-y-0.5 min-w-0"
              >
                <div className="text-sm font-semibold text-slate-900 dark:text-white">{n.title}</div>
                <div className="text-xs text-slate-600 dark:text-slate-300">{n.body}</div>
                <div className="text-[11px] font-mono text-slate-400">{formatRelativeDate(n.created_at)}</div>
              </button>
              {!n.is_read && (
                <button
                  type="button"
                  onClick={async () => {
                    await api.post(`/api/notifications/${n.id}/read`);
                    await load();
                  }}
                  className="text-xs text-blue-700 dark:text-blue-400 shrink-0"
                >
                  Mark read
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ================= PROFILE =================
export function ProfileView({ username }: { username?: string }) {
  const { user, structure, refreshUser, setAuthModalOpen, notify } = useApp();
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [posts, setPosts] = useState<Array<{ id: string; title: string; community_name: string; upvote_count: number; created_at: string }>>([]);
  const [resources, setResources] = useState<Array<{ id: string; title: string; status: string; subject_name: string; category_name: string; download_count: number }>>([]);
  const [editing, setEditing] = useState(false);

  // Edit state
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [programId, setProgramId] = useState('');
  const [semesterId, setSemesterId] = useState('');
  const [interestsStr, setInterestsStr] = useState('');
  const [showProgram, setShowProgram] = useState(true);
  const [allowConns, setAllowConns] = useState(true);

  const targetUsername = username || user?.username;

  const load = useCallback(async () => {
    if (!targetUsername) return;
    const data = await api.get<{
      profile: PublicProfile;
      posts: typeof posts;
      resources: typeof resources;
    }>(`/api/auth/users/${encodeURIComponent(targetUsername)}`);
    setProfile(data.profile);
    setPosts(data.posts);
    setResources(data.resources);
  }, [targetUsername]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (user && (!username || username === user.username)) {
      setDisplayName(user.display_name);
      setBio(user.bio);
      setProgramId(user.program_id || '');
      setSemesterId(user.semester_id || '');
      setInterestsStr(user.interests.join(', '));
      setShowProgram(user.privacy_settings.show_program);
      setAllowConns(user.privacy_settings.allow_connection_requests);
    }
  }, [user, username]);

  if (!targetUsername) {
    return (
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-8 text-center space-y-3">
        <h1 className="font-display text-lg font-bold">Profile</h1>
        <p className="text-xs text-slate-500">Sign in to manage your GandakiHub profile, preferences, and uploads.</p>
        <button type="button" onClick={() => setAuthModalOpen(true)} className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-blue-600 text-white text-xs font-medium">
          Sign In
        </button>
      </div>
    );
  }

  if (!profile) {
    return <div className="h-40 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 animate-pulse" />;
  }

  const isSelf = user?.id === profile.id;

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    await api.patch('/api/auth/profile', {
      display_name: displayName,
      bio,
      program_id: programId || null,
      semester_id: semesterId || null,
      interests: interestsStr.split(',').map((s) => s.trim()).filter(Boolean),
      privacy_settings: { show_program: showProgram, allow_connection_requests: allowConns },
    });
    await refreshUser();
    await load();
    setEditing(false);
    notify('Profile updated.', 'success');
  }

  async function handleAvatarUpload(file: File | undefined) {
    if (!file) return;
    const fd = new FormData();
    fd.append('avatar', file);
    try {
      await api.upload('/api/auth/profile/avatar', fd);
      await refreshUser();
      await load();
      notify('Profile picture updated.', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Avatar upload failed.', 'error');
    }
  }

  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            {profile.avatar_url ? (
              <img
                src={resolveApiUrl(profile.avatar_url)}
                alt={profile.display_name}
                className="w-16 h-16 rounded-xl object-cover border border-slate-200 dark:border-slate-700"
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="w-16 h-16 rounded-xl bg-slate-900 dark:bg-blue-600 text-white flex items-center justify-center font-display text-xl font-bold shrink-0">
                {profile.display_name.slice(0, 1).toUpperCase()}
              </div>
            )}
            <div className="space-y-1">
              <h1 className="font-display text-xl font-bold text-slate-900 dark:text-white">{profile.display_name}</h1>
              <div className="text-xs text-slate-500 dark:text-slate-400">
                @{profile.username} · {formatRoleLabel(profile.role)}
                {profile.university_email_verified ? ' · University Verified' : ''}
              </div>
              {profile.program_name && (
                <div className="text-xs text-slate-600 dark:text-slate-300">
                  {profile.program_name} {profile.semester_name ? `· ${profile.semester_name}` : ''}
                </div>
              )}
              <div className="text-[11px] font-mono text-slate-400">
                Joined {new Date(profile.created_at).toLocaleDateString()}
              </div>
            </div>
          </div>

          {isSelf && (
            <div className="flex items-center gap-2">
              <label className="cursor-pointer px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-medium hover:bg-slate-50 dark:hover:bg-slate-800">
                Change Photo
                <input type="file" accept="image/png,image/jpeg" className="hidden" onChange={(e) => void handleAvatarUpload(e.target.files?.[0])} />
              </label>
              <button
                type="button"
                onClick={() => setEditing((e) => !e)}
                className="px-3 py-1.5 rounded-lg bg-slate-900 dark:bg-blue-600 text-white text-xs font-medium"
              >
                {editing ? 'Cancel' : 'Edit Profile'}
              </button>
            </div>
          )}
        </div>

        {profile.bio && <p className="text-sm text-slate-700 dark:text-slate-300">{profile.bio}</p>}
        {profile.interests.length > 0 && (
          <p className="text-xs text-slate-500">Interests: {profile.interests.join(' · ')}</p>
        )}

        {editing && isSelf && (
          <form onSubmit={handleSave} className="pt-4 border-t border-slate-200 dark:border-slate-800 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium mb-1">Display Name</label>
                <input type="text" required value={displayName} onChange={(e) => setDisplayName(e.target.value)} className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Interests (comma separated)</label>
                <input type="text" value={interestsStr} onChange={(e) => setInterestsStr(e.target.value)} className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-sm" />
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium mb-1">Program</label>
                <select value={programId} onChange={(e) => setProgramId(e.target.value)} className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-sm">
                  <option value="">None</option>
                  {structure.programs.map((p) => (
                    <option key={p.id} value={p.id}>{p.code} — {p.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Semester</label>
                <select value={semesterId} onChange={(e) => setSemesterId(e.target.value)} className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-sm">
                  <option value="">None</option>
                  {structure.semesters.filter((s) => s.program_id === programId).map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Biography</label>
              <textarea rows={2} value={bio} onChange={(e) => setBio(e.target.value)} className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-sm" />
            </div>
            <div className="flex flex-wrap gap-4 text-xs">
              <label className="inline-flex items-center gap-2">
                <input type="checkbox" checked={showProgram} onChange={(e) => setShowProgram(e.target.checked)} />
                Show program & semester publicly
              </label>
              <label className="inline-flex items-center gap-2">
                <input type="checkbox" checked={allowConns} onChange={(e) => setAllowConns(e.target.checked)} />
                Accept connection requests
              </label>
            </div>
            <button type="submit" className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-blue-600 text-white text-xs font-medium">
              Save Profile Settings
            </button>
          </form>
        )}
      </section>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3">
          <h2 className="text-sm font-semibold">Recent Discussions ({posts.length})</h2>
          {posts.length === 0 ? (
            <p className="text-xs text-slate-500">No posts yet.</p>
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {posts.map((p) => (
                <div key={p.id} className="py-2">
                  <div className="text-xs font-medium text-slate-900 dark:text-slate-100">{p.title || 'Image discussion post'}</div>
                  <div className="text-[11px] text-slate-500 font-mono">{p.community_name} · {p.upvote_count} upvotes</div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3">
          <h2 className="text-sm font-semibold">Uploaded Academic PDFs ({resources.length})</h2>
          {resources.length === 0 ? (
            <p className="text-xs text-slate-500">No uploaded academic resources yet.</p>
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {resources.map((r) => (
                <div key={r.id} className="py-2">
                  <div className="text-xs font-medium text-slate-900 dark:text-slate-100">{r.title}</div>
                  <div className="text-[11px] text-slate-500 font-mono">
                    {r.subject_name} · {r.category_name} · {r.status} · {r.download_count} downloads
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
