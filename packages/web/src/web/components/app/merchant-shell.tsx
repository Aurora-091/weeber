import { createContext, useContext, useEffect, useState } from "react";
import { Redirect, useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Session } from "@supabase/supabase-js";
import { LogOut, Eye } from "lucide-react";
import { supabase, supabaseConfigured } from "../../lib/supabase";
import { appFetch, getImpersonationToken, clearImpersonationToken } from "../../lib/merchant-session";
import { getVertical, type VerticalDefinition } from "../../lib/verticals";
import { useTheme } from "../../lib/theme";
import { cn } from "../../lib/utils";
import { AppShell } from "../shell/app-shell";

export type MerchantMe = {
  user: { id: string; email: string | null } | null;
  role: string | null;
  impersonated: boolean;
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

function ImpersonationBanner({ orgName }: { orgName: string }) {
  const [, navigate] = useLocation();
  return (
    <div className="flex items-center justify-between gap-3 border-b border-[var(--weeber-warning)]/40 bg-warning-soft px-4 py-2 text-sm text-foreground">
      <span className="flex items-center gap-2">
        <Eye className="size-4 text-warning" aria-hidden />
        Viewing as <strong>{orgName}</strong> — admin impersonation, all actions are audit-logged.
      </span>
      <button
        type="button"
        onClick={async () => {
          await appFetch("/api/app/impersonation/stop", { method: "POST" }).catch(() => undefined);
          clearImpersonationToken();
          navigate("/app/login");
        }}
        className="shrink-0 rounded-md border border-[var(--weeber-warning)]/50 px-2.5 py-1 text-xs font-medium hover:bg-warning-soft/60"
      >
        Stop impersonating
      </button>
    </div>
  );
}

/**
 * Auth gate + org context + shell for every /app page. Two ways in, mirroring
 * the backend middleware exactly: an admin impersonation token (per-tab
 * sessionStorage) or a Supabase session. GET /api/app/me both resolves the
 * org and performs the first-login bootstrap server-side.
 */
export function MerchantShell({ children }: { children: React.ReactNode }) {
  const impersonating = Boolean(getImpersonationToken());
  const queryClient = useQueryClient();
  // undefined = still resolving, null = definitely signed out
  const [session, setSession] = useState<Session | null | undefined>(impersonating ? null : undefined);

  useEffect(() => {
    if (impersonating || !supabase) return;
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      queryClient.invalidateQueries({ queryKey: ["app-me"] });
    });
    return () => sub.subscription.unsubscribe();
  }, [impersonating, queryClient]);

  const authed = impersonating || Boolean(session);
  const me = useQuery({
    queryKey: ["app-me"],
    enabled: authed,
    retry: false,
    queryFn: async () => {
      const res = await appFetch("/api/app/me");
      if (!res.ok) throw new Error(`me failed (${res.status})`);
      return (await res.json()) as MerchantMe;
    },
  });

  if (!impersonating) {
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
  }

  if (me.isLoading || !me.data) {
    if (me.isError) {
      const signOut = async () => {
        clearImpersonationToken();
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
        banner={me.data.impersonated ? <ImpersonationBanner orgName={me.data.org.name ?? me.data.org.id} /> : undefined}
        footer={
          me.data.impersonated ? undefined : (
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
          )
        }
      >
        {children}
      </AppShell>
    </MerchantContext.Provider>
  );
}
