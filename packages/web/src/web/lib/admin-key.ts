/**
 * Client-side storage for the admin key used to call ops endpoints
 * (requireAdminKey-gated routes — see api/voice/middleware/admin-auth.ts).
 *
 * Two auth paths coexist:
 *   1. Supabase session (email/password) — sends Authorization: Bearer <jwt>
 *   2. Legacy API key — sends X-OpenVent-Admin-Key header
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

export function adminHeaders(): Record<string, string> {
  const key = getAdminKey();
  return key ? { "X-OpenVent-Admin-Key": key } : {};
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
  return key ? { "X-OpenVent-Admin-Key": key } : {};
}
