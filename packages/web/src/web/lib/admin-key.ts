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
  return key ? { "X-Weeber-Admin-Key": key } : {};
}
