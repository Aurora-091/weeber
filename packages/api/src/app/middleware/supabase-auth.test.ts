import { mock, describe, it, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import { sign } from "hono/jwt";

let mockMemberships: unknown[] = [];
let mockImpersonation: { id: number; orgId: string; adminActor: string } | null = null;

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

mock.module("../impersonation", () => ({
  findActiveImpersonation: (token: string) =>
    Promise.resolve(token === "valid-imp-token" ? mockImpersonation : null),
  stopImpersonation: () => Promise.resolve(true),
}));

process.env.SUPABASE_JWT_SECRET = "test-jwt-secret";

import { requireMerchantSession, requireMerchantOrg } from "./supabase-auth";

const app = new Hono()
  .use("*", requireMerchantSession)
  .get("/session", (c) =>
    c.json({
      userId: c.get("merchantUserId"),
      orgId: c.get("merchantOrgId"),
      role: c.get("merchantRole"),
      impersonated: c.get("impersonated"),
    }),
  )
  .use("*", requireMerchantOrg)
  .get("/gated", (c) => c.json({ ok: true }));

async function signToken(claims: Record<string, unknown>) {
  return sign({ exp: Math.floor(Date.now() / 1000) + 600, ...claims }, "test-jwt-secret", "HS256");
}

describe("requireMerchantSession", () => {
  beforeEach(() => {
    mockMemberships = [];
    mockImpersonation = null;
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
    expect(await res.json()).toEqual({ userId: "user-1", orgId: "org-1", role: "owner", impersonated: false });
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

  it("accepts a live impersonation token and flags the session", async () => {
    mockImpersonation = { id: 7, orgId: "org-9", adminActor: "env-admin-key" };
    const res = await app.request("/session", { headers: { "X-Weeber-Impersonation": "valid-imp-token" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: null, orgId: "org-9", role: "owner", impersonated: true });
  });

  it("rejects an ended/expired impersonation token", async () => {
    const res = await app.request("/session", { headers: { "X-Weeber-Impersonation": "stale-token" } });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("impersonation_invalid");
  });
});
