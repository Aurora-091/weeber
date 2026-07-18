/**
 * Sentry error monitoring (2026-07-18, infra-consolidation-audit-2026-07-18.md /
 * ADR — the one genuine capability gap identified: errors currently go
 * `console.error` -> Railway logs (30-day retention, no aggregation, no
 * alerts), so a voice call failing at 2am produces zero signal to anyone.
 * Vercel Observability (already on Pro) only sees the frontend, not this
 * Railway-hosted Hono API where the voice pipeline actually lives.
 *
 * Free-tier Sentry, same "silently no-op if unset" convention as
 * RESEND_API_KEY elsewhere in this codebase — SENTRY_DSN unset means this
 * whole module does nothing, not a startup failure. No behavior change for
 * anyone who hasn't configured it.
 */
import * as Sentry from "@sentry/bun";

let initialized = false;

export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return; // no-op, matches RESEND_API_KEY/etc. convention

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? "development",
    // Conservative default — this is error monitoring, not APM; keep the
    // free tier's 5K-events/month budget for actual errors, not trace noise.
    tracesSampleRate: 0,
  });
  initialized = true;
  console.log("[sentry] initialized");
}

/**
 * Best-effort capture — never throws, never blocks the caller. Used from
 * the three chokepoints that see nearly every real error in this codebase:
 * logger.ts's error()/fatal(), the Hono errorHandler middleware, and
 * server.ts's process-level unhandledRejection/uncaughtException handlers.
 * Silently does nothing if Sentry was never initialized (SENTRY_DSN unset).
 */
export function captureError(err: unknown, context?: Record<string, unknown>): void {
  if (!initialized) return;
  try {
    if (err instanceof Error) {
      Sentry.captureException(err, context ? { extra: context } : undefined);
    } else {
      Sentry.captureMessage(String(err), { level: "error", extra: context });
    }
  } catch {
    // Never let monitoring itself become a source of failure.
  }
}
