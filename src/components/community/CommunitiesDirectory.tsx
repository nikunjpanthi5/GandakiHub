import React, { useState } from 'react';
import { Users } from 'lucide-react';
import { useApp } from '../../context/AppContext.tsx';
import { api } from '../../lib/api.ts';
import { PostFeed } from '../posts/PostFeed.tsx';

export function CommunitiesView() {
  const { user, communities, route, navigate, refreshCommunities, setAuthModalOpen, notify } = useApp();
  const [filterKind, setFilterKind] = useState<'all' | 'academic' | 'special'>('all');

  if (route.param) {
    return (
      <div className="space-y-4">
        <button
          type="button"
          onClick={() => navigate('communities')}
          className="text-xs font-medium text-blue-700 dark:text-blue-400 hover:underline"
        >
          ← All Communities
        </button>
        <PostFeed communitySlug={route.param} />
      </div>
    );
  }

  async function toggleJoin(commId: string) {
    if (!user) return setAuthModalOpen(true);
    try {
      const res = await api.post<{ joined: boolean; status: string }>(`/api/communities/${commId}/join`);
      await refreshCommunities();
      notify(res.joined ? 'Joined community.' : 'Updated community membership.', 'info');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Unable to join community.', 'error');
    }
  }

  const filtered = communities.filter((c) => filterKind === 'all' || c.kind === filterKind);

  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <Users className="w-5 h-5 text-blue-700 dark:text-blue-400" />
            University Communities
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Academic program spaces and dedicated campus channels for admissions, ideas, alumni, and student life.
          </p>
        </div>

        <div className="flex items-center gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-800 shrink-0">
          {(['all', 'academic', 'special'] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setFilterKind(k)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium capitalize ${
                filterKind === k ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm' : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              {k}
            </button>
          ))}
        </div>
      </section>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {filtered.map((c) => (
          <div
            key={c.id}
            className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 flex flex-col justify-between gap-4"
          >
            <div className="space-y-1.5">
              <div className="text-xs text-slate-500 dark:text-slate-400">
                <span>{c.kind === 'academic' ? 'Academic' : 'Special Channel'}</span>
                <span> · </span>
                <span>{c.visibility.replace('_', ' ')}</span>
              </div>
              <button
                type="button"
                onClick={() => {
                  if (c.slug === 'confessions') navigate('confessions');
                  else if (c.slug === 'complaints-suggestions') navigate('complaints');
                  else if (c.slug === 'getideas') navigate('ideas');
                  else if (c.slug === 'student-donations') navigate('donations');
                  else if (c.slug === 'internship-opportunities') navigate('opportunities');
                  else if (c.slug === 'events-announcements') navigate('events');
                  else if (c.slug === 'study-groups') navigate('study-groups');
                  else navigate('communities', c.slug);
                }}
                className="font-display text-base font-semibold text-slate-900 dark:text-white hover:text-blue-700 dark:hover:text-blue-400 text-left"
              >
                {c.name}
              </button>
              <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">{c.description}</p>
            </div>

            <div className="flex items-center justify-between pt-3 border-t border-slate-100 dark:border-slate-800">
              <span className="text-xs text-slate-500 font-mono tabular-nums">
                {c.member_count} members · {c.recent_posts_count} posts
              </span>
              <button
                type="button"
                onClick={() => void toggleJoin(c.id)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium ${
                  c.is_member
                    ? 'border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200'
                    : 'bg-slate-900 dark:bg-blue-600 text-white'
                }`}
              >
                {c.is_member ? 'Joined' : 'Join'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
