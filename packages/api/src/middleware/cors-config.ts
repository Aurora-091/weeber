/**
 * Cross-origin policy config for the split deploy (frontend on Vercel, API on Railway — ADR-035).
 * Extracted from index.ts (audit 2026-07-19 finding #3) so the "fail closed in production, permit
 * reflect-any in dev" logic is unit-testable without importing the whole app entrypoint (which
 * pulls in the full route tree, telephony clients, etc).
 *
 * `CORS_ALLOWED_ORIGINS`: comma-separated origin allowlist (e.g.
 * "https://app.weeber.ai,https://admin.weeber.ai"). Unset behavior depends on environment:
 * - `NODE_ENV=production` and unset -> **refuse to boot**. The permissive reflect-any fallback
 *   was flagged by the audit as a config-hygiene gap; low real-world risk today (Bearer-header
 *   auth, no cookies, so `credentials: true` reflection doesn't grant a CSRF/credential-theft
 *   path) but still worth failing loudly rather than silently degrading, since it's a one-line
 *   env var to set and Railway prod already has it configured.
 * - any other NODE_ENV (dev/test/unset) and unset -> reflect any origin, unchanged from before —
 *   local dev and CI must keep working with zero required config.
 */
export function getAllowedOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.CORS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

export function assertCorsConfiguredForProduction(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV === "production" && getAllowedOrigins(env).length === 0) {
    throw new Error(
      "CORS_ALLOWED_ORIGINS must be set in production (comma-separated origin allowlist) — " +
        "refusing to boot with the permissive reflect-any-origin fallback. Set it to your " +
        "actual frontend origin(s), e.g. https://app.weeber.ai,https://admin.weeber.ai,https://www.weeber.ai",
    );
  }
}

export function buildCorsOriginResolver(env: NodeJS.ProcessEnv = process.env) {
  const allowedOrigins = getAllowedOrigins(env);
  return (origin: string | undefined): string | null | undefined => {
    if (allowedOrigins.length === 0) return origin ?? "*";
    return origin && allowedOrigins.includes(origin) ? origin : null;
  };
}
