import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Loader as Loader2, Mail } from "lucide-react";
import { supabase, supabaseConfigured } from "../../lib/supabase";
import { useTheme } from "../../lib/theme";
import { cn } from "../../lib/utils";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../../components/ui/tabs";

type Mode = "signin" | "signup";
/** Password-signup post-submit states:
 * - "idle"/"password-form": normal form
 * - "needs-confirmation": signUp() succeeded but returned no session — the
 *   Supabase project requires email confirmation before a session exists.
 *   The confirmation email carries a 6-digit code (OTP-only templates,
 *   ADR-043 — no link), verified inline on this same screen. */
type SignupState = "idle" | "needs-confirmation";

export function MerchantLoginPage() {
  const { theme } = useTheme();
  const [, navigate] = useLocation();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [codeSent, setCodeSent] = useState(false);
  const [signupState, setSignupState] = useState<SignupState>("idle");
  const [otpCode, setOtpCode] = useState("");
  const [resendState, setResendState] = useState<"idle" | "sending" | "sent">("idle");

  // Forgot-password flow (OTP-based, no redirect URL dependency)
  const [forgotOpen, setForgotOpen] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);
  const [forgotCode, setForgotCode] = useState("");
  const [forgotVerified, setForgotVerified] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [resetDone, setResetDone] = useState(false);

  // Already signed in? Straight to the app.
  useEffect(() => {
    supabase?.auth.getSession().then(({ data }) => {
      if (data.session) navigate("/app");
    });
  }, [navigate]);

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase) return;
    setPending(true);
    setError(null);

    if (mode === "signin") {
      const { error: authError } = await supabase.auth.signInWithPassword({ email, password });
      setPending(false);
      if (authError) {
        setError(authError.message);
        return;
      }
      navigate("/app");
      return;
    }

    // Signup — Supabase returns a session immediately only when email
    // confirmation is off for this project. When confirmation is required,
    // `data.session` is null and no error is raised either — that's the
    // signal to show the confirmation step, not a failure.
    const { data, error: authError } = await supabase.auth.signUp({ email, password });
    setPending(false);
    if (authError) {
      setError(authError.message);
      return;
    }
    if (data.session) {
      navigate("/app");
      return;
    }
    setSignupState("needs-confirmation");
  }

  async function submitOtpCode(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase || !otpCode.trim()) return;
    setPending(true);
    setError(null);
    const { error: authError } = await supabase.auth.verifyOtp({
      email,
      token: otpCode.trim(),
      type: "signup",
    });
    setPending(false);
    if (authError) {
      setError(authError.message);
      return;
    }
    navigate("/app");
  }

  async function resendConfirmation() {
    if (!supabase) return;
    setResendState("sending");
    const { error: authError } = await supabase.auth.resend({ type: "signup", email });
    setResendState("sent");
    if (authError) setError(authError.message);
  }

  // Passwordless sign-in, step 1: email the 6-digit code. OTP-only on
  // purpose (ADR-043) — the email template renders {{ .Token }}, not a
  // magic-link URL, so no emailRedirectTo/redirect-allowlist dependency.
  async function submitEmailCode(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase) return;
    setPending(true);
    setError(null);
    const { error: authError } = await supabase.auth.signInWithOtp({ email });
    setPending(false);
    if (authError) {
      setError(authError.message);
      return;
    }
    setOtpCode("");
    setResendState("idle");
    setCodeSent(true);
  }

  // Passwordless sign-in, step 2: verify the code. type "email" covers both
  // an existing user's sign-in code and a brand-new user created by
  // signInWithOtp; the password-signup flow keeps its own type "signup".
  async function submitSigninCode(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase || otpCode.trim().length < 6) return;
    setPending(true);
    setError(null);
    const { error: authError } = await supabase.auth.verifyOtp({
      email,
      token: otpCode.trim(),
      type: "email",
    });
    setPending(false);
    if (authError) {
      setError(authError.message);
      return;
    }
    navigate("/app");
  }

  async function resendSigninCode() {
    if (!supabase) return;
    setResendState("sending");
    const { error: authError } = await supabase.auth.signInWithOtp({ email });
    setResendState("sent");
    if (authError) setError(authError.message);
  }

  async function submitForgotPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase || !email.trim()) return;
    setPending(true);
    setError(null);
    const { error: authError } = await supabase.auth.resetPasswordForEmail(email);
    setPending(false);
    if (authError) {
      setError(authError.message);
      return;
    }
    setForgotSent(true);
  }

  async function submitForgotCode(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase || forgotCode.trim().length < 6) return;
    setPending(true);
    setError(null);
    const { error: authError } = await supabase.auth.verifyOtp({
      email,
      token: forgotCode.trim(),
      type: "recovery",
    });
    setPending(false);
    if (authError) {
      setError(authError.message);
      return;
    }
    setForgotVerified(true);
  }

  async function submitNewPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase) return;
    if (newPassword.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (newPassword !== confirmNewPassword) {
      setError("Passwords don't match.");
      return;
    }
    setPending(true);
    setError(null);
    const { error: authError } = await supabase.auth.updateUser({ password: newPassword });
    setPending(false);
    if (authError) {
      setError(authError.message);
      return;
    }
    setResetDone(true);
    setTimeout(() => navigate("/app"), 1500);
  }

  const shellClass = cn(
    "theme-weeber shell-spacious min-h-screen flex items-center justify-center px-6 bg-background text-foreground font-sans",
    theme === "dark" && "dark",
  );

  if (!supabaseConfigured) {
    return (
      <div className={shellClass}>
        <p className="text-center text-sm text-muted-foreground">
          Merchant login isn't configured — set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.
        </p>
      </div>
    );
  }

  // Post-signup confirmation step — shown instead of the form once signUp()
  // comes back with no session.
  if (signupState === "needs-confirmation") {
    return (
      <div className={shellClass}>
        <div className="w-full max-w-sm text-center">
          <Mail className="mx-auto size-6 text-primary" aria-hidden />
          <h1 className="mt-3 text-xl font-medium">Confirm your account</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            We sent a confirmation email to <span className="text-foreground">{email}</span>. Enter the 6-digit code
            from it below.
          </p>

          <form onSubmit={submitOtpCode} className="mt-6 flex flex-col gap-3">
            <Input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              value={otpCode}
              onChange={(e) => setOtpCode(e.target.value)}
              className="text-center tracking-widest"
              maxLength={6}
            />
            <Button type="submit" disabled={pending || otpCode.trim().length < 6}>
              {pending && <Loader2 className="size-4 animate-spin" aria-hidden />}
              Verify code
            </Button>
          </form>

          <button
            type="button"
            className="mt-4 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
            onClick={resendConfirmation}
            disabled={resendState === "sending"}
          >
            {resendState === "sent" ? "Email resent — check your inbox" : "Didn't get it? Resend"}
          </button>

          <button
            type="button"
            className="mt-6 block w-full text-sm text-muted-foreground hover:text-foreground"
            onClick={() => {
              setSignupState("idle");
              setMode("signin");
            }}
          >
            Back to sign-in
          </button>

          {error && (
            <p className="mt-4 rounded-md bg-error-soft px-3 py-2 text-sm text-error" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
    );
  }

  // Forgot-password flow — OTP-based, 3 steps inline: email → code → new password.
  if (forgotOpen) {
    return (
      <div className={shellClass}>
        <div className="w-full max-w-sm">
          {resetDone ? (
            <div className="text-center">
              <h1 className="text-xl font-medium">Password updated</h1>
              <p className="mt-2 text-sm text-muted-foreground">Taking you to your dashboard…</p>
            </div>
          ) : forgotVerified ? (
            <div className="text-left">
              <h1 className="text-xl font-medium text-center">Set a new password</h1>
              <form onSubmit={submitNewPassword} className="mt-6 flex flex-col gap-4">
                <div className="grid gap-1.5">
                  <Label htmlFor="new-pw">New password</Label>
                  <Input
                    id="new-pw"
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={8}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="confirm-pw">Confirm password</Label>
                  <Input
                    id="confirm-pw"
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={8}
                    value={confirmNewPassword}
                    onChange={(e) => setConfirmNewPassword(e.target.value)}
                  />
                </div>
                <Button type="submit" disabled={pending}>
                  {pending && <Loader2 className="size-4 animate-spin" aria-hidden />}
                  Update password
                </Button>
              </form>
            </div>
          ) : forgotSent ? (
            <div className="text-center">
              <Mail className="mx-auto size-6 text-primary" aria-hidden />
              <h1 className="mt-3 text-xl font-medium">Check your inbox</h1>
              <p className="mt-1.5 text-sm text-muted-foreground">
                We sent a 6-digit reset code to <span className="text-foreground">{email}</span>. Enter it below.
              </p>
              <form onSubmit={submitForgotCode} className="mt-5 flex flex-col gap-3">
                <Input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123456"
                  value={forgotCode}
                  onChange={(e) => setForgotCode(e.target.value)}
                  className="text-center tracking-widest"
                  maxLength={6}
                />
                <Button type="submit" disabled={pending || forgotCode.trim().length < 6}>
                  {pending && <Loader2 className="size-4 animate-spin" aria-hidden />}
                  Verify code
                </Button>
              </form>
            </div>
          ) : (
            <>
              <h1 className="text-xl font-medium">Reset your password</h1>
              <p className="mt-1.5 text-sm text-muted-foreground">
                Enter your account email and we'll send you a 6-digit reset code.
              </p>
              <form onSubmit={submitForgotPassword} className="mt-6 flex flex-col gap-4">
                <div className="grid gap-1.5">
                  <Label htmlFor="forgot-email">Email</Label>
                  <Input
                    id="forgot-email"
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@yourstore.com"
                  />
                </div>
                <Button type="submit" disabled={pending}>
                  {pending && <Loader2 className="size-4 animate-spin" aria-hidden />}
                  Send reset code
                </Button>
              </form>
            </>
          )}
          {!resetDone && (
            <button
              type="button"
              className="mt-6 block w-full text-center text-sm text-muted-foreground hover:text-foreground"
              onClick={() => {
                setForgotOpen(false);
                setForgotSent(false);
                setForgotVerified(false);
                setForgotCode("");
                setNewPassword("");
                setConfirmNewPassword("");
                setResetDone(false);
              }}
            >
              Back to sign-in
            </button>
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

  return (
    <div className={shellClass}>
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-medium tracking-tight">Weeber</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">Voice agents for your store.</p>
        </div>

        <Tabs defaultValue="password">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="password">Password</TabsTrigger>
            <TabsTrigger value="code">Email code</TabsTrigger>
          </TabsList>

          <TabsContent value="password">
            <form onSubmit={submitPassword} className="mt-4 flex flex-col gap-4">
              <div className="grid gap-1.5">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@yourstore.com"
                />
              </div>
              <div className="grid gap-1.5">
                <div className="flex items-center justify-between">
                  <Label htmlFor="password">Password</Label>
                  {mode === "signin" && (
                    <button
                      type="button"
                      className="text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => setForgotOpen(true)}
                    >
                      Forgot password?
                    </button>
                  )}
                </div>
                <Input
                  id="password"
                  type="password"
                  autoComplete={mode === "signin" ? "current-password" : "new-password"}
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              <Button type="submit" disabled={pending}>
                {pending && <Loader2 className="size-4 animate-spin" aria-hidden />}
                {mode === "signin" ? "Sign in" : "Create account"}
              </Button>
              <button
                type="button"
                className="text-sm text-muted-foreground hover:text-foreground"
                onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
              >
                {mode === "signin" ? "New to Weeber? Create an account" : "Already have an account? Sign in"}
              </button>
            </form>
          </TabsContent>

          <TabsContent value="code">
            {codeSent ? (
              <div className="mt-6 text-center">
                <Mail className="mx-auto size-6 text-primary" aria-hidden />
                <h2 className="mt-3 text-lg font-medium">Check your inbox</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  We sent a 6-digit sign-in code to <span className="text-foreground">{email}</span>. Enter it below.
                </p>
                <form onSubmit={submitSigninCode} className="mt-5 flex flex-col gap-3">
                  <Input
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="123456"
                    value={otpCode}
                    onChange={(e) => setOtpCode(e.target.value)}
                    className="text-center tracking-widest"
                    maxLength={6}
                  />
                  <Button type="submit" disabled={pending || otpCode.trim().length < 6}>
                    {pending && <Loader2 className="size-4 animate-spin" aria-hidden />}
                    Verify &amp; sign in
                  </Button>
                </form>
                <button
                  type="button"
                  className="mt-4 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
                  onClick={resendSigninCode}
                  disabled={resendState === "sending"}
                >
                  {resendState === "sent" ? "Code resent — check your inbox" : "Didn't get it? Resend"}
                </button>
                <button
                  type="button"
                  className="mt-2 block w-full text-sm text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    setCodeSent(false);
                    setOtpCode("");
                  }}
                >
                  Use a different email
                </button>
              </div>
            ) : (
              <form onSubmit={submitEmailCode} className="mt-4 flex flex-col gap-4">
                <div className="grid gap-1.5">
                  <Label htmlFor="code-email">Email</Label>
                  <Input
                    id="code-email"
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@yourstore.com"
                  />
                </div>
                <Button type="submit" disabled={pending}>
                  {pending && <Loader2 className="size-4 animate-spin" aria-hidden />}
                  Email me a sign-in code
                </Button>
              </form>
            )}
          </TabsContent>
        </Tabs>

        {error && (
          <p className="mt-4 rounded-md bg-error-soft px-3 py-2 text-sm text-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
