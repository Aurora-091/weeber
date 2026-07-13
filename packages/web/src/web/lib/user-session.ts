import { apiFetch } from "./api";
import { supabase } from "./supabase";

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
