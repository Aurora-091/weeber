import { createContext, useContext, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Session } from "@supabase/supabase-js";
import { LogOut } from "lucide-react";
import { supabase, supabaseConfigured } from "../../lib/supabase";
import { useTheme } from "../../lib/theme";
import { cn } from "../../lib/utils";
import { wwwUrl } from "../../lib/domains";
import { appFetch, isSigningOut, signOutToLogin } from "../../lib/user-session";
import { getVertical, type VerticalDefinition } from "../../lib/verticals";
import { AppShell } from "../shell/app-shell";
import { Button } from "../ui/button";

export type UserMe = {
  user: { id: string; email: string | null } | null;
  role: string | null;
  /** True until orgs.name is set to a real business name at onboarding —
   * orgs.name is what the agent SPEAKS on calls ({{company_name}}) and the
   * Twilio subaccount friendly name, so nothing should go live until it's a
   * real name. Drives the required business-name step in SetupModal. */
  needsOnboarding: boolean;
  org: {
    id: string;
    name: string | null;
    /** Lifecycle state: active normally; suspended after inactivity (auto-
     * reactivated on next login); closed is terminal (permanent teardown). */
    status: "active" | "suspended" | "closed";
    vertical: string;
    planName: string | null;
    currency: string | null;
    countryCode: string | null;
    timezone: string | null;
    contactEmail: string | null;
    webhookUrl: string | null;
    /** Org-wide fallback phone number transfer-to-human dials, used when the agent has no
     * `humanTransferNumber` of its own (ADR-114, see resolveTransferTarget in voice/handoff.ts).
     * No shared/global fallback exists below this (removed 2026-07-17). Null here AND on the
     * agent = transfer requests end the call gracefully instead of connecting anywhere.
     * Set from Settings' "Human Transfer" section. */
    humanTransferNumber: string | null;
    /** Non-null and in the future = calling-window compliance test mode is
     * active for this org (2026-07-16) — see Settings' toggle and Home's
     * pill. Self-expiring, always set to now()+24h by the backend. */
    callingWindowTestModeUntil: string | null;
  };
};

export type UserContextValue = {
  me: UserMe;
  vertical: VerticalDefinition;
  flags: Record<string, boolean>;
  isFlagEnabled: (key: string) => boolean;
};

// Exported so the DEV-only /__preview harness can mount real pages with a
// mock context (no backend/secrets). Not used anywhere in production code.
export const UserContext = createContext<UserContextValue | null>(null);

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
      role="status"
      aria-live="polite"
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
export function UserShell({ children }: { children: React.ReactNode }) {
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

  // Signed-out (definitely, not just still-resolving) — login lives on a
  // different origin (weeber.ai) now, so this can't be a same-origin
  // wouter <Redirect>; it needs a real cross-domain navigation.
  useEffect(() => {
    if (session === null) {
      // Deliberately NOT signOutToLogin(). This branch also covers a plain
      // unauthenticated visit (someone opens a bookmarked /app/calls), where
      // there is no app-origin session to end: awaiting auth.signOut() first
      // only delays the redirect (which left the page navigating mid-render
      // and broke the visual harness), and `?cleanup=1` would tell /login to
      // wipe the PUBLIC-origin session it is meant to hand back to the app.
      // signOutToLogin stays for the explicit, user-initiated sign-out sites,
      // and owns the redirect while one is in flight (it sets ?cleanup=1, which
      // this navigation must not overwrite).
      if (isSigningOut()) return;
      window.location.href = wwwUrl("/login");
    }
  }, [session]);

  const me = useQuery({
    queryKey: ["app-me"],
    enabled: Boolean(session),
    // A network-level failure (DNS/connectivity — fetch throws a native
    // TypeError before any Response exists) is worth a couple of retries,
    // since it's often transient. A real HTTP error response (401, 500 —
    // our own `throw new Error(...)` below, never a TypeError) is not: it
    // won't fix itself by retrying, and retrying just delays the correct
    // "sign in again" message behind a pointless wait.
    retry: (failureCount, error) => error instanceof TypeError && failureCount < 2,
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
    return <Notice title="Weeber" body="Redirecting you to sign in…" />;
  }

  if (me.isLoading || !me.data) {
    if (me.isError) {
      // A native TypeError means fetch() never got a response at all — the
      // browser couldn't reach the server (DNS, offline, a blocked/filtered
      // network). That's not an account problem, and "sign in again" is the
      // wrong advice for it: signing out doesn't fix a network that can't
      // reach us, and the next sign-in attempt would fail the exact same
      // way. Anything else here is a real response from our server (a
      // non-2xx status, thrown as a plain Error above), where "sign in
      // again" is the right call.
      const unreachable = me.error instanceof TypeError;
      return (
        <Notice
          title={unreachable ? "Can't reach Weeber" : "Couldn't load your workspace"}
          body={
            unreachable
              ? "We couldn't connect to our servers. This is usually a network issue on your end — check your connection, or try switching networks (e.g. Wi-Fi to mobile data) — not a problem with your account."
              : `Diagnostic: ${me.error?.message || "Unknown error"}. Your session may have expired. Sign in again — if this keeps happening, contact support.`
          }
          action={
            unreachable ? (
              <Button onClick={() => me.refetch()}>Try again</Button>
            ) : (
              <Button onClick={signOutToLogin}>Back to sign-in</Button>
            )
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
        nav={vertical.nav}
        brand={<span className="font-display text-base font-semibold tracking-tight">Weeber</span>}
        footer={
          <button
            type="button"
            onClick={signOutToLogin}
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
