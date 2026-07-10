import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Loader2, Mail } from "lucide-react";
import { supabase, supabaseConfigured } from "../../lib/supabase";
import { useTheme } from "../../lib/theme";
import { cn } from "../../lib/utils";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../../components/ui/tabs";

type Mode = "signin" | "signup";

export function MerchantLoginPage() {
  const { theme } = useTheme();
  const [, navigate] = useLocation();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [magicLinkSent, setMagicLinkSent] = useState(false);

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
    const { error: authError } =
      mode === "signin"
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password });
    setPending(false);
    if (authError) {
      setError(authError.message);
      return;
    }
    navigate("/app");
  }

  async function submitMagicLink(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase) return;
    setPending(true);
    setError(null);
    const { error: authError } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/app/auth/callback` },
    });
    setPending(false);
    if (authError) {
      setError(authError.message);
      return;
    }
    setMagicLinkSent(true);
  }

  return (
    <div
      className={cn(
        "theme-weeber shell-spacious min-h-screen flex items-center justify-center px-6 bg-background text-foreground font-sans",
        theme === "dark" && "dark",
      )}
    >
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-medium tracking-tight">Weeber</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">Voice agents for your store.</p>
        </div>

        {!supabaseConfigured ? (
          <p className="text-center text-sm text-muted-foreground">
            Merchant login isn't configured — set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.
          </p>
        ) : (
          <Tabs defaultValue="password">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="password">Password</TabsTrigger>
              <TabsTrigger value="magic">Magic link</TabsTrigger>
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
                  <Label htmlFor="password">Password</Label>
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

            <TabsContent value="magic">
              {magicLinkSent ? (
                <div className="mt-6 text-center">
                  <Mail className="mx-auto size-6 text-primary" aria-hidden />
                  <h2 className="mt-3 text-lg font-medium">Check your inbox</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    We sent a sign-in link to {email}. It signs you in on this device.
                  </p>
                </div>
              ) : (
                <form onSubmit={submitMagicLink} className="mt-4 flex flex-col gap-4">
                  <div className="grid gap-1.5">
                    <Label htmlFor="magic-email">Email</Label>
                    <Input
                      id="magic-email"
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
                    Email me a sign-in link
                  </Button>
                </form>
              )}
            </TabsContent>
          </Tabs>
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
