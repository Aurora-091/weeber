import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { supabase } from "../../lib/supabase";
import { useTheme } from "../../lib/theme";
import { cn } from "../../lib/utils";
import { appPath } from "../../lib/route-base";

/**
 * Magic-link landing page. supabase-js (detectSessionInUrl, the default)
 * consumes the tokens from the URL itself — this page just waits for the
 * session to materialize and forwards into the app.
 */
export function MerchantAuthCallbackPage() {
  const { theme } = useTheme();
  const [, navigate] = useLocation();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!supabase) {
      setFailed(true);
      return;
    }
    let done = false;
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
            onClick={() => navigate(appPath("/login"))}
            className="mt-5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Back to sign-in
          </button>
        )}
      </div>
    </div>
  );
}
