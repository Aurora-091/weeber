import { createMiddleware } from "hono/factory";
import { findActiveAdminKey, hasAnyAdminKey } from "../admin-keys";

/**
 * API-key gate for operational endpoints (call listing, transcripts, DNC
 * management, force-end, erasure, webhook testing, admin-key management
 * itself). These previously had zero authentication — anyone who could reach
 * the public URL could read call transcripts, manage the DNC list, or
 * force-end a live call.
 *
 * Two ways in, checked in order (ADR-025):
 *   1. The legacy single `ADMIN_API_KEY` env var — the bootstrap key every
 *      existing deployment already has set. This path never goes away.
 *   2. A labeled key created via the dashboard/API (see admin-keys.ts) —
 *      multiple, individually revocable, without rotating the shared secret.
 *
 * If neither `ADMIN_API_KEY` is set nor any labeled key has ever been
 * created, the gate is a no-op (logs a warning once) so local development
 * isn't blocked — but this must be set before exposing the app beyond local
 * testing. Once even one labeled key exists, that fallback stops applying —
 * an operator who's deliberately started using labeled keys shouldn't have
 * an unset env var silently reopen the gate.
 *
 * Sets `adminActor` on the context — which credential authenticated the
 * request ("env-admin-key", a labeled key's label, or "unauthenticated-dev"
 * for the local no-key fallback). Consumed by adminAuditLog, which must
 * record *who* performed an action, not just that someone did.
 */
let warnedMissingKey = false;

export type AdminAuthVariables = { adminActor: string };

export const requireAdminKey = createMiddleware<{ Variables: AdminAuthVariables }>(async (c, next) => {
  // If a prior middleware (adminSessionAuth) already authenticated, skip.
  if (c.get("adminActor")) {
    return next();
  }

  // Two accepted header names, permanently. The header was renamed
  // X-OpenVent-Admin-Key -> X-Weeber-Admin-Key with the OpenVent branding
  // removal; the old name is NOT deprecated on a timer. It is a live wire
  // contract with things this repo cannot see or redeploy — operator curl
  // scripts, saved Postman/Bruno collections, cron jobs, and anything else
  // holding an admin key. Dropping it later buys nothing (the key itself is
  // still the only secret; accepting a second header name grants no extra
  // access) and would break admin access silently, at whatever hour the
  // forgotten caller next runs. New name first so it wins if both are sent.
  const providedKey = c.req.header("X-Weeber-Admin-Key") ?? c.req.header("X-OpenVent-Admin-Key");
  const configuredKey = process.env.ADMIN_API_KEY;

  if (configuredKey && providedKey === configuredKey) {
    c.set("adminActor", "env-admin-key");
    return next();
  }

  if (providedKey) {
    const match = await findActiveAdminKey(providedKey).catch(() => null);
    if (match) {
      c.set("adminActor", match.label);
      return next();
    }
  }

  if (!configuredKey && !(await hasAnyAdminKey().catch(() => false))) {
    if (!warnedMissingKey) {
      console.warn(
        "[admin-auth] No ADMIN_API_KEY and no labeled admin keys configured — ops endpoints " +
          "(/calls, /dnc, /callers, /webhooks/test, /admin-keys) are currently UNAUTHENTICATED. " +
          "Set ADMIN_API_KEY or create a labeled key before exposing this beyond local testing.",
      );
      warnedMissingKey = true;
    }
    c.set("adminActor", "unauthenticated-dev");
    return next();
  }

  return c.json({ error: "Unauthorized — missing or invalid X-Weeber-Admin-Key header (X-OpenVent-Admin-Key is also accepted)" }, 401);
});
