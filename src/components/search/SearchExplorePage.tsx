import React, { useCallback, useEffect, useState } from 'react';
import { History, Search, Trash2, X } from 'lucide-react';
import { type AppRoute, useApp } from '../../context/AppContext.tsx';
import { api } from '../../lib/api.ts';
import type { SearchResultItem } from '../../types/index.ts';

function HighlightText({ text, query }: { text: string; query: string }) {
  if (!query || query.trim().length < 2) return <>{text}</>;
  const escaped = query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'));
  return (
    <>
      {parts.map((part, idx) =>
        part.toLowerCase() === query.trim().toLowerCase() ? (
          <mark key={idx} className="bg-amber-200/80 dark:bg-amber-800/60 text-inherit rounded px-0.5">
            {part}
          </mark>
        ) : (
          <React.Fragment key={idx}>{part}</React.Fragment>
        )
      )}
    </>
  );
}

export function SearchExplorePage() {
  const { user, structure, route, navigate, notify } = useApp();
  const [query, setQuery] = useState(route.query?.q || '');
  const [typeFilter, setTypeFilter] = useState('all');
  const [programId, setProgramId] = useState('');
  const [semesterId, setSemesterId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [year, setYear] = useState('');
  const [sort, setSort] = useState<'relevance' | 'newest' | 'popular'>('relevance');
  const [results, setResults] = useState<SearchResultItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState<Array<{ query: string; last_searched: string }>>([]);

  useEffect(() => {
    if (route.query?.q !== undefined) {
      setQuery(route.query.q);
    }
  }, [route.query?.q]);

  const loadHistory = useCallback(async () => {
    if (!user) return setHistory([]);
    try {
      const data = await api.get<{ history: Array<{ query: string; last_searched: string }> }>('/api/search/history');
      setHistory(data.history);
    } catch {
      setHistory([]);
    }
  }, [user]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const executeSearch = useCallback(
    async (track: boolean) => {
      const q = query.trim();
      if (q.length < 2) {
        setResults([]);
        setTotal(0);
        return;
      }
      setLoading(true);
      try {
        const qs = new URLSearchParams({ q, type: typeFilter, sort });
        if (programId) qs.set('program_id', programId);
        if (semesterId) qs.set('semester_id', semesterId);
        if (categoryId) qs.set('category_id', categoryId);
        if (year) qs.set('year', year);
        if (track) qs.set('track', '1');
        const data = await api.get<{ results: SearchResultItem[]; total: number }>(`/api/search?${qs.toString()}`);
        setResults(data.results);
        setTotal(data.total);
        if (track && user) void loadHistory();
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    },
    [query, typeFilter, sort, programId, semesterId, categoryId, year, user, loadHistory]
  );

  useEffect(() => {
    void executeSearch(route.query?.track === '1');
  }, [executeSearch, route.query?.track]);

  function openResult(item: SearchResultItem) {
    const clean = item.link_path.replace(/^\/+/, '');
    const [p, qs] = clean.split('?');
    const qObj: Record<string, string> = {};
    if (qs) new URLSearchParams(qs).forEach((v, k) => (qObj[k] = v));
    const segs = p.split('/');
    navigate(segs[0] as AppRoute, segs[1], qObj);
  }

  async function clearHistory() {
    await api.delete('/api/search/history');
    setHistory([]);
    notify('Search history cleared.', 'info');
  }

  function clearAllFilters() {
    setTypeFilter('all');
    setProgramId('');
    setSemesterId('');
    setCategoryId('');
    setYear('');
    setSort('relevance');
  }

  const semOptions = programId ? structure.semesters.filter((s) => s.program_id === programId) : [];

  const typeTabs = [
    { id: 'all', label: 'All' },
    { id: 'subject', label: 'Subjects' },
    { id: 'resource', label: 'Documents' },
    { id: 'community', label: 'Communities' },
    { id: 'post', label: 'Discussions' },
    { id: 'user', label: 'People' },
    { id: 'opportunity', label: 'Opportunities' },
    { id: 'event', label: 'Events' },
    { id: 'study_group', label: 'Study Groups' },
    { id: 'idea', label: 'Ideas' },
    { id: 'confession', label: 'Confessions' },
    { id: 'complaint', label: 'Public Feedback' },
  ];

  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4">
        <div>
          <h1 className="font-display text-xl font-bold text-slate-900 dark:text-white">Universal Knowledge Search</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Search across academic programs, subjects, approved PDFs, discussions, communities, opportunities, events, and public profiles.
          </p>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void executeSearch(true);
          }}
          className="flex gap-2"
        >
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search e.g. Subject 1, BIT, Past Questions, Workshop, Internship..."
              className="w-full pl-9 pr-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-sm"
            />
          </div>
          <button
            type="submit"
            className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-blue-600 text-white text-xs font-medium shrink-0"
          >
            Search
          </button>
        </form>

        {/* Category Tabs */}
        <div className="flex flex-wrap gap-1.5 pt-1">
          {typeTabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTypeFilter(t.id)}
              className={`px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap ${
                typeFilter === t.id
                  ? 'bg-slate-900 text-white dark:bg-blue-600'
                  : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Facet Filters */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
          <select
            value={programId}
            onChange={(e) => {
              setProgramId(e.target.value);
              setSemesterId('');
            }}
            className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-2.5 py-1.5 text-xs"
          >
            <option value="">All Programs</option>
            {structure.programs.map((p) => (
              <option key={p.id} value={p.id}>{p.code}</option>
            ))}
          </select>

          <select
            value={semesterId}
            onChange={(e) => setSemesterId(e.target.value)}
            disabled={!programId}
            className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-2.5 py-1.5 text-xs disabled:opacity-50"
          >
            <option value="">All Semesters</option>
            {semOptions.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>

          <select
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-2.5 py-1.5 text-xs"
          >
            <option value="">All Categories</option>
            {structure.categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>

          <input
            type="text"
            value={year}
            onChange={(e) => setYear(e.target.value)}
            placeholder="Year (e.g. 2026)"
            className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-2.5 py-1.5 text-xs"
          />

          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as 'relevance' | 'newest' | 'popular')}
            className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-2.5 py-1.5 text-xs"
          >
            <option value="relevance">Sort: Relevance</option>
            <option value="newest">Sort: Newest</option>
            <option value="popular">Sort: Popularity</option>
          </select>
        </div>

        {(programId || semesterId || categoryId || year || typeFilter !== 'all') && (
          <button
            type="button"
            onClick={clearAllFilters}
            className="inline-flex items-center gap-1 text-xs text-blue-700 dark:text-blue-400 hover:underline"
          >
            <X className="w-3.5 h-3.5" /> Clear filters
          </button>
        )}
      </section>

      {/* Personal Search History */}
      {history.length > 0 && (
        <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-700 dark:text-slate-300">
              <History className="w-3.5 h-3.5" /> Your Recent Searches
            </span>
            <button
              type="button"
              onClick={() => void clearHistory()}
              className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-red-600"
            >
              <Trash2 className="w-3 h-3" /> Clear history
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {history.map((h) => (
              <button
                key={h.query}
                type="button"
                onClick={() => setQuery(h.query)}
                className="px-2.5 py-1 rounded-md border border-slate-200 dark:border-slate-700 text-xs hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                {h.query}
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Results */}
      {query.trim().length < 2 ? (
        <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-8 text-center space-y-2">
          <p className="text-sm font-medium text-slate-900 dark:text-white">Enter at least 2 characters to search GandakiHub</p>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Try searching "BIT", "Subject 1", "Past Questions", "Workshop", or "Internship".
          </p>
        </section>
      ) : loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-24 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 animate-pulse" />
          ))}
        </div>
      ) : results.length === 0 ? (
        <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-8 text-center space-y-2">
          <p className="text-sm font-medium text-slate-900 dark:text-white">No matching results for "{query}"</p>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Try broadening your query or clearing active filters. Private complaints and unapproved drafts are excluded from search.
          </p>
        </section>
      ) : (
        <section className="space-y-3">
          <div className="text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
            Showing {results.length} of {total} results
          </div>
          {results.map((item) => (
            <button
              key={`${item.type}-${item.id}`}
              type="button"
              onClick={() => openResult(item)}
              className="w-full text-left rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 hover:border-blue-500 transition-colors block space-y-1"
            >
              <div className="text-xs text-slate-500 dark:text-slate-400">
                <span className="font-semibold text-blue-700 dark:text-blue-400 uppercase tracking-wide text-[10px] mr-2">
                  {item.type.replace('_', ' ')}
                </span>
                {item.subtitle}
              </div>
              <div className="font-display text-sm sm:text-base font-semibold text-slate-900 dark:text-white">
                <HighlightText text={item.title} query={query} />
              </div>
              {item.snippet && (
                <p className="text-xs text-slate-600 dark:text-slate-300 line-clamp-2">
                  <HighlightText text={item.snippet} query={query} />
                </p>
              )}
            </button>
          ))}
        </section>
      )}
    </div>
  );
}
