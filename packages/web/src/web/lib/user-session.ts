import { apiFetch } from "./api";
import { supabase } from "./supabase";
import { wwwUrl } from "./domains";

/**
 * User-side request auth — the /app counterpart of lib/admin-key.ts's
 * adminHeaders(). Supabase session only (impersonation removed — see
 * DECISIONS.md).
 */
async function getFreshAccessToken(): Promise<string | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session) return null;
  const exp = data.session.expires_at;
  if (exp && exp * 1000 - Date.now() < 60_000) {
    const { data: refreshed } = await supabase.auth.refreshSession();
    return refreshed.session?.access_token ?? data.session.access_token;
  }
  return data.session.access_token;
}

export async function userHeaders(): Promise<Record<string, string>> {
  const token = await getFreshAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** appFetch with user auth headers + single retry on 401 (token refresh race). */
export async function appFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = { ...(init.headers as Record<string, string> | undefined), ...(await userHeaders()) };
  const res = await apiFetch(path, { ...init, headers });
  if (res.status === 401) {
    const freshToken = await getFreshAccessToken();
    if (freshToken) {
      const retryHeaders = { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${freshToken}` };
      return apiFetch(path, { ...init, headers: retryHeaders });
    }
  }
  return res;
}

/**
 * The one way any /app page ends a session — always lands back on the
 * public login page with a one-shot `?cleanup=1` marker, even when the
 * remote signOut() call itself fails (network blip, already-revoked
 * session). The marker tells /login to clear ITS OWN origin-local Supabase
 * session before rendering, instead of auto-handing it back into the app
 * (weeber.ai and app.weeber.ai are separate origins with separate
 * localStorage-backed sessions — signing out here does not touch that
 * copy). Without this, a stale/still-live public-origin session could get
 * replayed right back into the app the moment the user lands on /login.
 */
export async function signOutToLogin(): Promise<void> {
  try {
    await supabase?.auth.signOut();
  } catch {
    // Best-effort — still navigate below so the user isn't stranded on a
    // page that thinks it's signed out but can't reach the API to prove it.
  }
  window.location.href = `${wwwUrl("/login")}?cleanup=1`;
}
