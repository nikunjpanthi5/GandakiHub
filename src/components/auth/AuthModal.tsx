import React, { useEffect, useState } from 'react';
import { Check, Eye, EyeOff, X } from 'lucide-react';
import { useApp } from '../../context/AppContext.tsx';
import { ApiError, api } from '../../lib/api.ts';
import type { AuthUser } from '../../types/index.ts';

type AuthTab = 'login' | 'register' | 'verify_otp' | 'reset';

const UNIVERSITY_DOMAIN = '@gandakiuniversity.edu.np';

function getPasswordEvaluation(password: string): {
  hasMinLength: boolean;
  hasLetter: boolean;
  hasNumber: boolean;
  score: number;
  label: 'Weak' | 'Fair' | 'Strong';
} {
  const hasMinLength = password.length >= 8;
  const hasLetter = /[A-Za-z]/.test(password);
  const hasNumber = /\d/.test(password);
  const hasSymbolOrUpper = /[A-Z]/.test(password) && /[^A-Za-z0-9]/.test(password);
  let score = 0;
  if (hasMinLength) score += 1;
  if (hasLetter && hasNumber) score += 1;
  if (password.length >= 12 || hasSymbolOrUpper) score += 1;
  const label = score >= 3 ? 'Strong' : score === 2 ? 'Fair' : 'Weak';
  return { hasMinLength, hasLetter, hasNumber, score, label };
}

