"use client";

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTheme } from 'next-themes';
import { CircleAlert, Eye, EyeOff, Info, Loader2, MonitorSmartphone, Moon, RefreshCw, ShieldCheck, Sun } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { EmorLogo, EmorWordmark } from '@/components/emor/logo';
import { ApiError, ADMIN_SESSION_EXPIRED_EVENT } from '@/lib/api-client';
import {
  ADMIN_SESSION_QUERY_KEY,
  useAdminLogin,
  useAdminSession,
} from '@/hooks/use-admin-session';

/** Branded full-screen splash shown while the session check is in flight. */
function SessionSplash() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-background" aria-busy="true">
      <EmorLogo size={40} className="animate-pulse" />
      <p className="text-sm text-muted-foreground">Checking your administrator session…</p>
    </div>
  );
}

function GateThemeToggle() {
  const { theme, setTheme } = useTheme();
  const next = theme === 'dark' ? 'light' : 'system';
  const Icon = theme === 'dark' ? Sun : theme === 'light' ? MonitorSmartphone : Moon;
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-11 w-11 p-0 text-muted-foreground"
      onClick={() => setTheme(next)}
      aria-label={`Switch theme to ${next}`}
      title={`Theme: ${theme ?? 'system'} (click for ${next})`}
    >
      <Icon className="size-4" />
    </Button>
  );
}

/**
 * The administrator login card. Handles 401 invalid_admin_password, 429
 * rate-limit/lockout with a live retryAfterSec countdown, 503 provisioning
 * guidance, and the session-expired notice triggered by any dashboard call.
 */
function AdminLoginCard({ sessionError, onLoginSuccess }: { sessionError: string | null; onLoginSuccess: () => void }) {
  const login = useAdminLogin();
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lockout, setLockout] = useState(0);

  useEffect(() => {
    if (lockout <= 0) return;
    const timer = setInterval(() => setLockout((v) => Math.max(0, v - 1)), 1000);
    return () => clearInterval(timer);
  }, [lockout]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || login.isPending || lockout > 0) return;
    setError(null);
    try {
      await login.mutateAsync(password);
      toast.success('Administrator session started.');
      setPassword('');
      onLoginSuccess();
    } catch (err) {
      const apiErr = err as ApiError;
      const retryAfter = apiErr.details?.retryAfterSec;
      if (typeof retryAfter === 'number' && retryAfter > 0) setLockout(Math.ceil(retryAfter));
      setError(apiErr.message || 'Login failed. Try again.');
    }
  };

  const busy = login.isPending;
  const locked = lockout > 0;

  return (
    <form onSubmit={submit} className="w-full max-w-sm space-y-5 rounded-2xl border bg-card p-6 shadow-sm sm:p-7" aria-labelledby="admin-login-title">
      <div className="space-y-3">
        <div className="flex items-center gap-2.5">
          <EmorLogo size={34} />
          <EmorWordmark className="text-lg" />
        </div>
        <div className="space-y-1.5">
          <h1 id="admin-login-title" className="text-xl font-semibold tracking-tight">
            Administrator access
          </h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            This dashboard administers provider accounts, routing and billing for the whole installation.
            Enter the administrator password to continue.
          </p>
        </div>
      </div>

      {sessionError && (
        <p className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400" role="status">
          <Info className="mt-0.5 size-3.5 shrink-0" />
          Could not verify your session ({sessionError}). You can still try logging in below.
        </p>
      )}

      <div className="space-y-2">
        <Label htmlFor="admin-password">Password</Label>
        <div className="relative">
          <Input
            id="admin-password"
            type={visible ? 'text' : 'password'}
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy || locked}
            className="h-11 pr-12"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'admin-login-error' : undefined}
            placeholder="Administrator password"
            maxLength={1024}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="absolute right-0.5 top-0.5 h-10 w-10 p-0 text-muted-foreground"
            onClick={() => setVisible((v) => !v)}
            aria-label={visible ? 'Hide password' : 'Show password'}
          >
            {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </Button>
        </div>
        {error && (
          <p id="admin-login-error" className="flex items-start gap-1.5 text-xs text-destructive" role="alert">
            <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
            {error}
          </p>
        )}
        {locked && (
          <p className="text-xs text-muted-foreground" role="status">
            Too many attempts — retry in {lockout}s.
          </p>
        )}
      </div>

      <Button type="submit" className="h-11 w-full gap-2" disabled={!password || busy || locked}>
        {busy ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
        {busy ? 'Signing in…' : 'Unlock dashboard'}
      </Button>

      <p className="text-center text-[11px] leading-relaxed text-muted-foreground">
        Sessions last 24 hours and are revoked on logout. All dashboard mutations are CSRF-protected.
      </p>
    </form>
  );
}

/**
 * Gate around the whole dashboard: splash while the session check runs,
 * the login card when unauthenticated, children when authenticated.
 * Listens for `emor:admin-session-expired` (dispatched by the API client on
 * any 401 admin_auth_required) and flips back to the login card.
 */
export function AdminGate({ children }: { children: React.ReactNode }) {
  const session = useAdminSession();
  const qc = useQueryClient();
  const notifiedExpiry = useRef(false);
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    const onExpired = () => {
      // Park the session query as logged-out WITHOUT refetching (the failing
      // GET /api/admin/auth/session itself dispatches this event).
      qc.setQueryData(ADMIN_SESSION_QUERY_KEY, { authenticated: false });
      // Suppress the notice on a cold start: only flag expiry when the event
      // arrives while a session was (or was believed to be) active.
      if (session.data?.authenticated && !notifiedExpiry.current) {
        notifiedExpiry.current = true;
        setExpired(true);
        toast.error('Administrator session ended — log in again.');
      }
    };
    window.addEventListener(ADMIN_SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(ADMIN_SESSION_EXPIRED_EVENT, onExpired);
  }, [qc, session.data]);

  const onLoginSuccess = () => {
    setExpired(false);
    notifiedExpiry.current = false;
  };

  if (session.isLoading && session.data === undefined) {
    return <SessionSplash />;
  }

  if (session.data?.authenticated) {
    return <>{children}</>;
  }

  const sessionError = session.error ? String((session.error as Error).message) : null;

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="flex h-13 shrink-0 items-center justify-between border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <EmorLogo size={24} />
          <EmorWordmark className="text-sm" />
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">console</span>
        </div>
        <GateThemeToggle />
      </header>
      <main className="flex flex-1 items-center justify-center px-4 py-10">
        <div className="w-full max-w-sm space-y-4">
          {expired && (
            <p className="flex items-start gap-1.5 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400" role="status">
              <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
              Your administrator session ended. Log in again to continue where you left off.
            </p>
          )}
          <AdminLoginCard sessionError={sessionError} onLoginSuccess={onLoginSuccess} />
          {sessionError && (
            <div className="text-center">
              <Button
                variant="ghost"
                size="sm"
                className="h-9 gap-1.5 text-xs text-muted-foreground"
                onClick={() => void session.refetch()}
                aria-label="Retry session check"
              >
                <RefreshCw className="size-3" />
                Retry session check
              </Button>
            </div>
          )}
        </div>
      </main>
      <footer className="mt-auto border-t px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <p className="mx-auto max-w-md text-center text-[11px] leading-relaxed text-muted-foreground">
          EmorAI administrator console — single-owner installation. Provider credentials never reach this browser.
        </p>
      </footer>
    </div>
  );
}
