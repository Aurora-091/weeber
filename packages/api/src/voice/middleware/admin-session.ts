/**
 * Session-based admin authentication — the Supabase Auth counterpart to the
 * existing API-key gate. Both paths remain valid (scripts/CI use the API key;
 * humans use the session). Authentication is layered:
 *
 *   1. If `Authorization: Bearer <jwt>` is present → verify it as a Supabase
 *      Auth token, then confirm the user's email exists in `platform_admins`.
 *   2. Otherwise fall through to the existing API-key check (X-Weeber-Admin-Key, or the still-accepted legacy X-OpenVent-Admin-Key).
 *
 * This middleware is designed to WRAP the existing requireAdminKey — it either
 * authenticates via session and calls next(), or passes control to the next
 * middleware (which should be requireAdminKey).
 */
import { createMiddleware } from "hono/factory";
import { verify, verifyWithJwks } from "hono/jwt";
import { eq } from "drizzle-orm";
import { db } from "../../database";
import { platformAdmins } from "../../database/schema";
import type { AdminAuthVariables } from "./admin-auth";

async function verifySupabaseJwt(token: string): Promise<Record<string, unknown>> {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (secret) {
    return (await verify(token, secret, "HS256")) as Record<string, unknown>;
  }
  const url = process.env.SUPABASE_URL;
  if (!url) {
    throw new Error("Neither SUPABASE_JWT_SECRET nor SUPABASE_URL is configured");
  }
  return (await verifyWithJwks(token, {
    jwks_uri: `${url.replace(/\/+$/, "")}/auth/v1/.well-known/jwks.json`,
    allowedAlgorithms: ["RS256", "ES256"],
  })) as Record<string, unknown>;
}

/**
 * Attempts session-based auth. If successful, sets adminActor and calls next().
 * If no Bearer token is present, calls next() WITHOUT setting adminActor — the
 * downstream requireAdminKey will then handle API-key authentication.
 * If a Bearer token IS present but invalid/unauthorized, returns 401/403.
 */
export const adminSessionAuth = createMiddleware<{ Variables: AdminAuthVariables }>(async (c, next) => {
  const authHeader = c.req.header("Authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : null;

  if (!token) {
    return next();
  }

  let payload: Record<string, unknown>;
  try {
    payload = await verifySupabaseJwt(token);
  } catch {
    return c.json({ error: "Unauthorized — invalid or expired session", code: "invalid_token" }, 401);
  }

  const email = typeof payload.email === "string" ? payload.email : null;
  if (!email) {
    return c.json({ error: "Unauthorized — token has no email claim", code: "invalid_token" }, 401);
  }

  const [admin] = await db
    .select({ email: platformAdmins.email, role: platformAdmins.role })
    .from(platformAdmins)
    .where(eq(platformAdmins.email, email.toLowerCase()))
    .limit(1);

  if (!admin) {
    return c.json({ error: "Forbidden — not a platform admin", code: "not_admin" }, 403);
  }

  c.set("adminActor", email);
  return next();
});
