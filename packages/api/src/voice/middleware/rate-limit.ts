import { createMiddleware } from "hono/factory";
import { checkAndIncrementOutboundRateLimit } from "../../database/rate-limit-store";

/**
 * Per-org outbound-call rate limiter (audit 2026-07-19 finding #2 fix) — prevents a leaked admin
 * key or a bug in an integration from placing a runaway number of outbound calls; it is not a
 * substitute for the compliance calling-window/DNC checks, which still apply on top of this.
 *
 * Fixed: this used to be a single process-local module-singleton counter shared across every
 * org — one aggressive/misbehaving org could exhaust the window and throttle every other tenant,
 * and it reset on every restart with no cross-instance guarantee. Now Postgres-backed
 * (`database/rate-limit-store.ts`) and keyed by `orgId`, so the limit is genuinely per-tenant and
 * holds across restarts/instances.
 *
 * Configure via OUTBOUND_CALL_RATE_LIMIT (default 30 calls) and
 * OUTBOUND_CALL_RATE_WINDOW_MS (default 60000 = 1 minute).
 *
 * Requests with no resolvable `orgId` (an unscoped/legacy call) share one `"unscoped"` bucket —
 * still isolated from every real org's bucket, just not further split among themselves. This
 * mirrors how the route already treats a missing orgId as its own case, not a free-for-all.
 */
const WINDOW_MS = Number(process.env.OUTBOUND_CALL_RATE_WINDOW_MS ?? 60_000);
const MAX_CALLS_PER_WINDOW = Number(process.env.OUTBOUND_CALL_RATE_LIMIT ?? 30);

export const rateLimitOutboundCalls = createMiddleware(async (c, next) => {
  // Body is read here for the orgId key, then again by the route handler — safe, Hono caches
  // the parsed body per-request (see request.js's #cachedBody), this doesn't double-consume it.
  const body = await c.req.json().catch(() => null);
  const orgId = (body && typeof body === "object" && typeof (body as { orgId?: unknown }).orgId === "string"
    ? (body as { orgId: string }).orgId
    : null) ?? "unscoped";

  const result = await checkAndIncrementOutboundRateLimit(orgId, WINDOW_MS, MAX_CALLS_PER_WINDOW);

  if (!result.allowed) {
    const retryAfterMs = WINDOW_MS - (Date.now() - result.windowStart.getTime());
    return c.json(
      {
        error: `Outbound call rate limit exceeded (${MAX_CALLS_PER_WINDOW} per ${WINDOW_MS}ms) for this org. Try again in ${Math.ceil(Math.max(0, retryAfterMs) / 1000)}s.`,
      },
      429,
    );
  }

  return next();
});
