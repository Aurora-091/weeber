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

export async function merchantHeaders(): Promise<Record<string, string>> {
  const impersonation = getImpersonationToken();
  if (impersonation) return { "X-Weeber-Impersonation": impersonation };
  if (!supabase) return {};
  const { data } = await supabase.auth.getSession();
  return data.session ? { Authorization: `Bearer ${data.session.access_token}` } : {};
}

/** apiFetch with the merchant auth headers injected — what /app pages call. */
export async function appFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = { ...(init.headers as Record<string, string> | undefined), ...(await merchantHeaders()) };
  return apiFetch(path, { ...init, headers });
}
