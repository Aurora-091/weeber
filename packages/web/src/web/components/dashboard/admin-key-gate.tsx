import { useState, useEffect, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { KeyRound, LogOut } from "lucide-react";
import { getAdminKey, setAdminKey, clearAdminKey, adminHeaders } from "../../lib/admin-key";
import { apiFetch } from "../../lib/api";
import { supabase, supabaseConfigured } from "../../lib/supabase";
import { useTheme } from "../../lib/theme";
import { cn } from "../../lib/utils";
import { AdminLoginForm } from "../../pages/dashboard/admin-login";

type AuthMode = "checking" | "session" | "key-prompt" | "key-verified" | "unauthenticated";

export function AdminKeyGate({ children }: { children: ReactNode }) {
  const { theme } = useTheme();
  const [mode, setMode] = useState<AuthMode>("checking");
  const [keyInput, setKeyInput] = useState(getAdminKey());
  const [showKeyForm, setShowKeyForm] = useState(false);

  useEffect(() => {
    (async () => {
      if (supabaseConfigured && supabase) {
        const { data } = await supabase.auth.getSession();
        if (data.session) {
          setMode("session");
          return;
        }
      }
      if (getAdminKey()) {
        setMode("key-verified");
        return;
      }
      setMode("unauthenticated");
    })();
  }, []);

  const sessionCheck = useQuery({
    queryKey: ["admin-session-check", mode],
    queryFn: async () => {
      const headers: Record<string, string> = {};
      if (mode === "session" && supabase) {
        const { data } = await supabase.auth.getSession();
        if (data.session) {
          headers["Authorization"] = `Bearer ${data.session.access_token}`;
        }
      } else {
        Object.assign(headers, adminHeaders());
      }
      const res = await apiFetch("/api/voice/admin-me", { headers });
      if (res.status === 401 || res.status === 403) throw new Error("unauthorized");
      if (!res.ok) throw new Error(`unexpected ${res.status}`);
      return res.json();
    },
    enabled: mode === "session" || mode === "key-verified",
    retry: false,
  });

  if (mode === "checking") {
    return (
      <div className={cn("theme-weeber min-h-screen flex items-center justify-center bg-background", theme === "dark" && "dark")}>
        <div className="size-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if ((mode === "session" || mode === "key-verified") && sessionCheck.isSuccess) {
    return <>{children}</>;
  }

  if (mode === "session" && sessionCheck.isError) {
    return (
      <GateShell theme={theme}>
        <p className="text-sm text-destructive mb-4">
          Your account is not a platform admin. Contact your administrator to get access.
        </p>
        <button
          onClick={async () => {
            if (supabase) await supabase.auth.signOut();
            setMode("unauthenticated");
          }}
          className="text-sm text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
        >
          <LogOut className="size-3" /> Sign out and try again
        </button>
      </GateShell>
    );
  }

  if (mode === "key-verified" && sessionCheck.isError) {
    clearAdminKey();
    setMode("unauthenticated");
  }

  return (
    <GateShell theme={theme}>
      {!showKeyForm ? (
        <>
          <AdminLoginForm
            onSuccess={() => {
              setMode("session");
            }}
            onFallbackKey={() => setShowKeyForm(true)}
          />
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setAdminKey(keyInput);
            setMode("key-verified");
          }}
          className="flex flex-col gap-3"
        >
          <input
            type="password"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            placeholder="Admin API key"
            aria-label="Admin key"
            className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm font-mono outline-none focus:ring-2 focus:ring-ring/40"
          />
          <button
            type="submit"
            className="w-full rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:bg-primary/90 transition-colors"
          >
            Unlock dashboard
          </button>
          {sessionCheck.isError && mode === "key-verified" && (
            <p className="text-sm text-destructive">Invalid access key.</p>
          )}
          <button
            type="button"
            onClick={() => setShowKeyForm(false)}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Back to email sign-in
          </button>
        </form>
      )}
    </GateShell>
  );
}

function GateShell({ children, theme }: { children: ReactNode; theme: string }) {
  return (
    <div
      className={cn(
        "theme-weeber min-h-screen flex items-center justify-center px-6 bg-background text-foreground font-sans",
        theme === "dark" && "dark",
      )}
    >
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2 text-primary mb-4">
          <KeyRound className="size-5" />
          <span className="font-mono text-xs uppercase tracking-[0.2em]">Admin access</span>
        </div>
        <h1 className="text-2xl font-semibold mb-2">Sign in to the dashboard</h1>
        <p className="text-sm text-muted-foreground mb-6">
          Use your admin credentials or an API key to access the platform.
        </p>
        {children}
      </div>
    </div>
  );
}
