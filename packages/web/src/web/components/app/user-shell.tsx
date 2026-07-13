import { createContext, useContext, useEffect, useState } from "react";
import { Redirect } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Session } from "@supabase/supabase-js";
import { LogOut } from "lucide-react";
import { supabase, supabaseConfigured } from "../../lib/supabase";
import { useTheme } from "../../lib/theme";
import { cn } from "../../lib/utils";
import { appFetch } from "../../lib/user-session";
import { getVertical, type VerticalDefinition } from "../../lib/verticals";
import { appPath } from "../../lib/route-base";
import { AppShell } from "../shell/app-shell";

export type UserMe = {
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
    webhookUrl: string | null;
  };
};

const UserContext = createContext<{
  me: UserMe;
  vertical: VerticalDefinition;
  flags: Record<string, boolean>;
  isFlagEnabled: (key: string) => boolean;
} | null>(null);

export function useUser() {
  const ctx = useContext(UserContext);
  if (!ctx) throw new Error("useUser must be used inside UserShell");
  return ctx;
}



/** Full-screen themed notice used by every pre-shell state (loading/errors). */
function Notice({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  const { theme } = useTheme();
  return (
    <div
      className={cn(
        "theme-weeber shell-spacious min-h-screen flex flex-col items-center justify-center px-6",
        "bg-background text-foreground font-sans",
        theme === "dark" && "dark",
      )}
    >
      <div className="mb-8">
        <div className="flex size-10 items-center justify-center rounded-xl bg-primary shadow-sm">
          <span className="font-display text-base font-bold text-primary-foreground select-none">W</span>
        </div>
      </div>
      <div className="max-w-md text-center">
        <h1 className="font-display text-xl font-semibold">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{body}</p>
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
export function UserShell({ children, fullBleed }: { children: React.ReactNode; fullBleed?: boolean }) {
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
      return (await res.json()) as UserMe;
    },
  });

  // Org-scoped feature flags, set by admins via the dashboard's Flags page
  // (`getEffectiveFlags` — org rows overlay global rows). Wired here as
  // plumbing only: no page currently gates behavior on a specific key. Read
  // with `useUser().isFlagEnabled("some-key")` wherever a staged rollout is
  // needed — deciding *what* to gate is a separate product call.
  const flagsQuery = useQuery({
    queryKey: ["app-flags"],
    enabled: Boolean(session) && Boolean(me.data),
    staleTime: 60_000,
    queryFn: async () => {
      const res = await appFetch("/api/app/flags");
      if (!res.ok) throw new Error(`flags failed (${res.status})`);
      return (await res.json()) as { flags: Record<string, boolean> };
    },
  });
  const flags = flagsQuery.data?.flags ?? {};

  if (!supabaseConfigured) {
    return (
      <Notice
        title="User login isn't configured"
        body="Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY at build time to enable the user dashboard."
      />
    );
  }
  if (session === undefined) {
    return <Notice title="Weeber" body="Checking your session…" />;
  }
  if (!session) {
    return <Redirect to={appPath("/login")} />;
  }

  if (me.isLoading || !me.data) {
    if (me.isError) {
      const signOut = async () => {
        await supabase?.auth.signOut();
        window.location.href = appPath("/login");
      };
      return (
        <Notice
          title="Couldn't load your workspace"
          body="Your session may have expired, or the server is unreachable. Sign in again — if this keeps happening, contact support."
          action={
            <button
              type="button"
              onClick={signOut}
              className="rounded-md bg-primary px-5 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 active:scale-[0.97]"
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
    <UserContext.Provider
      value={{ me: me.data, vertical, flags, isFlagEnabled: (key) => flags[key] === true }}
    >
      <AppShell
        density="spacious"
        collapsible
        fullBleed={fullBleed}
        nav={vertical.nav}
        brand={<span className="font-display text-base font-semibold tracking-tight">Weeber</span>}
        footer={
          <button
            type="button"
            onClick={async () => {
              await supabase?.auth.signOut();
              window.location.href = appPath("/login");
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
    </UserContext.Provider>
  );
}
