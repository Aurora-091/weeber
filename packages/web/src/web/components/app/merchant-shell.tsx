import { createContext, useContext, useEffect, useState } from "react";
import { Redirect } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Session } from "@supabase/supabase-js";
import { LogOut } from "lucide-react";
import { supabase, supabaseConfigured } from "../../lib/supabase";
import { appFetch } from "../../lib/merchant-session";
import { getVertical, type VerticalDefinition } from "../../lib/verticals";
import { useTheme } from "../../lib/theme";
import { cn } from "../../lib/utils";
import { AppShell } from "../shell/app-shell";

export type MerchantMe = {
  user: { id: string; email: string | null } | null;
  role: string | null;
  org: {
    id: string;
    name: string | null;
    vertical: string;
    planName: string | null;
    currency: string | null;
    countryCode: string | null;
    timezone: string | null;
    contactEmail: string | null;
  };
};

const MerchantContext = createContext<{ me: MerchantMe; vertical: VerticalDefinition } | null>(null);

export function useMerchant() {
  const ctx = useContext(MerchantContext);
  if (!ctx) throw new Error("useMerchant must be used inside MerchantShell");
  return ctx;
}

/** Full-screen themed notice used by every pre-shell state (loading/errors). */
function Notice({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  const { theme } = useTheme();
  return (
    <div
      className={cn(
        "theme-weeber min-h-screen flex items-center justify-center px-6 bg-background text-foreground font-sans",
        theme === "dark" && "dark",
      )}
    >
      <div className="max-w-md text-center">
        <h1 className="text-xl font-medium">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{body}</p>
        {action && <div className="mt-5 flex justify-center">{action}</div>}
      </div>
    </div>
  );
}

/**
 * Auth gate + org context + shell for every /app page. Supabase session
 * only (impersonation removed — see DECISIONS.md). GET /api/app/me both
 * resolves the org and performs the first-login bootstrap server-side.
 */
export function MerchantShell({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  // undefined = still resolving, null = definitely signed out
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      queryClient.invalidateQueries({ queryKey: ["app-me"] });
    });
    return () => sub.subscription.unsubscribe();
  }, [queryClient]);

  const me = useQuery({
    queryKey: ["app-me"],
    enabled: Boolean(session),
    retry: 1,
    retryDelay: 1000,
    queryFn: async () => {
      const res = await appFetch("/api/app/me");
      if (!res.ok) throw new Error(`me failed (${res.status})`);
      return (await res.json()) as MerchantMe;
    },
  });

  if (!supabaseConfigured) {
    return (
      <Notice
        title="Merchant login isn't configured"
        body="Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY at build time to enable the merchant dashboard."
      />
    );
  }
  if (session === undefined) {
    return <Notice title="Weeber" body="Checking your session…" />;
  }
  if (!session) {
    return <Redirect to="/app/login" />;
  }

  if (me.isLoading || !me.data) {
    if (me.isError) {
      const signOut = async () => {
        await supabase?.auth.signOut();
        window.location.href = "/app/login";
      };
      return (
        <Notice
          title="Couldn't load your workspace"
          body="Your session may have expired, or the server is unreachable. Sign in again — if this keeps happening, contact support."
          action={
            <button
              type="button"
              onClick={signOut}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              Back to sign-in
            </button>
          }
        />
      );
    }
    return <Notice title="Weeber" body="Loading your workspace…" />;
  }

  const vertical = getVertical(me.data.org.vertical);

  return (
    <MerchantContext.Provider value={{ me: me.data, vertical }}>
      <AppShell
        density="spacious"
        nav={vertical.nav}
        brand={<span className="font-serif text-lg font-medium tracking-tight">Weeber</span>}
        footer={
          <button
            type="button"
            onClick={async () => {
              await supabase?.auth.signOut();
              window.location.href = "/app/login";
            }}
            className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-sidebar-foreground/70 transition-colors duration-150 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
          >
            <LogOut className="size-3.5" aria-hidden />
            Sign out
          </button>
        }
      >
        {children}
      </AppShell>
    </MerchantContext.Provider>
  );
}
