import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, setSessionToken } from '../lib/api.ts';
import type {
  AcademicFolder,
  AuthUser,
  Community,
  Program,
  ResourceCategory,
  Semester,
  Subject,
} from '../types/index.ts';

export type AppRoute =
  | 'home'
  | 'explore'
  | 'communities'
  | 'academic'
  | 'trending'
  | 'opportunities'
  | 'events'
  | 'study-groups'
  | 'confessions'
  | 'complaints'
  | 'ideas'
  | 'donations'
  | 'connections'
  | 'messages'
  | 'notifications'
  | 'profile'
  | 'admin';

export interface RouteState {
  page: AppRoute;
  param?: string;
  query?: Record<string, string>;
}

interface ToastMessage {
  id: string;
  text: string;
  tone: 'success' | 'error' | 'info';
}

interface AcademicStructure {
  programs: Program[];
  semesters: Semester[];
  subjects: Subject[];
  folders: AcademicFolder[];
  categories: ResourceCategory[];
}

interface AppContextValue {
  user: AuthUser | null;
  loadingAuth: boolean;
  structure: AcademicStructure;
  communities: Community[];
  unreadNotifications: number;
  theme: 'light' | 'dark';
  route: RouteState;
  authModalOpen: boolean;
  authModalMode: 'login' | 'register' | 'super_admin_login';
  policyModal: 'privacy' | 'terms' | 'guidelines' | 'moderation' | null;
  toasts: ToastMessage[];
  navigate: (page: AppRoute, param?: string, query?: Record<string, string>) => void;
  toggleTheme: () => void;
  setAuthModalOpen: (open: boolean) => void;
  openAuthModal: (mode?: 'login' | 'register' | 'super_admin_login') => void;
  setPolicyModal: (doc: 'privacy' | 'terms' | 'guidelines' | 'moderation' | null) => void;
  notify: (text: string, tone?: 'success' | 'error' | 'info') => void;
  applyAuthSession: (user: AuthUser, sessionToken?: string) => void;
  refreshUser: () => Promise<void>;
  refreshStructure: () => Promise<void>;
  refreshCommunities: () => Promise<void>;
  refreshNotificationsCount: () => Promise<void>;
  logout: () => Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

function parseHashRoute(): RouteState {
  const raw = window.location.hash.replace(/^#\/?/, '');
  if (!raw) return { page: 'home' };
  const [pathPart, qsPart] = raw.split('?');
  const segments = pathPart.split('/').filter(Boolean);
  const page = (segments[0] || 'home') as AppRoute;
  const param = segments[1];
  const query: Record<string, string> = {};
  if (qsPart) {
    const sp = new URLSearchParams(qsPart);
    sp.forEach((v, k) => {
      query[k] = v;
    });
  }
  return { page, param, query };
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loadingAuth, setLoadingAuth] = useState(true);
  const [structure, setStructure] = useState<AcademicStructure>({
    programs: [],
    semesters: [],
    subjects: [],
    folders: [],
    categories: [],
  });
  const [communities, setCommunities] = useState<Community[]>([]);
  const [unreadNotifications, setUnreadNotifications] = useState(0);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('gh_theme');
    return saved === 'dark' ? 'dark' : 'light';
  });
  const [route, setRoute] = useState<RouteState>(() => parseHashRoute());
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authModalMode, setAuthModalMode] = useState<'login' | 'register' | 'super_admin_login'>('login');
  const [policyModal, setPolicyModal] = useState<'privacy' | 'terms' | 'guidelines' | 'moderation' | null>(null);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') root.classList.add('dark');
    else root.classList.remove('dark');
    localStorage.setItem('gh_theme', theme);
  }, [theme]);

  useEffect(() => {
    const onHash = () => setRoute(parseHashRoute());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const notify = useCallback((text: string, tone: 'success' | 'error' | 'info' = 'info') => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev.slice(-3), { id, text, tone }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4200);
  }, []);

  const navigate = useCallback((page: AppRoute, param?: string, query?: Record<string, string>) => {
    let hash = `#/${page}`;
    if (param) hash += `/${encodeURIComponent(param)}`;
    if (query && Object.keys(query).length > 0) {
      const sp = new URLSearchParams(query);
      hash += `?${sp.toString()}`;
    }
    window.location.hash = hash;
    setRoute({ page, param, query });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((t) => (t === 'light' ? 'dark' : 'light'));
  }, []);

  const openAuthModal = useCallback((mode: 'login' | 'register' | 'super_admin_login' = 'login') => {
    setAuthModalMode(mode);
    setAuthModalOpen(true);
  }, []);

  const applyAuthSession = useCallback((nextUser: AuthUser, sessionToken?: string) => {
    if (sessionToken) {
      setSessionToken(sessionToken);
    }
    setUser(nextUser);
    setLoadingAuth(false);
  }, []);

  const refreshUser = useCallback(async () => {
    try {
      const data = await api.get<{ user: AuthUser | null }>('/api/auth/me');
      setUser(data.user);
      if (!data.user) {
        setSessionToken(null);
      }
    } catch {
      setUser(null);
    } finally {
      setLoadingAuth(false);
    }
  }, []);

  const refreshStructure = useCallback(async () => {
    try {
      const data = await api.get<AcademicStructure>('/api/academic/structure');
      setStructure(data);
    } catch {
      // ignore
    }
  }, []);

  const refreshCommunities = useCallback(async () => {
    try {
      const data = await api.get<{ communities: Community[] }>('/api/communities');
      setCommunities(data.communities);
    } catch {
      // ignore
    }
  }, []);

  const refreshNotificationsCount = useCallback(async () => {
    try {
      const data = await api.get<{ unread_count: number }>('/api/notifications');
      setUnreadNotifications(data.unread_count);
    } catch {
      setUnreadNotifications(0);
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post('/api/auth/logout');
    } finally {
      setSessionToken(null);
      setUser(null);
      setUnreadNotifications(0);
      notify('Signed out of GandakiHub.', 'info');
      await refreshCommunities();
    }
  }, [notify, refreshCommunities]);

  useEffect(() => {
    void refreshUser();
    void refreshStructure();
    void refreshCommunities();
  }, [refreshUser, refreshStructure, refreshCommunities]);

  useEffect(() => {
    if (user) {
      void refreshNotificationsCount();
    } else {
      setUnreadNotifications(0);
    }
  }, [user, refreshNotificationsCount]);

  return (
    <AppContext.Provider
      value={{
        user,
        loadingAuth,
        structure,
        communities,
        unreadNotifications,
        theme,
        route,
        authModalOpen,
        authModalMode,
        policyModal,
        toasts,
        navigate,
        toggleTheme,
        setAuthModalOpen,
        openAuthModal,
        setPolicyModal,
        notify,
        applyAuthSession,
        refreshUser,
        refreshStructure,
        refreshCommunities,
        refreshNotificationsCount,
        logout,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside AppProvider');
  return ctx;
}
