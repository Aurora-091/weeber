/**
 * Client-side storage for the admin key used to call ops endpoints
 * (requireAdminKey-gated routes — see api/voice/middleware/admin-auth.ts).
 *
 * Two auth paths coexist:
 *   1. Supabase session (email/password) — sends Authorization: Bearer <jwt>
 *   2. Legacy API key — sends X-Weeber-Admin-Key header
 *
 * The `adminHeaders()` helper picks the appropriate header based on what's available.
 */
import { supabase } from "./supabase";

const STORAGE_KEY = "vent_admin_key";

export function getAdminKey(): string {
  return sessionStorage.getItem(STORAGE_KEY) ?? "";
}

export function setAdminKey(key: string) {
  sessionStorage.setItem(STORAGE_KEY, key);
}

export function clearAdminKey() {
  sessionStorage.removeItem(STORAGE_KEY);
}

/**
 * Bug fix (2026-08-27): `adminHeaders()` is called synchronously by every dashboard page
 * (`calls-list.tsx`, `agents.tsx`, `orgs.tsx`, … — dozens of call sites), but it used to read
 * ONLY the legacy stored key, never the Supabase session. An admin who signed in via
 * `AdminLoginForm` (session mode) has no stored key — `AdminKeyGate`'s own initial `/admin-me`
 * check passed (it awaits a fresh session token specifically), but every subsequent page-data
 * request silently sent no auth header at all and 401'd. Fixed by caching the current session's
 * access token here, kept fresh via `onAuthStateChange` (fires on sign-in, sign-out, and
 * Supabase's own automatic token refresh) plus one initial fetch at module load — so the existing
 * synchronous call sites start working for session-authenticated admins without themselves
 * needing to change. `adminHeadersAsync()` below (fetches fresh every call) remains the more
 * precise option for a call site that can await.
 */
let cachedSessionToken: string | null = null;
if (supabase) {
  void supabase.auth.getSession().then(({ data }) => {
    cachedSessionToken = data.session?.access_token ?? null;
  });
  supabase.auth.onAuthStateChange((_event, session) => {
    cachedSessionToken = session?.access_token ?? null;
  });
}

export function adminHeaders(): Record<string, string> {
  if (cachedSessionToken) return { Authorization: `Bearer ${cachedSessionToken}` };
  const key = getAdminKey();
  return key ? { "X-Weeber-Admin-Key": key } : {};
}

/**
 * Returns admin auth headers, preferring a Supabase session token over the
 * stored API key. Must be called at request time (not cached) since tokens expire.
 */
export async function adminHeadersAsync(): Promise<Record<string, string>> {
  if (supabase) {
    const { data } = await supabase.auth.getSession();
    if (data.session?.access_token) {
      return { Authorization: `Bearer ${data.session.access_token}` };
    }
  }
  const key = getAdminKey();
  return key ? { "X-Weeber-Admin-Key": key } : {};
}
