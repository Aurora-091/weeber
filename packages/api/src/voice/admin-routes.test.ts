import { mock, describe, it, expect, beforeEach, afterAll } from "bun:test";

/**
 * Admin endpoints added in the frontend round: feature-flag CRUD validation.
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
    rowsByTable = { orgs: [], feature_flags: [], do_not_call: [], tool_calls: [], calls: [] };
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
