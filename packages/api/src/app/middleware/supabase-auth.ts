/**
 * User session gate for /api/app/* (CLAUDE-BUILD-BRIEF §9) — the
 * Supabase-Auth counterpart to voice/middleware/admin-auth.ts, same shape:
 * check a header, set context vars, next() or 401. Deliberately a separate
 * auth system from the admin key (two audiences, two trust levels — see
 * CLAUDE.md "Notes").
 *
 * Verification is local — no per-request call to Supabase Auth:
 *   1. `SUPABASE_JWT_SECRET` set → HS256 verify (Supabase's legacy shared
 *      secret regime, what a project created pre-2025 uses by default).
 *   2. Otherwise → JWKS against `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`,
 *      fetched once and cached in-memory for `JWKS_CACHE_TTL_MS` (audit#03 P1
 *      fix — `hono/jwt`'s `verifyWithJwks` does NOT cache when called with
 *      `jwks_uri` directly, contrary to what this comment used to claim; it
 *      fetches on every single call. This module now fetches the key set
 *      itself and passes `keys` instead, so the network round-trip only
 *      happens once per TTL window, not once per request).
 * A network round-trip to ap-south-1 on every API call (supabase.auth.getUser)
 * would buy only instant revocation, which short JWT lifetimes already
 * approximate — not worth the latency + hard runtime dependency.
 */
import { createMiddleware } from "hono/factory";
import { verify, verifyWithJwks } from "hono/jwt";
import type { HonoJsonWebKey } from "hono/utils/jwt/jws";
import { eq } from "drizzle-orm";
import { db } from "../../database";
import { orgMembers } from "../../database/schema";

export type UserSessionVariables = {
  userUserId: string | null;
  userEmail: string | null;
  /** Resolved org; null = authenticated but no membership yet (bootstrap pending). */
  userOrgId: string | null;
  userRole: string | null;
};

type UserEnv = { Variables: UserSessionVariables };

const JWKS_CACHE_TTL_MS = 10 * 60 * 1000; // 10 min — Supabase rotates signing keys rarely; short
// enough to self-heal after a rotation without adding retry-on-miss complexity.
let jwksCache: { keys: HonoJsonWebKey[]; fetchedAt: number } | null = null;

async function getJwksKeys(supabaseUrl: string): Promise<HonoJsonWebKey[]> {
  if (jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_CACHE_TTL_MS) {
    return jwksCache.keys;
  }
  const res = await fetch(`${supabaseUrl.replace(/\/+$/, "")}/auth/v1/.well-known/jwks.json`);
  if (!res.ok) throw new Error(`failed to fetch JWKS: ${res.status}`);
  const data = (await res.json()) as { keys?: HonoJsonWebKey[] };
  if (!data.keys) throw new Error("invalid JWKS response — missing keys");
  jwksCache = { keys: data.keys, fetchedAt: Date.now() };
  return data.keys;
}

async function verifySupabaseJwt(token: string): Promise<Record<string, unknown>> {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (secret) {
    return (await verify(token, secret, "HS256")) as Record<string, unknown>;
  }
  const url = process.env.SUPABASE_URL;
  if (!url) {
    throw new Error("Neither SUPABASE_JWT_SECRET nor SUPABASE_URL is configured — cannot verify user sessions");
  }
  const keys = await getJwksKeys(url);
  return (await verifyWithJwks(token, {
    keys,
    // Supabase's asymmetric signing-key regime issues RS256 or ES256 keys.
    allowedAlgorithms: ["RS256", "ES256"],
  })) as Record<string, unknown>;
}

export const requireUserSession = createMiddleware<UserEnv>(async (c, next) => {
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
    .select({ orgId: orgMembers.orgId, role: orgMembers.role, email: orgMembers.email })
    .from(orgMembers)
    .where(eq(orgMembers.supabaseUserId, sub))
    .limit(1);

  const jwtEmail = typeof payload.email === "string" ? payload.email : null;
  // Opportunistic, best-effort — keeps org_members.email fresh for the admin
  // Users page without a live Supabase Admin API call on every request.
  // Never blocks the actual request on a write failure.
  if (jwtEmail && membership && membership.email !== jwtEmail) {
    try {
      void db
        .update(orgMembers)
        .set({ email: jwtEmail })
        .where(eq(orgMembers.supabaseUserId, sub))
        .catch((err: unknown) => console.error("[user-session] failed to refresh member email", err));
    } catch (err) {
      console.error("[user-session] failed to refresh member email", err);
    }
  }

  c.set("userUserId", sub);
  c.set("userEmail", jwtEmail);
  c.set("userOrgId", membership?.orgId ?? null);
  c.set("userRole", membership?.role ?? null);
  return next();
});

/**
 * Second gate for every user route except /me: the session must resolve
 * to an org. /me is the one route that runs without this, because it's where
 * the first-login org bootstrap happens (see app/routes.ts).
 */
export const requireUserOrg = createMiddleware<UserEnv>(async (c, next) => {
  if (!c.get("userOrgId")) {
    return c.json({ error: "No organization linked to this account yet", code: "no_org" }, 403);
  }
  return next();
});