export function AuthModal() {
  const { authModalOpen, authModalMode, setAuthModalOpen, applyAuthSession, refreshCommunities, notify } = useApp();
  const [tab, setTab] = useState<AuthTab>('login');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Login fields (Email + Password only)
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [showLoginPassword, setShowLoginPassword] = useState(false);

  // Simplified Registration fields (Full Name, University Email, Password, Confirm Password only)
  const [fullName, setFullName] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showRegPassword, setShowRegPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  // OTP Verification
  const [otpEmail, setOtpEmail] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [devOtpHint, setDevOtpHint] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);

  // Reset password
  const [resetEmail, setResetEmail] = useState('');
  const [resetCode, setResetCode] = useState('');
  const [resetNewPass, setResetNewPass] = useState('');
  const [showResetPassword, setShowResetPassword] = useState(false);
  const [resetStep, setResetStep] = useState<'request' | 'confirm'>('request');

  useEffect(() => {
    if (!authModalOpen) return;
    setError('');
    setTab(authModalMode === 'register' ? 'register' : 'login');
  }, [authModalOpen, authModalMode]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setInterval(() => setCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => clearInterval(t);
  }, [cooldown]);

  if (!authModalOpen) return null;

  const pwEval = getPasswordEvaluation(regPassword);
  const trimmedEmail = regEmail.trim().toLowerCase();
  const emailLooksValid = trimmedEmail.length === 0 || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail);
  const isUniversityEmail = trimmedEmail.endsWith(UNIVERSITY_DOMAIN);
  const passwordsMatch = confirmPassword.length === 0 || regPassword === confirmPassword;

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await api.post<{ user: AuthUser; sessionToken?: string }>('/api/auth/login', {
        identifier: loginEmail.trim(),
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
        setError(err instanceof Error ? err.message : 'Sign in failed.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    if (fullName.trim().length < 2) {
      setError('Please enter your full name.');
      return;
    }
    if (!trimmedEmail || !emailLooksValid || !isUniversityEmail) {
      setError(`Please use a valid Gandaki University email (${UNIVERSITY_DOMAIN}).`);
      return;
    }
    if (!pwEval.hasMinLength || !pwEval.hasLetter || !pwEval.hasNumber) {
      setError('Password must be at least 8 characters and include both letters and numbers.');
      return;
    }
    if (regPassword !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setBusy(true);
    try {
      const res = await api.post<{ email: string; resendCooldownSeconds: number; devOtpPreview?: string }>(
        '/api/auth/register',
        {
          full_name: fullName.trim(),
          email: trimmedEmail,
          password: regPassword,
          confirm_password: confirmPassword,
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
        setOtpEmail(String(err.data.email || trimmedEmail));
        setDevOtpHint(err.data.devOtpPreview ? String(err.data.devOtpPreview) : null);
        setOtpCode('');
        setTab('verify_otp');
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
        notify(`Welcome, ${res.user.display_name}! Your account is verified and signed in.`, 'success');
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
        const res = await api.post<{ devOtpPreview?: string }>('/api/auth/request-password-reset', {
          email: resetEmail.trim(),
        });
        setDevOtpHint(res.devOtpPreview || null);
        setResetStep('confirm');
        notify('If the email exists, a 6-digit reset code was issued.', 'info');
      } else {
        await api.post('/api/auth/reset-password', {
          email: resetEmail.trim(),
          code: resetCode,
          new_password: resetNewPass,
        });
        notify('Password updated. Sign in with your new password.', 'success');
        setTab('login');
        setLoginEmail(resetEmail.trim());
        setResetStep('request');
        setResetCode('');
        setResetNewPass('');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Password reset failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 overflow-y-auto">
      <div className="w-full max-w-md rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xl overflow-hidden my-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-slate-800">
          <div>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">GandakiHub</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {tab === 'register'
                ? 'Create your campus account with your university email'
                : tab === 'verify_otp'
                  ? 'Confirm your 6-digit email verification code'
                  : tab === 'reset'
                    ? 'Reset your account password'
                    : 'Sign in with your email and password'}
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

        <div className="px-6 pt-3.5 flex items-center gap-2 border-b border-slate-200 dark:border-slate-800 pb-3">
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

        <div className="p-6 space-y-4 max-h-[78vh] overflow-y-auto">
          {error && (
            <div className="rounded-lg border border-red-300 dark:border-red-900 bg-red-50 dark:bg-red-950/40 px-4 py-2.5 text-xs font-medium text-red-800 dark:text-red-200">
              {error}
            </div>
          )}

          {tab === 'login' && (
            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <label htmlFor="auth-login-email" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                  Email
                </label>
                <input
                  id="auth-login-email"
                  type="email"
                  required
                  autoComplete="email"
                  value={loginEmail}
                  onChange={(e) => setLoginEmail(e.target.value)}
                  placeholder="name@gandakiuniversity.edu.np"
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label htmlFor="auth-login-password" className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                    Password
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      setResetEmail(loginEmail);
                      setResetStep('request');
                      setError('');
                      setTab('reset');
                    }}
                    className="text-xs text-blue-700 dark:text-blue-400 hover:underline"
                  >
                    Forgot password?
                  </button>
                </div>
                <div className="relative">
                  <input
                    id="auth-login-password"
                    type={showLoginPassword ? 'text' : 'password'}
                    required
                    autoComplete="current-password"
                    value={loginPassword}
                    onChange={(e) => setLoginPassword(e.target.value)}
                    placeholder="Enter your password"
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 pl-3 pr-10 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                  <button
                    type="button"
                    onClick={() => setShowLoginPassword((s) => !s)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                    aria-label={showLoginPassword ? 'Hide password' : 'Show password'}
                  >
                    {showLoginPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={busy}
                className="w-full rounded-lg bg-slate-900 dark:bg-blue-600 text-white py-2.5 px-4 text-sm font-medium hover:bg-slate-800 dark:hover:bg-blue-500 disabled:opacity-50"
              >
                {busy ? 'Signing in...' : 'Sign In'}
              </button>

              <p className="text-center text-xs text-slate-500 dark:text-slate-400">
                New to GandakiHub?{' '}
                <button
                  type="button"
                  onClick={() => {
                    setTab('register');
                    setError('');
                  }}
                  className="font-medium text-blue-700 dark:text-blue-400 hover:underline"
                >
                  Create an account
                </button>
              </p>
            </form>
          )}

          {tab === 'register' && (
            <form onSubmit={handleRegister} className="space-y-4">
              <div>
                <label htmlFor="auth-reg-name" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                  Full Name
                </label>
                <input
                  id="auth-reg-name"
                  type="text"
                  required
                  autoComplete="name"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="Sita Sharma"
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div>
                <label htmlFor="auth-reg-email" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                  Gandaki University Email
                </label>
                <input
                  id="auth-reg-email"
                  type="email"
                  required
                  autoComplete="email"
                  value={regEmail}
                  onChange={(e) => setRegEmail(e.target.value)}
                  placeholder="sita@gandakiuniversity.edu.np"
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
                <p className={`mt-1 text-[11px] ${trimmedEmail && !isUniversityEmail ? 'text-amber-700 dark:text-amber-400' : 'text-slate-500 dark:text-slate-400'}`}>
                  Must be an official <span className="font-mono">@gandakiuniversity.edu.np</span> address.
                </p>
              </div>

              <div>
                <label htmlFor="auth-reg-password" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                  Password
                </label>
                <div className="relative">
                  <input
                    id="auth-reg-password"
                    type={showRegPassword ? 'text' : 'password'}
                    required
                    autoComplete="new-password"
                    value={regPassword}
                    onChange={(e) => setRegPassword(e.target.value)}
                    placeholder="At least 8 characters with letters & numbers"
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 pl-3 pr-10 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                  <button
                    type="button"
                    onClick={() => setShowRegPassword((s) => !s)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                    aria-label={showRegPassword ? 'Hide password' : 'Show password'}
                  >
                    {showRegPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>

                {regPassword.length > 0 && (
                  <div className="mt-2 space-y-1.5">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-slate-500 dark:text-slate-400">Password strength</span>
                      <span
                        className={`font-medium ${
                          pwEval.label === 'Strong'
                            ? 'text-emerald-700 dark:text-emerald-400'
                            : pwEval.label === 'Fair'
                              ? 'text-blue-700 dark:text-blue-400'
                              : 'text-amber-700 dark:text-amber-400'
                        }`}
                      >
                        {pwEval.label}
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-1 h-1">
                      <div className={`rounded-sm ${pwEval.score >= 1 ? (pwEval.label === 'Strong' ? 'bg-emerald-600' : pwEval.label === 'Fair' ? 'bg-blue-600' : 'bg-amber-500') : 'bg-slate-200 dark:bg-slate-800'}`} />
                      <div className={`rounded-sm ${pwEval.score >= 2 ? (pwEval.label === 'Strong' ? 'bg-emerald-600' : 'bg-blue-600') : 'bg-slate-200 dark:bg-slate-800'}`} />
                      <div className={`rounded-sm ${pwEval.score >= 3 ? 'bg-emerald-600' : 'bg-slate-200 dark:bg-slate-800'}`} />
                    </div>
                    <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                      <span className={pwEval.hasMinLength ? 'text-emerald-700 dark:text-emerald-400 inline-flex items-center gap-1' : ''}>
                        {pwEval.hasMinLength && <Check className="w-3 h-3" />} 8+ chars
                      </span>
                      <span className={pwEval.hasLetter ? 'text-emerald-700 dark:text-emerald-400 inline-flex items-center gap-1' : ''}>
                        {pwEval.hasLetter && <Check className="w-3 h-3" />} Letter
                      </span>
                      <span className={pwEval.hasNumber ? 'text-emerald-700 dark:text-emerald-400 inline-flex items-center gap-1' : ''}>
                        {pwEval.hasNumber && <Check className="w-3 h-3" />} Number
                      </span>
                    </div>
                  </div>
                )}
              </div>

              <div>
                <label htmlFor="auth-reg-confirm-password" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                  Confirm Password
                </label>
                <div className="relative">
                  <input
                    id="auth-reg-confirm-password"
                    type={showConfirmPassword ? 'text' : 'password'}
                    required
                    autoComplete="new-password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Re-enter your password"
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 pl-3 pr-10 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirmPassword((s) => !s)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                    aria-label={showConfirmPassword ? 'Hide confirm password' : 'Show confirm password'}
                  >
                    {showConfirmPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                {!passwordsMatch && (
                  <p className="mt-1 text-[11px] text-red-700 dark:text-red-400">Passwords do not match.</p>
                )}
              </div>

              <button
                type="submit"
                disabled={busy || !passwordsMatch}
                className="w-full rounded-lg bg-slate-900 dark:bg-blue-600 text-white py-2.5 px-4 text-sm font-medium hover:bg-slate-800 dark:hover:bg-blue-500 disabled:opacity-50"
              >
                {busy ? 'Creating Account...' : 'Create Account & Verify Email'}
              </button>

              <p className="text-center text-xs text-slate-500 dark:text-slate-400">
                You can optionally add your program, semester, or staff verification details from your profile after signing in.
              </p>
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
                      Local OTP Preview: {devOtpHint}
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
                  {busy ? 'Verifying...' : 'Verify & Sign In'}
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
                  placeholder="name@gandakiuniversity.edu.np"
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
                    <div className="relative">
                      <input
                        type={showResetPassword ? 'text' : 'password'}
                        required
                        value={resetNewPass}
                        onChange={(e) => setResetNewPass(e.target.value)}
                        className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 pl-3 pr-10 py-2 text-sm"
                      />
                      <button
                        type="button"
                        onClick={() => setShowResetPassword((s) => !s)}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                        aria-label={showResetPassword ? 'Hide password' : 'Show password'}
                      >
                        {showResetPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
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
