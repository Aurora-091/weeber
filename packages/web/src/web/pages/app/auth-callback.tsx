import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { supabase } from "../../lib/supabase";
import { useTheme } from "../../lib/theme";
import { cn } from "../../lib/utils";
import { appPath } from "../../lib/route-base";
import { wwwUrl } from "../../lib/domains";

/**
 * Cross-domain session-handoff landing page. The login form lives on
 * weeber.ai (a different origin, since supabase-js's session storage is
 * per-origin `localStorage`) and hands a freshly-created session here via
 * the URL fragment (`#access_token=...&refresh_token=...`) after signing
 * the user in. Fragments never reach a server (no Referer, no server logs),
 * matching how Supabase's own magic-link/OAuth redirects carry tokens.
 *
 * This explicitly parses the fragment and calls `setSession()` — the
 * documented public API for adopting an externally-obtained token pair —
 * rather than relying on `detectSessionInUrl`'s implicit-grant parsing,
 * which targets Supabase's own redirect shape, not this handoff's.
 */
export function UserAuthCallbackPage() {
  const { theme } = useTheme();
  const [, navigate] = useLocation();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!supabase) {
      setFailed(true);
      return;
    }
    let done = false;

    const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const accessToken = params.get("access_token");
    const refreshToken = params.get("refresh_token");

    if (accessToken && refreshToken) {
      supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken }).then(({ error }) => {
        if (error) {
          setFailed(true);
          return;
        }
        done = true;
        history.replaceState(null, "", window.location.pathname + window.location.search);
        navigate(appPath());
      });
      return;
    }

    // No fragment tokens — fall back to the legacy magic-link path
    // (detectSessionInUrl), still used by reset-password.tsx.
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session && !done) {
        done = true;
        navigate(appPath());
      }
    });
    supabase.auth.getSession().then(({ data }) => {
      if (data.session && !done) {
        done = true;
        navigate(appPath());
      }
    });
    const timeout = setTimeout(() => {
      if (!done) setFailed(true);
    }, 8000);
    return () => {
      sub.subscription.unsubscribe();
      clearTimeout(timeout);
    };
  }, [navigate]);

  return (
    <div
      className={cn(
        "theme-weeber min-h-screen flex items-center justify-center px-6 bg-background text-foreground font-sans",
        theme === "dark" && "dark",
      )}
    >
      <div className="max-w-md text-center">
        <h1 className="text-xl font-medium">{failed ? "Sign-in link didn't work" : "Signing you in…"}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {failed
            ? "The link may have expired or already been used. Request a fresh one from the sign-in page."
            : "One moment — completing your sign-in."}
        </p>
        {failed && (
          <button
            type="button"
            onClick={() => {
              window.location.href = wwwUrl("/login");
            }}
            className="mt-5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Back to sign-in
          </button>
        )}
      </div>
    </div>
  );
}
