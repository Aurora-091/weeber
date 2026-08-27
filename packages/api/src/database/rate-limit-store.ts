/**
 * Per-org outbound-call rate limiter (audit 2026-07-19 finding #2), Postgres-backed so the limit
 * is both per-tenant and holds across restarts/instances — replaces the old process-local
 * module-singleton counter in `voice/middleware/rate-limit.ts`.
 *
 * One atomic UPSERT does the whole "reset-if-window-expired, else increment" fixed-window
 * operation in a single statement, so concurrent requests for the same org can't race each other
 * past the limit (Postgres row-level locking on the UPDATE serializes them). The trade-off of a
 * plain fixed window (a burst can land right at a window boundary and briefly allow up to ~2x
 * the configured rate) is the same one the original in-memory limiter already had — not
 * introduced by this change.
 */
import { db } from "./index";
import { sql } from "drizzle-orm";

export type RateLimitResult = {
  allowed: boolean;
  callCount: number;
  windowStart: Date;
};

/**
 * Atomically increments (or resets + starts at 1, if the previous window has expired) the
 * outbound-call counter for one org, and reports whether this call should be allowed under
 * `maxCallsPerWindow`.
 */
export async function checkAndIncrementOutboundRateLimit(
  orgId: string,
  windowMs: number,
  maxCallsPerWindow: number,
): Promise<RateLimitResult> {
  const result = await db.execute(sql`
    INSERT INTO outbound_rate_limit_windows (org_id, window_start, call_count)
    VALUES (${orgId}, now(), 1)
    ON CONFLICT (org_id) DO UPDATE SET
      window_start = CASE
        WHEN extract(epoch FROM now() - outbound_rate_limit_windows.window_start) * 1000 >= ${windowMs}
        THEN now()
        ELSE outbound_rate_limit_windows.window_start
      END,
      call_count = CASE
        WHEN extract(epoch FROM now() - outbound_rate_limit_windows.window_start) * 1000 >= ${windowMs}
        THEN 1
        ELSE outbound_rate_limit_windows.call_count + 1
      END
    RETURNING window_start, call_count
  `);
  const row = (result as unknown as Array<{ window_start: Date; call_count: number }>)[0];
  // Defensive fallback — should be unreachable (INSERT ... RETURNING always returns exactly one
  // row), but never let a driver quirk here fail the outbound-call path open by crashing.
  if (!row) {
    console.error("[rate-limit-store] INSERT ... RETURNING returned no row — failing open, not blocking a real call on this");
    return { allowed: true, callCount: 1, windowStart: new Date() };
  }
  return {
    allowed: row.call_count <= maxCallsPerWindow,
    callCount: row.call_count,
    windowStart: new Date(row.window_start),
  };
}

/**
 * Same atomic reset-if-expired-else-increment shape as
 * `checkAndIncrementOutboundRateLimit`, but keyed by `(scope, key)` instead of a bare org id —
 * for callers with no org/session context, like the public demo-call widget's per-phone-number
 * and global daily caps (`demo_widget_rate_limit_windows`). `scope` namespaces the key so a
 * phone number can never collide with the fixed global-cap key.
 */
export async function checkAndIncrementKeyedRateLimit(
  scope: "phone" | "global",
  key: string,
  windowMs: number,
  maxCallsPerWindow: number,
): Promise<RateLimitResult> {
  const result = await db.execute(sql`
    INSERT INTO demo_widget_rate_limit_windows (scope, key, window_start, call_count)
    VALUES (${scope}, ${key}, now(), 1)
    ON CONFLICT (scope, key) DO UPDATE SET
      window_start = CASE
        WHEN extract(epoch FROM now() - demo_widget_rate_limit_windows.window_start) * 1000 >= ${windowMs}
        THEN now()
        ELSE demo_widget_rate_limit_windows.window_start
      END,
      call_count = CASE
        WHEN extract(epoch FROM now() - demo_widget_rate_limit_windows.window_start) * 1000 >= ${windowMs}
        THEN 1
        ELSE demo_widget_rate_limit_windows.call_count + 1
      END
    RETURNING window_start, call_count
  `);
  const row = (result as unknown as Array<{ window_start: Date; call_count: number }>)[0];
  // Defensive fallback — see checkAndIncrementOutboundRateLimit's identical comment. Failing
  // open here means an edge-case driver quirk costs one unmetered demo call, not a refused one.
  if (!row) {
    console.error("[rate-limit-store] keyed INSERT ... RETURNING returned no row — failing open");
    return { allowed: true, callCount: 1, windowStart: new Date() };
  }
  return {
    allowed: row.call_count <= maxCallsPerWindow,
    callCount: row.call_count,
    windowStart: new Date(row.window_start),
  };
}
