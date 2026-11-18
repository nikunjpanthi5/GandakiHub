import React, { useEffect, useState } from 'react';
import { Flame, TrendingUp } from 'lucide-react';
import { useApp } from '../../context/AppContext.tsx';
import { api } from '../../lib/api.ts';

interface TrendingPayload {
  trending_searches: Array<{ query: string; count: number; growth_pct: number }>;
  trending_communities: Array<{ id: string; slug: string; name: string; description: string; member_count: number; recent_posts: number }>;
  popular_resources: Array<{ id: string; title: string; download_count: number; upvote_count: number; program_id: string; semester_id: string; subject_id: string; program_code: string; subject_name: string; category_name: string }>;
  trending_discussions: Array<{ id: string; title: string; upvote_count: number; comment_count: number; community_name: string; community_slug: string }>;
}

export function TrendingPage() {
  const { navigate } = useApp();
  const [windowMode, setWindowMode] = useState<'day' | 'week'>('day');
  const [data, setData] = useState<TrendingPayload | null>(null);

  useEffect(() => {
    api.get<TrendingPayload>(`/api/trending?window=${windowMode}`).then(setData).catch(() => {});
  }, [windowMode]);

  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <Flame className="w-5 h-5 text-amber-600" />
            Platform Trends
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Calculated directly from aggregated search activity, community posts, and resource downloads.
          </p>
        </div>

        <div className="flex items-center gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-800 shrink-0">
          <button
            type="button"
            onClick={() => setWindowMode('day')}
            className={`px-3 py-1.5 rounded-md text-xs font-medium ${
              windowMode === 'day' ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm' : 'text-slate-600 dark:text-slate-400'
            }`}
          >
            Trending Today
          </button>
          <button
            type="button"
            onClick={() => setWindowMode('week')}
            className={`px-3 py-1.5 rounded-md text-xs font-medium ${
              windowMode === 'week' ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm' : 'text-slate-600 dark:text-slate-400'
            }`}
          >
            This Week
          </button>
        </div>
      </section>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {/* Trending Searches */}
        <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-white flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-blue-700 dark:text-blue-400" />
            Popular Search Queries
          </h2>
          {data?.trending_searches?.length ? (
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {data.trending_searches.map((s, idx) => (
                <button
                  key={s.query}
                  type="button"
                  onClick={() => navigate('explore', undefined, { q: s.query, track: '1' })}
                  className="w-full py-2.5 flex items-center justify-between text-left hover:text-blue-700 dark:hover:text-blue-400"
                >
                  <span className="text-sm font-medium">
                    <span className="font-mono tabular-nums text-slate-400 mr-2">{idx + 1}.</span>
                    {s.query}
                  </span>
                  <span className="font-mono tabular-nums text-xs text-slate-500">
                    {s.count} · +{s.growth_pct}%
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className="text-xs text-slate-500">No search activity recorded in this window yet.</p>
          )}
        </section>

        {/* Trending Communities */}
        <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-white">Active Communities</h2>
          {data?.trending_communities?.length ? (
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {data.trending_communities.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => navigate('communities', c.slug)}
                  className="w-full py-2.5 text-left block hover:text-blue-700 dark:hover:text-blue-400"
                >
                  <div className="text-sm font-medium text-slate-900 dark:text-slate-100">{c.name}</div>
                  <div className="text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                    {c.member_count} members · {c.recent_posts} recent posts
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <p className="text-xs text-slate-500">No community activity recorded yet.</p>
          )}
        </section>

        {/* Popular Notes & Documents */}
        <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-white">Most Downloaded Resources</h2>
          {data?.popular_resources?.length ? (
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {data.popular_resources.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() =>
                    navigate('academic', undefined, {
                      program: r.program_id,
                      semester: r.semester_id,
                      subject: r.subject_id,
                    })
                  }
                  className="w-full py-2.5 text-left block hover:text-blue-700 dark:hover:text-blue-400"
                >
                  <div className="text-sm font-medium text-slate-900 dark:text-slate-100 line-clamp-1">{r.title}</div>
                  <div className="text-xs text-slate-500 font-mono tabular-nums">
                    {r.program_code} · {r.subject_name} · {r.download_count} downloads · {r.upvote_count} upvotes
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <p className="text-xs text-slate-500">No approved academic resources yet.</p>
          )}
        </section>

        {/* Trending Discussions */}
        <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-white">Trending Discussions</h2>
          {data?.trending_discussions?.length ? (
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {data.trending_discussions.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => navigate('communities', d.community_slug)}
                  className="w-full py-2.5 text-left block hover:text-blue-700 dark:hover:text-blue-400"
                >
                  <div className="text-sm font-medium text-slate-900 dark:text-slate-100 line-clamp-1">{d.title}</div>
                  <div className="text-xs text-slate-500 font-mono tabular-nums">
                    {d.community_name} · {d.upvote_count} upvotes · {d.comment_count} comments
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <p className="text-xs text-slate-500">No discussions posted in this window yet.</p>
          )}
        </section>
      </div>
    </div>
  );
}
