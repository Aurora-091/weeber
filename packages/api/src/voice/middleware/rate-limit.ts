import { createMiddleware } from "hono/factory";

/**
 * Basic in-memory rate limiter for outbound call triggering — a fixed-window
 * counter, not a distributed limiter. Prevents a leaked admin key or a bug
 * in an integration from placing a runaway number of outbound calls; it is
 * not a substitute for the compliance calling-window/DNC checks, which
 * still apply on top of this.
 *
 * Configure via OUTBOUND_CALL_RATE_LIMIT (default 30 calls) and
 * OUTBOUND_CALL_RATE_WINDOW_MS (default 60000 = 1 minute).
 *
 * Process-local — resets on restart and doesn't share across instances.
 * Fine for a single-instance deployment; swap for a Redis-backed limiter to
 * scale horizontally.
 */
const WINDOW_MS = Number(process.env.OUTBOUND_CALL_RATE_WINDOW_MS ?? 60_000);
const MAX_CALLS_PER_WINDOW = Number(process.env.OUTBOUND_CALL_RATE_LIMIT ?? 30);

let windowStart = Date.now();
let callsInWindow = 0;

export const rateLimitOutboundCalls = createMiddleware(async (c, next) => {
  const now = Date.now();
  if (now - windowStart >= WINDOW_MS) {
    windowStart = now;
    callsInWindow = 0;
  }

  if (callsInWindow >= MAX_CALLS_PER_WINDOW) {
    const retryAfterMs = WINDOW_MS - (now - windowStart);
    return c.json(
      {
        error: `Outbound call rate limit exceeded (${MAX_CALLS_PER_WINDOW} per ${WINDOW_MS}ms). Try again in ${Math.ceil(retryAfterMs / 1000)}s.`,
      },
      429,
    );
  }

  callsInWindow += 1;
  return next();
});
