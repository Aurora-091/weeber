import { apiFetch } from "./api";
import { supabase } from "./supabase";

/**
 * Merchant-side request auth — the /app counterpart of lib/admin-key.ts's
 * adminHeaders(). Two credential types, checked in order:
 *   1. An admin impersonation token (sessionStorage, per-tab — the
 *      impersonate flow opens /app in a new tab and stashes it there).
 *   2. The Supabase session's access token as a bearer header.
 */
const IMPERSONATION_KEY = "weeber_impersonation_token";
const IMPERSONATION_SESSION_ID_KEY = "weeber_impersonation_session_id";

export function getImpersonationToken(): string {
  return sessionStorage.getItem(IMPERSONATION_KEY) ?? "";
}

export function setImpersonationToken(token: string, sessionId: number) {
  sessionStorage.setItem(IMPERSONATION_KEY, token);
  sessionStorage.setItem(IMPERSONATION_SESSION_ID_KEY, String(sessionId));
}

export function clearImpersonationToken() {
  sessionStorage.removeItem(IMPERSONATION_KEY);
  sessionStorage.removeItem(IMPERSONATION_SESSION_ID_KEY);
}

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

export async function merchantHeaders(): Promise<Record<string, string>> {
  const impersonation = getImpersonationToken();
  if (impersonation) return { "X-Weeber-Impersonation": impersonation };
  const token = await getFreshAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** appFetch with merchant auth headers + single retry on 401 (token refresh race). */
export async function appFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = { ...(init.headers as Record<string, string> | undefined), ...(await merchantHeaders()) };
  const res = await apiFetch(path, { ...init, headers });
  if (res.status === 401 && !getImpersonationToken()) {
    const freshToken = await getFreshAccessToken();
    if (freshToken) {
      const retryHeaders = { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${freshToken}` };
      return apiFetch(path, { ...init, headers: retryHeaders });
    }
  }
  return res;
}
