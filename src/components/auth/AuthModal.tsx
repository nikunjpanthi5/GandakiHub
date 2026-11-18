import React, { useEffect, useState } from 'react';
import { ShieldCheck, X } from 'lucide-react';
import { useApp } from '../../context/AppContext.tsx';
import { ApiError, api } from '../../lib/api.ts';
import type { AuthUser, ExternalReason } from '../../types/index.ts';

type AuthTab = 'login' | 'register' | 'verify_otp' | 'reset';

export function AuthModal() {
  const { authModalOpen, authModalMode, setAuthModalOpen, structure, applyAuthSession, refreshCommunities, notify } = useApp();
  const [tab, setTab] = useState<AuthTab>('login');
  const [loginRoleMode, setLoginRoleMode] = useState<'member' | 'admin'>('member');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Login fields
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');

  // Register fields
  const [regCategory, setRegCategory] = useState<'university_member' | 'external'>('university_member');
  const [memberType, setMemberType] = useState<'student' | 'teacher'>('student');
  const [regEmail, setRegEmail] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [regUsername, setRegUsername] = useState('');
  const [regDisplayName, setRegDisplayName] = useState('');
  const [regProgramId, setRegProgramId] = useState('prog-bit');
  const [regSemesterId, setRegSemesterId] = useState('prog-bit-sem-1');
  const [extReason, setExtReason] = useState<ExternalReason>('future_student');
  const [extDetail, setExtDetail] = useState('');

  // OTP Verification
  const [otpEmail, setOtpEmail] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [devOtpHint, setDevOtpHint] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);

  // Reset password
  const [resetEmail, setResetEmail] = useState('');
  const [resetCode, setResetCode] = useState('');
  const [resetNewPass, setResetNewPass] = useState('');
  const [resetStep, setResetStep] = useState<'request' | 'confirm'>('request');

  // First-time Super Admin bootstrap state
  const [bootstrapStatus, setBootstrapStatus] = useState<{
    needsSuperAdmin: boolean;
    superAdminEmailConfigured: boolean;
  } | null>(null);
  const [claimSuperAdmin, setClaimSuperAdmin] = useState(false);

  useEffect(() => {
    if (!authModalOpen) return;
    setError('');
    if (authModalMode === 'super_admin_login') {
      setTab('login');
      setLoginRoleMode('admin');
    } else if (authModalMode === 'register') {
      setTab('register');
    } else {
      setTab('login');
      setLoginRoleMode('member');
    }
    api
      .get<{ needsSuperAdmin: boolean; superAdminEmailConfigured: boolean }>('/api/auth/bootstrap-status')
      .then(setBootstrapStatus)
      .catch(() => {});
  }, [authModalOpen, authModalMode]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setInterval(() => setCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => clearInterval(t);
  }, [cooldown]);

  if (!authModalOpen) return null;

  const filteredSemesters = structure.semesters.filter((s) => s.program_id === regProgramId);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await api.post<{ user: AuthUser; sessionToken?: string }>('/api/auth/login', {
        identifier: loginEmail,
        password: loginPassword,
      });
      applyAuthSession(res.user, res.sessionToken);
      void refreshCommunities();
      setAuthModalOpen(false);
      notify(`Signed in as ${res.user.display_name}.`, 'success');
    } catch (err) {
      if (err instanceof ApiError && err.data?.requiresVerification) {
        setOtpEmail(String(err.data.email || loginEmail));
        setDevOtpHint(err.data.devOtpPreview ? String(err.data.devOtpPreview) : null);
        setOtpCode('');
        setTab('verify_otp');
        setError('');
        notify('Please verify your 6-digit email code to complete sign in.', 'info');
      } else {
        setError(err instanceof Error ? err.message : 'Sign in failed');
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await api.post<{ email: string; resendCooldownSeconds: number; devOtpPreview?: string }>(
        '/api/auth/register',
        {
          email: regEmail,
          password: regPassword,
          username: regUsername,
          display_name: regDisplayName,
          category: regCategory,
          member_type: memberType,
          program_id: regCategory === 'university_member' ? regProgramId : null,
          semester_id: regCategory === 'university_member' && memberType === 'student' ? regSemesterId : null,
          external_reason: regCategory === 'external' ? extReason : null,
          external_reason_detail: regCategory === 'external' ? extDetail : null,
          claim_super_admin: claimSuperAdmin,
        }
      );
      setOtpEmail(res.email);
      setOtpCode('');
      setCooldown(res.resendCooldownSeconds || 60);
      setDevOtpHint(res.devOtpPreview || null);
      setTab('verify_otp');
      notify('Verification code issued. Enter your 6-digit OTP to activate & sign in.', 'info');
    } catch (err) {
      if (err instanceof ApiError && err.data?.requiresVerification) {
        setOtpEmail(String(err.data.email || regEmail));
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : 'Registration failed.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleVerifyOtp(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await api.post<{ verified: boolean; user?: AuthUser; sessionToken?: string }>('/api/auth/verify-otp', {
        email: otpEmail,
        code: otpCode,
        purpose: 'verify_email',
      });
      if (res.user) {
        applyAuthSession(res.user, res.sessionToken);
        void refreshCommunities();
        setAuthModalOpen(false);
        notify(`Welcome, ${res.user.display_name}! Account verified and signed in.`, 'success');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'OTP verification failed.');
    } finally {
      setBusy(false);
    }
  }

  async function handleResendOtp() {
    setError('');
    try {
      const res = await api.post<{ resendCooldownSeconds: number; devOtpPreview?: string }>('/api/auth/resend-otp', {
        email: otpEmail,
        purpose: 'verify_email',
      });
      setCooldown(res.resendCooldownSeconds || 60);
      setDevOtpHint(res.devOtpPreview || null);
      notify('A new 6-digit verification code was issued.', 'info');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not resend code.');
    }
  }

  async function handlePasswordReset(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (resetStep === 'request') {
        const res = await api.post<{ devOtpPreview?: string }>('/api/auth/request-password-reset', { email: resetEmail });
        setDevOtpHint(res.devOtpPreview || null);
        setResetStep('confirm');
        notify('If the email exists, a 6-digit reset code was issued.', 'info');
      } else {
        await api.post('/api/auth/reset-password', {
          email: resetEmail,
          code: resetCode,
          new_password: resetNewPass,
        });
        notify('Password updated. Sign in with your new password.', 'success');
        setTab('login');
        setLoginEmail(resetEmail);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Password reset failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 overflow-y-auto">
      <div className="w-full max-w-xl rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xl overflow-hidden my-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-slate-800">
          <div>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">GandakiHub Account Access</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Verify via @gandakiuniversity.edu.np or register as an external participant
            </p>
          </div>
          <button
            type="button"
            onClick={() => setAuthModalOpen(false)}
            className="p-2 rounded-lg text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800"
            aria-label="Close authentication modal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 pt-4 flex items-center gap-2 border-b border-slate-200 dark:border-slate-800 pb-3">
          {(['login', 'register', 'reset'] as AuthTab[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => {
                setTab(t);
                setError('');
              }}
              className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap shrink-0 transition-colors ${
                tab === t || (tab === 'verify_otp' && t === 'register')
                  ? 'bg-slate-900 text-white dark:bg-blue-600'
                  : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              {t === 'login' ? 'Sign In' : t === 'register' ? 'Create Account' : 'Reset Password'}
            </button>
          ))}
        </div>

        <div className="p-6 space-y-5 max-h-[78vh] overflow-y-auto">
          {error && (
            <div className="rounded-lg border border-red-300 dark:border-red-900 bg-red-50 dark:bg-red-950/40 px-4 py-2.5 text-sm text-red-800 dark:text-red-200">
              {error}
            </div>
          )}

          {tab === 'login' && (
            <form onSubmit={handleLogin} className="space-y-4">
              <div className="grid grid-cols-2 gap-2 p-1 rounded-lg bg-slate-100 dark:bg-slate-800">
                <button
                  type="button"
                  onClick={() => setLoginRoleMode('member')}
                  className={`py-1.5 px-3 rounded-md text-xs font-medium transition-colors ${
                    loginRoleMode === 'member'
                      ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                      : 'text-slate-600 dark:text-slate-400'
                  }`}
                >
                  Member / External
                </button>
                <button
                  type="button"
                  onClick={() => setLoginRoleMode('admin')}
                  className={`py-1.5 px-3 rounded-md text-xs font-medium transition-colors ${
                    loginRoleMode === 'admin'
                      ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                      : 'text-slate-600 dark:text-slate-400'
                  }`}
                >
                  Admin / Super Admin
                </button>
              </div>

              {loginRoleMode === 'admin' && (
                <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-3 text-xs text-slate-600 dark:text-slate-300 space-y-1.5">
                  <p>
                    Admins sign in with the <span className="font-mono">username</span> and password created by the Super Admin. Super Admin signs in with their email (<span className="font-mono">SUPER_ADMIN_EMAIL</span>).
                  </p>
                  {bootstrapStatus?.needsSuperAdmin && (
                    <button
                      type="button"
                      onClick={() => {
                        setTab('register');
                        setRegCategory('external');
                        setExtReason('platform_admin');
                        setClaimSuperAdmin(true);
                        setError('');
                      }}
                      className="text-blue-700 dark:text-blue-400 font-medium hover:underline"
                    >
                      First time? Register your Super Admin account under External Users &rarr;
                    </button>
                  )}
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  {loginRoleMode === 'admin' ? 'Admin Username or Super Admin Email' : 'Email or Username'}
                </label>
                <input
                  type="text"
                  required
                  value={loginEmail}
                  onChange={(e) => setLoginEmail(e.target.value)}
                  placeholder={loginRoleMode === 'admin' ? 'admin_username or snikunj769@gmail.com' : 'name@gandakiuniversity.edu.np or username'}
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Password</label>
                <input
                  type="password"
                  required
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  placeholder="Enter your password"
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>
              <button
                type="submit"
                disabled={busy}
                className="w-full rounded-lg bg-slate-900 dark:bg-blue-600 text-white py-2.5 px-4 text-sm font-medium hover:bg-slate-800 dark:hover:bg-blue-500 disabled:opacity-50"
              >
                {busy ? 'Signing in...' : loginRoleMode === 'admin' ? 'Sign In as Admin / Super Admin' : 'Sign In'}
              </button>
            </form>
          )}

          {tab === 'register' && (
            <form onSubmit={handleRegister} className="space-y-4">
              <div className="grid grid-cols-2 gap-2 p-1 rounded-lg bg-slate-100 dark:bg-slate-800">
                <button
                  type="button"
                  onClick={() => setRegCategory('university_member')}
                  className={`py-2 px-3 rounded-md text-xs font-medium transition-colors ${
                    regCategory === 'university_member'
                      ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                      : 'text-slate-600 dark:text-slate-400'
                  }`}
                >
                  University Member
                </button>
                <button
                  type="button"
                  onClick={() => setRegCategory('external')}
                  className={`py-2 px-3 rounded-md text-xs font-medium transition-colors ${
                    regCategory === 'external'
                      ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                      : 'text-slate-600 dark:text-slate-400'
                  }`}
                >
                  External / Prospective
                </button>
              </div>

              {regCategory === 'university_member' ? (
                <div className="space-y-3">
                  <p className="text-xs text-slate-600 dark:text-slate-400">
                    Requires a valid <span className="font-mono">@gandakiuniversity.edu.np</span> address and 6-digit OTP verification.
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Role Type</label>
                      <select
                        value={memberType}
                        onChange={(e) => setMemberType(e.target.value as 'student' | 'teacher')}
                        className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm"
                      >
                        <option value="student">Student</option>
                        <option value="teacher">Teacher / Faculty</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Program</label>
                      <select
                        value={regProgramId}
                        onChange={(e) => {
                          setRegProgramId(e.target.value);
                          const firstSem = structure.semesters.find((s) => s.program_id === e.target.value);
                          if (firstSem) setRegSemesterId(firstSem.id);
                        }}
                        className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm"
                      >
                        {structure.programs.map((p) => (
                          <option key={p.id} value={p.id}>{p.code} — {p.name}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  {memberType === 'student' && (
                    <div>
                      <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Current Semester</label>
                      <select
                        value={regSemesterId}
                        onChange={(e) => setRegSemesterId(e.target.value)}
                        className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm"
                      >
                        {filteredSemesters.map((s) => (
                          <option key={s.id} value={s.id}>{s.name}</option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Reason for Joining</label>
                    <select
                      value={extReason}
                      onChange={(e) => {
                        const val = e.target.value as ExternalReason;
                        setExtReason(val);
                        if (val === 'platform_admin') setClaimSuperAdmin(true);
                      }}
                      className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm"
                    >
                      <option value="future_student">Future student / prospective applicant</option>
                      <option value="parent_guardian">Parent or guardian</option>
                      <option value="university_visitor">University visitor</option>
                      <option value="researcher">Researcher</option>
                      <option value="alumni">Alumni</option>
                      {bootstrapStatus?.needsSuperAdmin && (
                        <option value="platform_admin">Platform Admin / Super Admin Setup</option>
                      )}
                      <option value="other">Other</option>
                    </select>
                  </div>
                  {extReason === 'platform_admin' && (
                    <p className="text-xs text-blue-700 dark:text-blue-400">
                      Register with your configured <span className="font-mono">SUPER_ADMIN_EMAIL</span> and verify the 6-digit OTP to initialize Super Admin access.
                    </p>
                  )}
                  {extReason === 'other' && (
                    <div>
                      <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Short Explanation (Required)</label>
                      <input
                        type="text"
                        required
                        value={extDetail}
                        onChange={(e) => setExtDetail(e.target.value)}
                        placeholder="Describe your connection to Gandaki University"
                        className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm"
                      />
                    </div>
                  )}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Display Name</label>
                  <input
                    type="text"
                    required
                    value={regDisplayName}
                    onChange={(e) => setRegDisplayName(e.target.value)}
                    placeholder="Sita Sharma"
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Username</label>
                  <input
                    type="text"
                    required
                    value={regUsername}
                    onChange={(e) => setRegUsername(e.target.value)}
                    placeholder="sita_bit"
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  {regCategory === 'university_member' ? 'University Email (@gandakiuniversity.edu.np)' : 'Email Address'}
                </label>
                <input
                  type="email"
                  required
                  value={regEmail}
                  onChange={(e) => setRegEmail(e.target.value)}
                  placeholder={regCategory === 'university_member' ? 'sita@gandakiuniversity.edu.np' : 'you@example.com'}
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Password (8+ chars, letters & numbers)
                </label>
                <input
                  type="password"
                  required
                  value={regPassword}
                  onChange={(e) => setRegPassword(e.target.value)}
                  placeholder="Create a strong password"
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm"
                />
              </div>

              {bootstrapStatus?.needsSuperAdmin && (
                <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-3 space-y-1.5">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-slate-800 dark:text-slate-200">
                    <ShieldCheck className="w-4 h-4 text-blue-700 dark:text-blue-400 shrink-0" />
                    <span>First-Time Platform Setup</span>
                  </div>
                  {bootstrapStatus.superAdminEmailConfigured ? (
                    <p className="text-xs text-slate-600 dark:text-slate-400">
                      No Super Admin exists yet. Registering and verifying the configured{' '}
                      <span className="font-mono">SUPER_ADMIN_EMAIL</span> will initialize the Super Admin account.
                    </p>
                  ) : (
                    <label className="flex items-start gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={claimSuperAdmin}
                        onChange={(e) => setClaimSuperAdmin(e.target.checked)}
                        className="mt-0.5"
                      />
                      <span>Initialize this first verified account as Platform Super Admin</span>
                    </label>
                  )}
                </div>
              )}

              <button
                type="submit"
                disabled={busy}
                className="w-full rounded-lg bg-slate-900 dark:bg-blue-600 text-white py-2.5 px-4 text-sm font-medium hover:bg-slate-800 dark:hover:bg-blue-500 disabled:opacity-50"
              >
                {busy ? 'Creating Account...' : 'Continue & Send 6-Digit Verification Code'}
              </button>
            </form>
          )}

          {tab === 'verify_otp' && (
            <form onSubmit={handleVerifyOtp} className="space-y-4">
              <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-4 text-sm">
                <p className="font-medium text-slate-900 dark:text-slate-100">Verify Email Ownership</p>
                <p className="text-xs text-slate-600 dark:text-slate-400 mt-1">
                  Enter the 6-digit OTP issued for <span className="font-mono">{otpEmail}</span>.
                </p>
                {devOtpHint && (
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs font-mono text-blue-700 dark:text-blue-400">
                      Local OTP Preview (set RESEND_API_KEY for email delivery): {devOtpHint}
                    </p>
                    <button
                      type="button"
                      onClick={() => setOtpCode(devOtpHint)}
                      className="text-xs font-medium text-blue-700 dark:text-blue-400 underline"
                    >
                      Use code
                    </button>
                  </div>
                )}
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">6-Digit Code</label>
                <input
                  type="text"
                  maxLength={6}
                  required
                  value={otpCode}
                  onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, ''))}
                  placeholder="123456"
                  className="w-full font-mono text-center tracking-widest text-lg rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2.5"
                />
              </div>
              <div className="flex items-center justify-between gap-3">
                <button
                  type="button"
                  disabled={cooldown > 0}
                  onClick={handleResendOtp}
                  className="text-xs font-medium text-blue-700 dark:text-blue-400 disabled:text-slate-400"
                >
                  {cooldown > 0 ? `Resend available in ${cooldown}s` : 'Resend 6-digit code'}
                </button>
                <button
                  type="submit"
                  disabled={busy || otpCode.length !== 6}
                  className="rounded-lg bg-slate-900 dark:bg-blue-600 text-white py-2 px-5 text-sm font-medium disabled:opacity-50"
                >
                  {busy ? 'Verifying...' : 'Verify & Activate'}
                </button>
              </div>
            </form>
          )}

          {tab === 'reset' && (
            <form onSubmit={handlePasswordReset} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Account Email</label>
                <input
                  type="email"
                  required
                  value={resetEmail}
                  onChange={(e) => setResetEmail(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm"
                />
              </div>
              {resetStep === 'confirm' && (
                <>
                  {devOtpHint && (
                    <p className="text-xs font-mono text-blue-700 dark:text-blue-400">
                      Local Reset OTP Preview: {devOtpHint}
                    </p>
                  )}
                  <div>
                    <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">6-Digit Reset Code</label>
                    <input
                      type="text"
                      maxLength={6}
                      required
                      value={resetCode}
                      onChange={(e) => setResetCode(e.target.value.replace(/\D/g, ''))}
                      className="w-full font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">New Password</label>
                    <input
                      type="password"
                      required
                      value={resetNewPass}
                      onChange={(e) => setResetNewPass(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm"
                    />
                  </div>
                </>
              )}
              <button
                type="submit"
                disabled={busy}
                className="w-full rounded-lg bg-slate-900 dark:bg-blue-600 text-white py-2.5 px-4 text-sm font-medium"
              >
                {resetStep === 'request' ? 'Send Reset Code' : 'Update Password'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
