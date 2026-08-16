import { mock, describe, it, expect, beforeEach, afterAll } from "bun:test";

/**
 * Regression: the admin surface could buy a number but not release one.
 *
 * POST /orgs/:orgId/twilio/number commits an org to a recurring monthly
 * rental. The only release route lived on the merchant session
 * (POST /api/app/numbers/:id/release), which an operator legitimately cannot
 * reach — they don't hold a session for someone else's workspace. So a number
 * provisioned by an admin during setup, support or a test could only be taken
 * back with hand-written SQL against production, which is exactly what
 * happened on 2026-08-08.
 *
 * These tests pin the caller, not the release (twilio-provisioning.test covers
 * the release and its org-scoping): the route exists, is admin-gated, rejects a
 * non-integer id before touching Twilio, surfaces the provider's error without
 * logging a release that never happened, and audit-logs the PHONE NUMBER rather
 * than the row id.
 */

let releaseResult: unknown = { ok: true, phoneNumber: "+15551110001" };
let releaseCalledWith: { orgId: string; phoneNumberId: number }[] = [];
let auditEntries: { actor: string; action: string; detail?: unknown }[] = [];

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

const dbLike = {
  select: () => ({ from: (table: unknown) => thenable(getTableName(table) === "orgs" ? [{ id: "org-1" }] : []) }),
  insert: () => ({ values: () => ({ onConflictDoNothing: () => Promise.resolve(), returning: () => Promise.resolve([]) }) }),
  update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  delete: () => ({ where: () => Promise.resolve() }),
};

// ADR-116 addendum: admin-routes.ts now imports `dbBackground` — both names
// must resolve here or the import throws.
mock.module("../database", () => ({ db: dbLike, dbBackground: dbLike }));

// mock.module swaps the whole module, so every export admin-routes imports
// from twilio-provisioning has to exist here or the file fails to load.
mock.module("./twilio-provisioning", () => ({
  getTwilioStatus: async () => null,
  ensureSubaccountForOrg: async () => ({ ok: false, error: "not used in these tests" }),
  buyNumberForOrg: async () => ({ ok: false, error: "not used in these tests" }),
  listAvailableNumbers: async () => ({ ok: false, error: "not used in these tests" }),
  setByoCredentials: async () => ({ ok: false, error: "not used in these tests" }),
  resetToPlatformDefault: async () => ({ ok: false, error: "not used in these tests" }),
  syncNumberWebhooksForOrg: async () => ({ ok: false, error: "not used in these tests" }),
  releaseNumberForOrg: async (orgId: string, phoneNumberId: number) => {
    releaseCalledWith.push({ orgId, phoneNumberId });
    return releaseResult;
  },
}));

mock.module("../app/audit-log", () => ({
  logAdminAction: async (actor: string, action: string, detail?: unknown) => {
    auditEntries.push({ actor, action, detail });
  },
  listAdminAuditLog: async () => [],
}));

process.env.ADMIN_API_KEY = "test-admin-key";
afterAll(() => {
  delete process.env.ADMIN_API_KEY;
});

const { admin } = await import("./admin-routes");

const adminHeaders = { "X-Weeber-Admin-Key": "test-admin-key", "Content-Type": "application/json" };

describe("POST /orgs/:orgId/twilio/numbers/:id/release", () => {
  beforeEach(() => {
    releaseResult = { ok: true, phoneNumber: "+15551110001" };
    releaseCalledWith = [];
    auditEntries = [];
  });

  it("is admin-gated", async () => {
    const res = await admin.request("/orgs/org-1/twilio/numbers/42/release", { method: "POST" });
    expect(res.status).toBe(401);
    // The gate has to stop the request before it can destroy a paid resource.
    expect(releaseCalledWith).toEqual([]);
  });

  it("releases the number and reports which one it gave up", async () => {
    const res = await admin.request("/orgs/org-1/twilio/numbers/42/release", { method: "POST", headers: adminHeaders });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, phoneNumber: "+15551110001" });
    // Both path params are forwarded — releaseNumberForOrg is what enforces
    // org-scoping, so passing the orgId through is the whole guarantee.
    expect(releaseCalledWith).toEqual([{ orgId: "org-1", phoneNumberId: 42 }]);
  });

  it("audit-logs the phone number, not the row id", async () => {
    await admin.request("/orgs/org-1/twilio/numbers/42/release", { method: "POST", headers: adminHeaders });

    expect(auditEntries).toHaveLength(1);
    expect(auditEntries[0]!.action).toBe("twilio.number.released");
    expect(auditEntries[0]!.detail).toEqual({ orgId: "org-1", phoneNumber: "+15551110001" });
  });

  it("rejects a non-integer id before calling Twilio", async () => {
    const res = await admin.request("/orgs/org-1/twilio/numbers/abc/release", { method: "POST", headers: adminHeaders });

    expect(res.status).toBe(400);
    expect(releaseCalledWith).toEqual([]);
  });

  it("surfaces the failure and does NOT audit-log a release that never happened", async () => {
    releaseResult = { ok: false, error: "Number not found for this org" };

    const res = await admin.request("/orgs/org-1/twilio/numbers/42/release", { method: "POST", headers: adminHeaders });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Number not found for this org" });
    // A cross-org id guess must not leave a log entry claiming a release.
    expect(auditEntries).toEqual([]);
  });
});
