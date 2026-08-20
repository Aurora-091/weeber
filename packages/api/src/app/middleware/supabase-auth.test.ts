import { mock, describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { sign } from "hono/jwt";

let mockMemberships: unknown[] = [];

function getTableName(table: unknown): string | undefined {
  if (!table) return undefined;
  const sym = Object.getOwnPropertySymbols(table).find((s) => s.toString() === "Symbol(drizzle:Name)");
  return sym ? (table as Record<symbol, string>)[sym] : undefined;
}

function thenable(rows: unknown[]) {
  const promise = Promise.resolve(rows) as Promise<unknown[]> & Record<string, unknown>;
  promise.where = () => thenable(rows);
  promise.limit = () => thenable(rows);
  promise.orderBy = () => thenable(rows);
  return promise;
}

mock.module("../../database", () => ({
  db: {
    select: () => ({
      from: (table: unknown) => {
        const name = getTableName(table);
        return thenable(name === "org_members" ? mockMemberships : []);
      },
    }),
  },
}));

process.env.SUPABASE_JWT_SECRET = "test-jwt-secret";

import { requireUserSession, requireUserOrg } from "./supabase-auth";

const app = new Hono()
  .use("*", requireUserSession)
  .get("/session", (c) =>
    c.json({
      userId: c.get("userUserId"),
      orgId: c.get("userOrgId"),
      role: c.get("userRole"),
    }),
  )
  .use("*", requireUserOrg)
  .get("/gated", (c) => c.json({ ok: true }));

async function signToken(claims: Record<string, unknown>) {
  return sign({ exp: Math.floor(Date.now() / 1000) + 600, ...claims }, "test-jwt-secret", "HS256");
}

describe("requireUserSession", () => {
  beforeEach(() => {
    mockMemberships = [];
  });

  it("rejects a request with no token", async () => {
    const res = await app.request("/session");
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("missing_token");
  });

  it("rejects a garbage token", async () => {
    const res = await app.request("/session", { headers: { Authorization: "Bearer not-a-jwt" } });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_token");
  });

  it("rejects an expired token", async () => {
    const token = await sign({ sub: "user-1", exp: Math.floor(Date.now() / 1000) - 60 }, "test-jwt-secret", "HS256");
    const res = await app.request("/session", { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(401);
  });

  it("resolves membership for a valid token", async () => {
    mockMemberships = [{ orgId: "org-1", role: "owner" }];
    const token = await signToken({ sub: "user-1", email: "m@example.com" });
    const res = await app.request("/session", { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: "user-1", orgId: "org-1", role: "owner" });
  });

  it("authenticates with a null org when no membership exists (bootstrap pending)", async () => {
    const token = await signToken({ sub: "user-2" });
    const res = await app.request("/session", { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { orgId: string | null }).orgId).toBeNull();
  });

  it("gates org-required routes with 403 no_org when membership is missing", async () => {
    const token = await signToken({ sub: "user-2" });
    const res = await app.request("/gated", { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("no_org");
  });
});

// SUPABASE_JWT_SECRET stays configured throughout this file (test-jwt-secret,
// set at module load above) — these cover the fallback for when it's stale
// (project migrated to asymmetric signing keys) rather than absent.
describe("requireUserSession — JWKS fallback when the shared secret can't verify", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    mockMemberships = [];
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.SUPABASE_URL;
  });

  async function generateEs256Keys(kid: string) {
    const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const privateJwk = { ...(await crypto.subtle.exportKey("jwk", keyPair.privateKey)), alg: "ES256", kid };
    const publicJwk = { ...(await crypto.subtle.exportKey("jwk", keyPair.publicKey)), alg: "ES256", kid };
    return { privateJwk, publicJwk };
  }

  it("falls back to JWKS and succeeds when the token is signed with a current asymmetric key", async () => {
    const { privateJwk, publicJwk } = await generateEs256Keys("test-kid");
    const token = await sign({ sub: "user-3", exp: Math.floor(Date.now() / 1000) + 600 }, privateJwk);

    process.env.SUPABASE_URL = "https://example.supabase.co";
    global.fetch = (async (url: string) => {
      if (url === "https://example.supabase.co/auth/v1/.well-known/jwks.json") {
        return new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    mockMemberships = [{ orgId: "org-3", role: "owner" }];
    const res = await app.request("/session", { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: "user-3", orgId: "org-3", role: "owner" });
  });

  it("still rejects with invalid_token when neither the secret nor JWKS can verify the token", async () => {
    const { publicJwk } = await generateEs256Keys("test-kid");
    const { privateJwk: wrongPrivateJwk } = await generateEs256Keys("other-kid");
    const token = await sign({ sub: "user-4", exp: Math.floor(Date.now() / 1000) + 600 }, wrongPrivateJwk);

    process.env.SUPABASE_URL = "https://example.supabase.co";
    global.fetch = (async () => new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200 })) as unknown as typeof fetch;

    const res = await app.request("/session", { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_token");
  });
});
