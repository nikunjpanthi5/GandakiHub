import React, { useState } from 'react';
import { ArrowLeft, Eye, EyeOff, Lock, Moon, ShieldCheck, Sun } from 'lucide-react';
import { useApp } from '../../context/AppContext.tsx';
import { api, formatRoleLabel } from '../../lib/api.ts';
import type { AuthUser } from '../../types/index.ts';

export function AdminLoginHub() {
  const { user, theme, toggleTheme, applyAuthSession, refreshCommunities, navigate, notify, logout } = useApp();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const isAuthenticatedAdmin = user && ['admin', 'super_admin'].includes(user.role);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await api.post<{ user: AuthUser; sessionToken?: string }>('/api/auth/admin-login', {
        email: identifier.trim(),
        password,
      });
      applyAuthSession(res.user, res.sessionToken);
      void refreshCommunities();
      notify(`Signed in to administration portal as ${res.user.display_name}.`, 'success');
      navigate('admin');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to sign in.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100">
      <header className="h-14 border-b border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-slate-900/95">
        <div className="max-w-5xl mx-auto h-full px-4 flex items-center justify-between">
          <button
            type="button"
            onClick={() => navigate('home')}
            className="inline-flex items-center gap-2 text-xs font-medium text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white"
          >
            <ArrowLeft className="w-4 h-4" />
            Return to GandakiHub
          </button>
          <button
            type="button"
            onClick={toggleTheme}
            className="p-2 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
            aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center p-4">
        <div className="w-full max-w-md rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm p-6 sm:p-8 space-y-6">
          <div className="space-y-2 text-center">
            <div className="w-11 h-11 rounded-xl bg-slate-900 dark:bg-blue-600 text-white flex items-center justify-center mx-auto">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <h1 className="font-display text-xl font-bold tracking-tight text-slate-900 dark:text-white">
              GandakiHub Admin Portal
            </h1>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Authorized administrative authentication
            </p>
          </div>

          {isAuthenticatedAdmin ? (
            <div className="space-y-4">
              <div className="rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50/70 dark:bg-emerald-950/30 p-4 text-xs space-y-1">
                <div className="font-semibold text-emerald-900 dark:text-emerald-200">
                  Active Administrative Session
                </div>
                <div className="text-emerald-800 dark:text-emerald-300">
                  Signed in as {user.display_name} ({formatRoleLabel(user.role)})
                </div>
              </div>
              <button
                type="button"
                onClick={() => navigate('admin')}
                className="w-full rounded-lg bg-slate-900 dark:bg-blue-600 text-white py-2.5 px-4 text-sm font-medium hover:bg-slate-800 dark:hover:bg-blue-500"
              >
                Open Administration Console
              </button>
              <button
                type="button"
                onClick={() => void logout()}
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 py-2 px-4 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                Sign out and switch account
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              {error && (
                <div className="rounded-lg border border-red-300 dark:border-red-900 bg-red-50 dark:bg-red-950/40 px-4 py-2.5 text-xs font-medium text-red-800 dark:text-red-200">
                  {error}
                </div>
              )}

              <div>
                <label htmlFor="admin-portal-email" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                  Email or Administrative Username
                </label>
                <input
                  id="admin-portal-email"
                  type="text"
                  required
                  autoComplete="username"
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  placeholder="admin@gandakiuniversity.edu.np"
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div>
                <label htmlFor="admin-portal-password" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                  Password
                </label>
                <div className="relative">
                  <input
                    id="admin-portal-password"
                    type={showPassword ? 'text' : 'password'}
                    required
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter administrative password"
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 pl-3 pr-10 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((s) => !s)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={busy}
                className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-slate-900 dark:bg-blue-600 text-white py-2.5 px-4 text-sm font-medium hover:bg-slate-800 dark:hover:bg-blue-500 disabled:opacity-50"
              >
                <Lock className="w-4 h-4" />
                {busy ? 'Authenticating...' : 'Sign In to Admin Portal'}
              </button>
            </form>
          )}
        </div>
      </main>
    </div>
  );
}
