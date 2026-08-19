import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Loader2 } from "lucide-react";
import { supabase } from "../../lib/supabase";
import { useTheme } from "../../lib/theme";
import { cn } from "../../lib/utils";
import { appPath } from "../../lib/route-base";
import { wwwUrl } from "../../lib/domains";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";

/**
 * Landing page for a password-reset email link. Same mechanism as the
 * magic-link callback (supabase-js's `detectSessionInUrl` consumes the
 * recovery token from the URL and establishes a session before this
 * component even mounts) — the only difference is what we do with that
 * session: prompt for a new password instead of just forwarding into /app.
 */
export function ResetPasswordPage() {
  const { theme } = useTheme();
  const [, navigate] = useLocation();
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!supabase) {
      setFailed(true);
      return;
    }
    let settled = false;
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY" && !settled) {
        settled = true;
        setReady(true);
      }
    });
    supabase.auth.getSession().then(({ data }) => {
      if (data.session && !settled) {
        settled = true;
        setReady(true);
      }
    });
    const timeout = setTimeout(() => {
      if (!settled) setFailed(true);
    }, 8000);
    return () => {
      sub.subscription.unsubscribe();
      clearTimeout(timeout);
    };
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase) return;
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords don't match.");
      return;
    }
    setPending(true);
    setError(null);
    const { error: authError } = await supabase.auth.updateUser({ password });
    setPending(false);
    if (authError) {
      setError(authError.message);
      return;
    }
    setDone(true);
    setTimeout(() => navigate(appPath()), 1500);
  }

  return (
    <div
      className={cn(
        "theme-weeber shell-spacious min-h-screen flex items-center justify-center px-6 bg-background text-foreground font-sans",
        theme === "dark" && "dark",
      )}
    >
      <div className="w-full max-w-sm text-center">
        {!ready && !failed && (
          <>
            <h1 className="text-xl font-medium">Verifying reset link…</h1>
            <p className="mt-2 text-sm text-muted-foreground">One moment.</p>
          </>
        )}

        {failed && (
          <>
            <h1 className="text-xl font-medium">Reset link didn't work</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              The link may have expired or already been used. Request a fresh one from the sign-in page.
            </p>
            <button
              type="button"
              onClick={() => {
                window.location.href = wwwUrl("/login");
              }}
              className="mt-5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              Back to sign-in
            </button>
          </>
        )}

        {ready && !done && (
          <div className="text-left">
            <h1 className="text-xl font-medium text-center">Set a new password</h1>
            <form onSubmit={submit} className="mt-6 flex flex-col gap-4">
              <div className="grid gap-1.5">
                <Label htmlFor="new-password">New password</Label>
                <Input
                  id="new-password"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="confirm-password">Confirm password</Label>
                <Input
                  id="confirm-password"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={8}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                />
              </div>
              <Button type="submit" disabled={pending}>
                {pending && <Loader2 className="size-4 animate-spin" aria-hidden />}
                Update password
              </Button>
            </form>
          </div>
        )}

        {done && (
          <>
            <h1 className="text-xl font-medium">Password updated</h1>
            <p className="mt-2 text-sm text-muted-foreground">Taking you to your dashboard…</p>
          </>
        )}

        {error && (
          <p className="mt-4 rounded-md bg-error-soft px-3 py-2 text-sm text-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
