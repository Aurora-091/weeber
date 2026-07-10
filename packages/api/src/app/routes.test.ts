import { mock, describe, it, expect, beforeEach } from "bun:test";
import { sign } from "hono/jwt";

/**
 * Merchant /api/app surface: first-login org bootstrap (idempotent), the
 * org gate on every non-/me route, and impersonation self-stop.
 */

let rowsByTable: Record<string, unknown[]> = {};
let insertsByTable: Record<string, unknown[]> = {};
let mockImpersonation: { id: number; orgId: string; adminActor: string } | null = null;
let stoppedSessionIds: number[] = [];

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

mock.module("../database", () => ({
  db: {
    select: () => ({
      from: (table: unknown) => thenable(rowsByTable[getTableName(table) ?? ""] ?? []),
    }),
    insert: (table: unknown) => ({
      values: (data: Record<string, unknown>) => {
        const name = getTableName(table) ?? "";
        (insertsByTable[name] ??= []).push(data);
        // Make bootstrap inserts visible to the re-select that follows them.
        (rowsByTable[name] ??= []).push(data);
        return {
          onConflictDoNothing: () => Promise.resolve(),
          onConflictDoUpdate: () => ({ returning: () => Promise.resolve([data]) }),
          returning: () => Promise.resolve([{ id: 1, ...data }]),
        };
      },
    }),
  },
}));

mock.module("./impersonation", () => ({
  findActiveImpersonation: (token: string) =>
    Promise.resolve(token === "valid-imp-token" ? mockImpersonation : null),
  stopImpersonation: (id: number) => {
    stoppedSessionIds.push(id);
    return Promise.resolve(true);
  },
}));

process.env.SUPABASE_JWT_SECRET = "test-jwt-secret";

import { merchantApp } from "./routes";

async function bearer(sub: string, email?: string) {
  const token = await sign(
    { sub, email, exp: Math.floor(Date.now() / 1000) + 600 },
    "test-jwt-secret",
    "HS256",
  );
  return { Authorization: `Bearer ${token}` };
}

describe("merchant /api/app routes", () => {
  beforeEach(() => {
    rowsByTable = { org_members: [], orgs: [], calls: [], feature_flags: [] };
    insertsByTable = {};
    mockImpersonation = null;
    stoppedSessionIds = [];
  });

  it("bootstraps an org + owner membership on first /me", async () => {
    const res = await merchantApp.request("/me", { headers: await bearer("user-new", "jane@shop.com") });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { org: { id: string; name: string }; role: string; impersonated: boolean };
    expect(body.role).toBe("owner");
    expect(body.impersonated).toBe(false);
    expect(body.org.id.startsWith("org_")).toBe(true);
    expect(body.org.name).toBe("jane's workspace");
    expect(insertsByTable.orgs).toHaveLength(1);
    expect(insertsByTable.org_members).toHaveLength(1);
  });

  it("does not create a second org for an already-bootstrapped user", async () => {
    rowsByTable.org_members = [{ supabaseUserId: "user-1", orgId: "org-existing", role: "owner" }];
    rowsByTable.orgs = [{ id: "org-existing", name: "Existing", vertical: "shopify" }];
    const res = await merchantApp.request("/me", { headers: await bearer("user-1") });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { org: { id: string } }).org.id).toBe("org-existing");
    expect(insertsByTable.orgs).toBeUndefined();
    expect(insertsByTable.org_members).toBeUndefined();
  });

  it("403s org-gated routes when the session has no membership", async () => {
    const res = await merchantApp.request("/calls", { headers: await bearer("user-orphan") });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("no_org");
  });

  it("serves org-gated routes for a member", async () => {
    rowsByTable.org_members = [{ supabaseUserId: "user-1", orgId: "org-1", role: "owner" }];
    const res = await merchantApp.request("/calls", { headers: await bearer("user-1") });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ calls: [] });
  });

  it("rejects impersonation self-stop on a normal session", async () => {
    rowsByTable.org_members = [{ supabaseUserId: "user-1", orgId: "org-1", role: "owner" }];
    const res = await merchantApp.request("/impersonation/stop", {
      method: "POST",
      headers: await bearer("user-1"),
    });
    expect(res.status).toBe(400);
  });

  it("stops the current impersonation session via its own token", async () => {
    mockImpersonation = { id: 42, orgId: "org-1", adminActor: "env-admin-key" };
    const res = await merchantApp.request("/impersonation/stop", {
      method: "POST",
      headers: { "X-Weeber-Impersonation": "valid-imp-token" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stopped: true });
    expect(stoppedSessionIds).toEqual([42]);
  });
});
