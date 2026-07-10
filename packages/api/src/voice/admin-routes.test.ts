import { mock, describe, it, expect, beforeEach, afterAll } from "bun:test";

/**
 * Admin endpoints added in the frontend round: feature-flag CRUD validation
 * and the impersonation routes' contract with the impersonation module
 * (which is mocked here — its real token/audit behavior is covered in
 * app/impersonation.test.ts, at the module level, because bun's mock.module
 * registrations leak across test files and routes.test.ts in app/ already
 * mocks it).
 */

let rowsByTable: Record<string, unknown[]> = {};
let insertsByTable: Record<string, { data: Record<string, unknown> }[]> = {};
let updatesByTable: Record<string, Record<string, unknown>[]> = {};

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
  promise.innerJoin = () => thenable(rows);
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
        (insertsByTable[name] ??= []).push({ data });
        return {
          onConflictDoNothing: () => Promise.resolve(),
          onConflictDoUpdate: () => ({ returning: () => Promise.resolve([{ id: 1, ...data }]) }),
          returning: () => Promise.resolve([{ id: 1, ...data }]),
        };
      },
    }),
    update: (table: unknown) => ({
      set: (data: Record<string, unknown>) => ({
        where: () => {
          const name = getTableName(table) ?? "";
          (updatesByTable[name] ??= []).push(data);
          return { returning: () => Promise.resolve([{ id: 1, ...data }]) };
        },
      }),
    }),
    delete: () => ({ where: () => Promise.resolve() }),
  },
}));

let startCalls: { orgId: string; adminActor: string }[] = [];
let stopCalls: number[] = [];

mock.module("../app/impersonation", () => ({
  startImpersonation: (orgId: string, adminActor: string) => {
    startCalls.push({ orgId, adminActor });
    if (orgId === "org-missing") return Promise.resolve(null);
    return Promise.resolve({ id: 1, token: "ovi_test-token", expiresAt: new Date(Date.now() + 30 * 60_000) });
  },
  stopImpersonation: (id: number) => {
    stopCalls.push(id);
    return Promise.resolve(true);
  },
  listImpersonationAudit: () => Promise.resolve([]),
  listActiveImpersonations: () => Promise.resolve([]),
}));

process.env.ADMIN_API_KEY = "test-admin-key";
// routes.test.ts relies on the no-key dev fallback letting requests through —
// don't leak this env var into files that run after this one.
afterAll(() => {
  delete process.env.ADMIN_API_KEY;
});

import { admin } from "./admin-routes";

const adminHeaders = { "X-OpenVent-Admin-Key": "test-admin-key", "Content-Type": "application/json" };

describe("admin flags routes", () => {
  beforeEach(() => {
    rowsByTable = { orgs: [], feature_flags: [], do_not_call: [], tool_calls: [], calls: [], impersonation_sessions: [] };
    insertsByTable = {};
    updatesByTable = {};
  });

  it("requires the admin key", async () => {
    const res = await admin.request("/flags");
    expect(res.status).toBe(401);
  });

  it("rejects a flag without a key", async () => {
    const res = await admin.request("/flags", { method: "POST", headers: adminHeaders, body: JSON.stringify({}) });
    expect(res.status).toBe(400);
  });

  it("creates a global flag with the empty-string org sentinel", async () => {
    const res = await admin.request("/flags", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ key: "beta-voices", enabled: true }),
    });
    expect(res.status).toBe(201);
    const inserted = insertsByTable.feature_flags?.[0]?.data as { key: string; orgId: string; enabled: boolean };
    expect(inserted).toMatchObject({ key: "beta-voices", orgId: "", enabled: true });
  });

  it("rejects a flag update with an invalid id", async () => {
    const res = await admin.request("/flags/not-a-number", {
      method: "PUT",
      headers: adminHeaders,
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(400);
  });
});

describe("admin impersonation routes", () => {
  beforeEach(() => {
    rowsByTable = { orgs: [], impersonation_sessions: [] };
    insertsByTable = {};
    updatesByTable = {};
    startCalls = [];
    stopCalls = [];
  });

  it("rejects a start without orgId", async () => {
    const res = await admin.request("/impersonation/start", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(startCalls).toHaveLength(0);
  });

  it("404s when the org doesn't exist", async () => {
    const res = await admin.request("/impersonation/start", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ orgId: "org-missing" }),
    });
    expect(res.status).toBe(404);
  });

  it("starts a session attributed to the admin actor and returns the one-time token", async () => {
    const res = await admin.request("/impersonation/start", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ orgId: "org-1" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { impersonation: { token: string } };
    expect(body.impersonation.token).toBe("ovi_test-token");
    expect(startCalls).toEqual([{ orgId: "org-1", adminActor: "env-admin-key" }]);
  });

  it("stops a session by id", async () => {
    const res = await admin.request("/impersonation/9/stop", { method: "POST", headers: adminHeaders });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stopped: true });
    expect(stopCalls).toEqual([9]);
  });
});
