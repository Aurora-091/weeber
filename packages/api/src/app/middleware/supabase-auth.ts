/**
 * Merchant session gate for /api/app/* (CLAUDE-BUILD-BRIEF §9) — the
 * Supabase-Auth counterpart to voice/middleware/admin-auth.ts, same shape:
 * check a header, set context vars, next() or 401. Deliberately a separate
 * auth system from the admin key (two audiences, two trust levels — see
 * CLAUDE.md "Notes").
 *
 * Verification is local — no per-request call to Supabase Auth:
 *   1. `SUPABASE_JWT_SECRET` set → HS256 verify (Supabase's legacy shared
 *      secret regime, what a project created pre-2025 uses by default).
 *   2. Otherwise → JWKS against `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`
 *      (the newer asymmetric signing-key regime). Hono caches the key set.
 * A network round-trip to ap-south-1 on every API call (supabase.auth.getUser)
 * would buy only instant revocation, which short JWT lifetimes already
 * approximate — not worth the latency + hard runtime dependency.
 *
 * The same middleware accepts an admin impersonation token
 * (`X-Weeber-Impersonation` header) so every merchant route behaves
 * identically under impersonation — org resolution comes from the audited
 * session row instead of a membership lookup, and `impersonated` is exposed
 * so the UI can show the "viewing as" banner.
 */
import { createMiddleware } from "hono/factory";
import { verify, verifyWithJwks } from "hono/jwt";
import { eq } from "drizzle-orm";
import { db } from "../../database";
import { orgMembers } from "../../database/schema";
import { findActiveImpersonation } from "../impersonation";

export type MerchantSessionVariables = {
  /** Supabase user id (`sub` claim); null under impersonation. */
  merchantUserId: string | null;
  merchantEmail: string | null;
  /** Resolved org; null = authenticated but no membership yet (bootstrap pending). */
  merchantOrgId: string | null;
  merchantRole: string | null;
  impersonated: boolean;
  impersonationSessionId: number | null;
};

type MerchantEnv = { Variables: MerchantSessionVariables };

async function verifySupabaseJwt(token: string): Promise<Record<string, unknown>> {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (secret) {
    return (await verify(token, secret, "HS256")) as Record<string, unknown>;
  }
  const url = process.env.SUPABASE_URL;
  if (!url) {
    throw new Error("Neither SUPABASE_JWT_SECRET nor SUPABASE_URL is configured — cannot verify merchant sessions");
  }
  return (await verifyWithJwks(token, {
    jwks_uri: `${url.replace(/\/+$/, "")}/auth/v1/.well-known/jwks.json`,
    // Supabase's asymmetric signing-key regime issues RS256 or ES256 keys.
    allowedAlgorithms: ["RS256", "ES256"],
  })) as Record<string, unknown>;
}

export const requireMerchantSession = createMiddleware<MerchantEnv>(async (c, next) => {
  const impersonationToken = c.req.header("X-Weeber-Impersonation");
  if (impersonationToken) {
    const session = await findActiveImpersonation(impersonationToken);
    if (!session) {
      return c.json({ error: "Impersonation session ended or expired", code: "impersonation_invalid" }, 401);
    }
    c.set("merchantUserId", null);
    c.set("merchantEmail", null);
    c.set("merchantOrgId", session.orgId);
    c.set("merchantRole", "owner");
    c.set("impersonated", true);
    c.set("impersonationSessionId", session.id);
    return next();
  }

  const authHeader = c.req.header("Authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : null;
  if (!token) {
    return c.json({ error: "Unauthorized — missing bearer token", code: "missing_token" }, 401);
  }

  let payload: Record<string, unknown>;
  try {
    payload = await verifySupabaseJwt(token);
  } catch {
    return c.json({ error: "Unauthorized — invalid or expired session", code: "invalid_token" }, 401);
  }

  const sub = typeof payload.sub === "string" ? payload.sub : null;
  if (!sub) {
    return c.json({ error: "Unauthorized — token has no subject", code: "invalid_token" }, 401);
  }

  const [membership] = await db
    .select({ orgId: orgMembers.orgId, role: orgMembers.role })
    .from(orgMembers)
    .where(eq(orgMembers.supabaseUserId, sub))
    .limit(1);

  c.set("merchantUserId", sub);
  c.set("merchantEmail", typeof payload.email === "string" ? payload.email : null);
  c.set("merchantOrgId", membership?.orgId ?? null);
  c.set("merchantRole", membership?.role ?? null);
  c.set("impersonated", false);
  c.set("impersonationSessionId", null);
  return next();
});

/**
 * Second gate for every merchant route except /me: the session must resolve
 * to an org. /me is the one route that runs without this, because it's where
 * the first-login org bootstrap happens (see app/routes.ts).
 */
export const requireMerchantOrg = createMiddleware<MerchantEnv>(async (c, next) => {
  if (!c.get("merchantOrgId")) {
    return c.json({ error: "No organization linked to this account yet", code: "no_org" }, 403);
  }
  return next();
});
