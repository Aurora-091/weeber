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
    rowsByTable = { orgs: [], feature_flags: [], do_not_call: [], tool_calls: [], calls: [], consent_records: [] };
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

// Consent ledger read endpoints (Marketing + Consent UI plan, 2026-07-16,
// docs/marketing-and-consent-ui-plan.md Part B).
describe("admin consent ledger routes", () => {
  beforeEach(() => {
    rowsByTable = { orgs: [], feature_flags: [], do_not_call: [], tool_calls: [], calls: [], consent_records: [] };
    insertsByTable = {};
    updatesByTable = {};
  });

  it("requires the admin key on /compliance/consent", async () => {
    const res = await admin.request("/compliance/consent?principal=%2B15550001111");
    expect(res.status).toBe(401);
  });

  it("requires the admin key on /compliance/consent/summary", async () => {
    const res = await admin.request("/compliance/consent/summary");
    expect(res.status).toBe(401);
  });

  it("400s /compliance/consent without a principal query param", async () => {
    const res = await admin.request("/compliance/consent", { headers: adminHeaders });
    expect(res.status).toBe(400);
  });

  it("returns every record for the given principal", async () => {
    rowsByTable.consent_records = [
      { orgId: "org-a", dataPrincipal: "+15550001111", purpose: "marketing", granted: true, grantedAt: new Date(), expiresAt: null, version: "v1", channel: "shopify", source: "checkout", withdrawnAt: null },
    ];
    const res = await admin.request("/compliance/consent?principal=%2B15550001111", { headers: adminHeaders });
    expect(res.status).toBe(200);
    const body = await res.json() as { principal: string; records: unknown[] };
    expect(body.principal).toBe("+15550001111");
    expect(body.records.length).toBe(1);
  });

  it("summary buckets an active grant under activeByOrgPurpose", async () => {
    rowsByTable.consent_records = [
      { orgId: "org-a", dataPrincipal: "+1", purpose: "marketing", granted: true, grantedAt: new Date(), expiresAt: null, version: "v1", channel: "shopify", source: "checkout", withdrawnAt: null },
    ];
    const res = await admin.request("/compliance/consent/summary", { headers: adminHeaders });
    expect(res.status).toBe(200);
    const body = await res.json() as { activeByOrgPurpose: Record<string, Record<string, number>>; totalRecords: number };
    expect(body.activeByOrgPurpose["org-a"]?.marketing).toBe(1);
    expect(body.totalRecords).toBe(1);
  });

  it("summary buckets a withdrawn grant under withdrawnByOrgPurpose, not active", async () => {
    rowsByTable.consent_records = [
      { orgId: "org-a", dataPrincipal: "+1", purpose: "marketing", granted: true, grantedAt: new Date(), expiresAt: null, version: "v1", channel: "shopify", source: "checkout", withdrawnAt: new Date() },
    ];
    const res = await admin.request("/compliance/consent/summary", { headers: adminHeaders });
    const body = await res.json() as { activeByOrgPurpose: Record<string, Record<string, number>>; withdrawnByOrgPurpose: Record<string, Record<string, number>> };
    expect(body.activeByOrgPurpose["org-a"]?.marketing ?? 0).toBe(0);
    expect(body.withdrawnByOrgPurpose["org-a"]?.marketing).toBe(1);
  });

  it("summary treats an expired (non-withdrawn) grant as not active", async () => {
    rowsByTable.consent_records = [
      { orgId: "org-a", dataPrincipal: "+1", purpose: "marketing", granted: true, grantedAt: new Date(Date.now() - 1000), expiresAt: new Date(Date.now() - 500), version: "v1", channel: "shopify", source: "checkout", withdrawnAt: null },
    ];
    const res = await admin.request("/compliance/consent/summary", { headers: adminHeaders });
    const body = await res.json() as { activeByOrgPurpose: Record<string, Record<string, number>> };
    expect(body.activeByOrgPurpose["org-a"]?.marketing ?? 0).toBe(0);
  });
});

// Blocked scheduled calls oversight (2026-07-19).
describe("admin blocked-calls route", () => {
  beforeEach(() => {
    rowsByTable = { orgs: [], feature_flags: [], do_not_call: [], tool_calls: [], calls: [], consent_records: [], scheduled_calls: [] };
    insertsByTable = {};
    updatesByTable = {};
  });

  it("requires the admin key on /compliance/blocked-calls", async () => {
    const res = await admin.request("/compliance/blocked-calls");
    expect(res.status).toBe(401);
  });

  it("returns blocked scheduled calls with a per-reason breakdown", async () => {
    rowsByTable.scheduled_calls = [
      { id: 1, orgId: "org-a", toNumber: "+15550001111", workflowName: "shopify-cart-recovery", status: "canceled", attempt: 1, maxAttempts: 2, runAt: new Date(), lastBlockReason: "dnc", lastBlockDetail: "on DNC", blockedAt: new Date() },
      { id: 2, orgId: "org-b", toNumber: "+15550002222", workflowName: "shopify-cod-confirmation", status: "pending", attempt: 1, maxAttempts: 3, runAt: new Date(), lastBlockReason: "calling_window", lastBlockDetail: "outside window", blockedAt: new Date() },
    ];
    const res = await admin.request("/compliance/blocked-calls", { headers: adminHeaders });
    expect(res.status).toBe(200);
    const body = await res.json() as { blockedCalls: unknown[]; byReason: Record<string, number>; total: number };
    expect(body.total).toBe(2);
    expect(body.byReason.dnc).toBe(1);
    expect(body.byReason.calling_window).toBe(1);
  });
});
