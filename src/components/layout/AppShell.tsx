import React, { useEffect, useRef, useState } from 'react';
import {
  Bell,
  BookOpen,
  Briefcase,
  Calendar,
  Compass,
  FileWarning,
  Flame,
  FolderOpen,
  GraduationCap,
  HeartHandshake,
  Home,
  Lightbulb,
  Lock,
  LogOut,
  Menu,
  MessageSquareLock,
  Moon,
  Search,
  Shield,
  Sun,
  UserCheck,
  Users,
  X,
} from 'lucide-react';
import { type AppRoute, useApp } from '../../context/AppContext.tsx';
import { api, formatRoleLabel } from '../../lib/api.ts';

interface Suggestion {
  group: string;
  label: string;
  sublabel: string;
  link_path: string;
}

interface TrendingSidebarData {
  trending_searches: Array<{ query: string; count: number; growth_pct: number }>;
  trending_communities: Array<{ id: string; slug: string; name: string; member_count: number; recent_posts: number }>;
  popular_resources: Array<{ id: string; title: string; program_code: string; subject_name: string; download_count: number; program_id: string; semester_id: string; subject_id: string }>;
  upcoming_events: Array<{ id: string; title: string; kind: string; location: string; starts_at: string }>;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const {
    user,
    structure,
    communities,
    unreadNotifications,
    theme,
    route,
    toasts,
    navigate,
    toggleTheme,
    setAuthModalOpen,
    setPolicyModal,
    logout,
  } = useApp();

  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [searchInput, setSearchInput] = useState(route.query?.q || '');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [trendingSide, setTrendingSide] = useState<TrendingSidebarData | null>(null);
  const searchBoxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.get<TrendingSidebarData>('/api/trending?window=day').then(setTrendingSide).catch(() => {});
  }, [route.page]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        e.preventDefault();
        const el = document.getElementById('global-search-input');
        el?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => {
      if (searchBoxRef.current && !searchBoxRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  useEffect(() => {
    const q = searchInput.trim();
    if (q.length < 2) {
      setSuggestions([]);
      return;
    }
    const timer = setTimeout(() => {
      api
        .get<{ suggestions: Suggestion[] }>(`/api/search/suggestions?q=${encodeURIComponent(q)}`)
        .then((d) => setSuggestions(d.suggestions))
        .catch(() => setSuggestions([]));
    }, 180);
    return () => clearTimeout(timer);
  }, [searchInput]);

  function submitSearch(e: React.FormEvent) {
    e.preventDefault();
    const q = searchInput.trim();
    setShowSuggestions(false);
    navigate('explore', undefined, q ? { q, track: '1' } : undefined);
  }

  function followSuggestion(linkPath: string) {
    setShowSuggestions(false);
    const clean = linkPath.replace(/^\/+/, '');
    const [p, qs] = clean.split('?');
    const qObj: Record<string, string> = {};
    if (qs) new URLSearchParams(qs).forEach((v, k) => (qObj[k] = v));
    const segs = p.split('/');
    navigate(segs[0] as AppRoute, segs[1], qObj);
  }

  const isStaff = user && ['super_admin', 'admin', 'community_moderator'].includes(user.role);

  const primaryNav: Array<{ id: AppRoute; label: string; icon: React.ComponentType<{ className?: string }>; badge?: number }> = [
    { id: 'home', label: 'Home', icon: Home },
    { id: 'explore', label: 'Explore & Search', icon: Compass },
    { id: 'academic', label: 'Academic Resources', icon: BookOpen },
    { id: 'communities', label: 'Communities', icon: Users },
    { id: 'trending', label: 'Trending', icon: Flame },
    { id: 'opportunities', label: 'Opportunities', icon: Briefcase },
    { id: 'events', label: 'Events', icon: Calendar },
    { id: 'study-groups', label: 'Study Groups', icon: GraduationCap },
    { id: 'connections', label: 'Connections', icon: UserCheck },
    { id: 'messages', label: 'Messages', icon: MessageSquareLock },
    { id: 'notifications', label: 'Notifications', icon: Bell, badge: unreadNotifications },
  ];

  const specialChannels: Array<{ id: AppRoute; label: string; icon: React.ComponentType<{ className?: string }> }> = [
    { id: 'confessions', label: 'Confessions', icon: Lock },
    { id: 'complaints', label: 'Complaints & Feedback', icon: FileWarning },
    { id: 'ideas', label: 'GetIdeas', icon: Lightbulb },
    { id: 'donations', label: 'Student Donations', icon: HeartHandshake },
  ];

  const joinedComms = communities.filter((c) => c.is_member).slice(0, 6);

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100">
      {/* Top Bar: Clean 3-Zone Contract */}
      <header className="sticky top-0 z-40 h-14 border-b border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-slate-900/95 backdrop-blur-sm">
        <div className="max-w-[1440px] mx-auto h-full px-4 lg:px-6 flex items-center justify-between gap-4 lg:gap-8">
          {/* Zone 1: Brand Wordmark + Mobile Menu Trigger */}
          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen((o) => !o)}
              className="lg:hidden p-2 -ml-2 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
              aria-label="Toggle navigation menu"
            >
              {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
            <button
              type="button"
              onClick={() => navigate('home')}
              className="font-display text-lg font-bold tracking-tight text-slate-900 dark:text-white whitespace-nowrap shrink-0"
            >
              GandakiHub
            </button>
          </div>

          {/* Zone 2: Universal Search Bar */}
          <div ref={searchBoxRef} className="relative flex-1 max-w-xl">
            <form onSubmit={submitSearch} className="relative">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                id="global-search-input"
                type="search"
                value={searchInput}
                onFocus={() => setShowSuggestions(true)}
                onChange={(e) => {
                  setSearchInput(e.target.value);
                  setShowSuggestions(true);
                }}
                placeholder="Search subjects, notes, past questions, communities, people... (/)"
                className="w-full pl-9 pr-4 py-1.5 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:bg-white dark:focus:bg-slate-900"
              />
            </form>

            {showSuggestions && suggestions.length > 0 && (
              <div className="absolute left-0 right-0 mt-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-lg z-50 max-h-80 overflow-y-auto py-1">
                {suggestions.map((s, idx) => (
                  <button
                    key={`${s.group}-${idx}`}
                    type="button"
                    onClick={() => followSuggestion(s.link_path)}
                    className="w-full text-left px-3.5 py-2 hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">{s.label}</div>
                      <div className="text-xs text-slate-500 dark:text-slate-400 truncate">{s.sublabel}</div>
                    </div>
                    <span className="text-[11px] font-medium text-slate-400 shrink-0">{s.group}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Zone 3: Theme Toggle + Primary Account Action */}
          <div className="flex items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={toggleTheme}
              className="p-2 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
              aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
            >
              {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>

            {user ? (
              <div className="flex items-center gap-2">
                {isStaff && (
                  <button
                    type="button"
                    onClick={() => navigate('admin')}
                    className={`hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap shrink-0 border ${
                      route.page === 'admin'
                        ? 'bg-slate-900 text-white border-slate-900 dark:bg-blue-600 dark:border-blue-600'
                        : 'border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800'
                    }`}
                  >
                    <Shield className="w-3.5 h-3.5" />
                    Admin
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => navigate('profile')}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-900 dark:bg-blue-600 text-white hover:bg-slate-800 dark:hover:bg-blue-500 whitespace-nowrap shrink-0 max-w-[140px] truncate"
                >
                  {user.display_name.split(' ')[0]}
                </button>
                <button
                  type="button"
                  onClick={() => void logout()}
                  className="p-2 rounded-lg text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800"
                  aria-label="Sign out"
                  title="Sign out"
                >
                  <LogOut className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setAuthModalOpen(true)}
                className="px-4 py-1.5 rounded-lg text-xs font-medium bg-slate-900 dark:bg-blue-600 text-white hover:bg-slate-800 dark:hover:bg-blue-500 whitespace-nowrap shrink-0"
              >
                Sign In
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Mobile Collapsible Navigation Drawer */}
      {mobileMenuOpen && (
        <div className="lg:hidden fixed inset-x-0 top-14 bottom-14 z-30 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 overflow-y-auto p-4 space-y-5">
          <nav className="space-y-1">
            {primaryNav.map((item) => {
              const Icon = item.icon;
              const active = route.page === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    navigate(item.id);
                    setMobileMenuOpen(false);
                  }}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-sm font-medium ${
                    active
                      ? 'bg-slate-900 text-white dark:bg-blue-600'
                      : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                  }`}
                >
                  <span className="flex items-center gap-3">
                    <Icon className="w-4 h-4" />
                    {item.label}
                  </span>
                  {item.badge ? <span className="font-mono text-xs">{item.badge}</span> : null}
                </button>
              );
            })}
          </nav>

          <div className="pt-3 border-t border-slate-200 dark:border-slate-800 space-y-1">
            <div className="px-3 text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1">Campus Channels</div>
            {specialChannels.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    navigate(item.id);
                    setMobileMenuOpen(false);
                  }}
                  className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  <Icon className="w-4 h-4" />
                  {item.label}
                </button>
              );
            })}
            {isStaff && (
              <button
                type="button"
                onClick={() => {
                  navigate('admin');
                  setMobileMenuOpen(false);
                }}
                className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium text-blue-700 dark:text-blue-400"
              >
                <Shield className="w-4 h-4" />
                Admin Dashboard
              </button>
            )}
          </div>
        </div>
      )}

      {/* Main 3-Column Desktop Layout */}
      <div className="flex-1 w-full max-w-[1440px] mx-auto px-4 lg:px-6 py-5 grid grid-cols-1 lg:grid-cols-[248px_minmax(0,1fr)] xl:grid-cols-[248px_minmax(0,1fr)_296px] gap-6 pb-20 lg:pb-8">
        {/* Left Sidebar */}
        <aside className="hidden lg:block space-y-6">
          <div className="space-y-1">
            {primaryNav.map((item) => {
              const Icon = item.icon;
              const active = route.page === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => navigate(item.id)}
                  className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
                    active
                      ? 'bg-slate-900 text-white dark:bg-blue-600'
                      : 'text-slate-700 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-slate-800/70'
                  }`}
                >
                  <span className="flex items-center gap-2.5 truncate">
                    <Icon className="w-4 h-4 shrink-0" />
                    <span className="truncate">{item.label}</span>
                  </span>
                  {item.id === 'messages' && (
                    <span className="text-[10px] opacity-75 shrink-0">In Dev</span>
                  )}
                  {item.badge ? (
                    <span className="font-mono tabular-nums text-xs font-semibold px-1.5 py-0.5 rounded bg-blue-600 text-white">
                      {item.badge}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>

          <div className="pt-4 border-t border-slate-200 dark:border-slate-800 space-y-1">
            <div className="px-3 text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1.5">
              Campus Channels
            </div>
            {specialChannels.map((item) => {
              const Icon = item.icon;
              const active = route.page === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => navigate(item.id)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors ${
                    active
                      ? 'bg-slate-900 text-white dark:bg-blue-600 font-medium'
                      : 'text-slate-700 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-slate-800/70'
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </button>
              );
            })}
          </div>

          <div className="pt-4 border-t border-slate-200 dark:border-slate-800 space-y-1">
            <div className="px-3 text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1.5">
              Academic Programs
            </div>
            {structure.programs.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => navigate('academic', undefined, { program: p.id })}
                className="w-full flex items-center justify-between px-3 py-1.5 rounded-lg text-xs text-slate-700 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-slate-800/70"
              >
                <span className="font-medium truncate">{p.code}</span>
                <span className="text-slate-400 truncate max-w-[140px]">{p.name}</span>
              </button>
            ))}
          </div>

          {joinedComms.length > 0 && (
            <div className="pt-4 border-t border-slate-200 dark:border-slate-800 space-y-1">
              <div className="px-3 text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1.5">
                Joined Communities
              </div>
              {joinedComms.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => navigate('communities', c.slug)}
                  className="w-full text-left px-3 py-1.5 rounded-lg text-xs text-slate-700 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-slate-800/70 truncate"
                >
                  {c.name}
                </button>
              ))}
            </div>
          )}

          {user && (
            <div className="pt-4 border-t border-slate-200 dark:border-slate-800 px-3 text-xs text-slate-500 dark:text-slate-400 space-y-1">
              <div className="font-medium text-slate-800 dark:text-slate-200 truncate">{user.display_name}</div>
              <div>{formatRoleLabel(user.role)}</div>
              {isStaff && (
                <button
                  type="button"
                  onClick={() => navigate('admin')}
                  className="text-blue-700 dark:text-blue-400 font-medium hover:underline pt-1 inline-block"
                >
                  Open Admin Console
                </button>
              )}
            </div>
          )}
        </aside>

        {/* Center Main Workspace */}
        <main className="min-w-0 space-y-5">{children}</main>

        {/* Right Sidebar: Trending Searches, Communities, Resources, Events */}
        <aside className="hidden xl:block space-y-5">
          {/* Trending Searches */}
          <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Trending Searches</h3>
              <button
                type="button"
                onClick={() => navigate('trending')}
                className="text-xs text-blue-700 dark:text-blue-400 hover:underline"
              >
                See all
              </button>
            </div>
            {trendingSide?.trending_searches?.length ? (
              <div className="space-y-2">
                {trendingSide.trending_searches.slice(0, 5).map((item, idx) => (
                  <button
                    key={item.query}
                    type="button"
                    onClick={() => navigate('explore', undefined, { q: item.query, track: '1' })}
                    className="w-full flex items-center justify-between text-left py-1 hover:text-blue-700 dark:hover:text-blue-400"
                  >
                    <span className="text-xs font-medium text-slate-700 dark:text-slate-300 truncate">
                      <span className="font-mono tabular-nums text-slate-400 mr-2">{idx + 1}.</span>
                      {item.query}
                    </span>
                    <span className="font-mono tabular-nums text-[11px] text-slate-400 shrink-0">
                      {item.count} searches
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-xs text-slate-500">Search activity will appear here.</p>
            )}
          </section>

          {/* Trending Communities */}
          <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Active Communities</h3>
              <button
                type="button"
                onClick={() => navigate('communities')}
                className="text-xs text-blue-700 dark:text-blue-400 hover:underline"
              >
                Browse
              </button>
            </div>
            {trendingSide?.trending_communities?.length ? (
              <div className="space-y-2.5">
                {trendingSide.trending_communities.slice(0, 4).map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => navigate('communities', c.slug)}
                    className="w-full text-left block group"
                  >
                    <div className="text-xs font-medium text-slate-800 dark:text-slate-200 group-hover:text-blue-700 dark:group-hover:text-blue-400 truncate">
                      {c.name}
                    </div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                      {c.member_count} members · {c.recent_posts} recent posts
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-xs text-slate-500">Community activity will appear here.</p>
            )}
          </section>

          {/* Popular Notes & Resources */}
          <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Popular Resources</h3>
              <button
                type="button"
                onClick={() => navigate('academic')}
                className="text-xs text-blue-700 dark:text-blue-400 hover:underline"
              >
                Repository
              </button>
            </div>
            {trendingSide?.popular_resources?.length ? (
              <div className="space-y-2.5">
                {trendingSide.popular_resources.slice(0, 4).map((r) => (
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
                    className="w-full text-left block group"
                  >
                    <div className="text-xs font-medium text-slate-800 dark:text-slate-200 group-hover:text-blue-700 dark:group-hover:text-blue-400 line-clamp-1">
                      {r.title}
                    </div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                      {r.program_code} · {r.subject_name} · {r.download_count} downloads
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-xs text-slate-500">Approved study resources will appear here.</p>
            )}
          </section>

          {/* Upcoming Events */}
          <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Upcoming Events</h3>
              <button
                type="button"
                onClick={() => navigate('events')}
                className="text-xs text-blue-700 dark:text-blue-400 hover:underline"
              >
                Calendar
              </button>
            </div>
            {trendingSide?.upcoming_events?.length ? (
              <div className="space-y-2.5">
                {trendingSide.upcoming_events.slice(0, 3).map((ev) => (
                  <button
                    key={ev.id}
                    type="button"
                    onClick={() => navigate('events')}
                    className="w-full text-left block"
                  >
                    <div className="text-xs font-medium text-slate-800 dark:text-slate-200 line-clamp-1">{ev.title}</div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400">
                      {new Date(ev.starts_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · {ev.location}
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-xs text-slate-500">No upcoming events scheduled.</p>
            )}
          </section>
        </aside>
      </div>

      {/* Discreet Independent Disclaimer Footer */}
      <footer className="border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 py-5 px-4 lg:px-6 mb-14 lg:mb-0">
        <div className="max-w-[1440px] mx-auto flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs text-slate-500 dark:text-slate-400">
          <p>
            GandakiHub is an independent student-developed digital community platform and is not officially owned, operated, or endorsed by Gandaki University.
          </p>
          <div className="flex flex-wrap items-center gap-4 shrink-0">
            <button type="button" onClick={() => setPolicyModal('privacy')} className="hover:text-slate-900 dark:hover:text-slate-200">
              Privacy Policy
            </button>
            <button type="button" onClick={() => setPolicyModal('terms')} className="hover:text-slate-900 dark:hover:text-slate-200">
              Terms of Use
            </button>
            <button type="button" onClick={() => setPolicyModal('guidelines')} className="hover:text-slate-900 dark:hover:text-slate-200">
              Guidelines
            </button>
            <button type="button" onClick={() => setPolicyModal('moderation')} className="hover:text-slate-900 dark:hover:text-slate-200">
              Moderation Policy
            </button>
          </div>
        </div>
      </footer>

      {/* Mobile Bottom Navigation Bar (Compact <= 56px, well under 15% mobile height) */}
      <nav className="lg:hidden fixed bottom-0 inset-x-0 z-40 h-14 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 grid grid-cols-5">
        {[
          { id: 'home' as AppRoute, label: 'Home', icon: Home },
          { id: 'academic' as AppRoute, label: 'Notes', icon: FolderOpen },
          { id: 'explore' as AppRoute, label: 'Search', icon: Search },
          { id: 'communities' as AppRoute, label: 'Groups', icon: Users },
          { id: 'notifications' as AppRoute, label: 'Alerts', icon: Bell },
        ].map((item) => {
          const Icon = item.icon;
          const active = route.page === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => navigate(item.id)}
              className={`flex flex-col items-center justify-center gap-0.5 text-[11px] ${
                active ? 'text-blue-700 dark:text-blue-400 font-semibold' : 'text-slate-500 dark:text-slate-400'
              }`}
            >
              <Icon className="w-4 h-4" />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      {/* Toast Notifications */}
      <div className="fixed bottom-16 lg:bottom-5 right-4 z-50 space-y-2 max-w-sm">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`px-4 py-2.5 rounded-lg border text-xs font-medium shadow-lg ${
              t.tone === 'error'
                ? 'bg-red-50 dark:bg-red-950 border-red-300 dark:border-red-800 text-red-900 dark:text-red-100'
                : t.tone === 'success'
                  ? 'bg-emerald-50 dark:bg-emerald-950 border-emerald-300 dark:border-emerald-800 text-emerald-900 dark:text-emerald-100'
                  : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100'
            }`}
          >
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
