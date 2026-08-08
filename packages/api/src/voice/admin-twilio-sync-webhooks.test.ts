import { mock, describe, it, expect, beforeEach, afterAll } from "bun:test";

/**
 * Regression: syncNumberWebhooksForOrg existed, was tested, and could not be
 * run.
 *
 * The function is the only repair path for two states that leave an org's
 * numbers inert — bought before the purchase path set a voiceUrl, or left
 * pointing at a previous PUBLIC_APP_URL. Both fail silently: Twilio has
 * nowhere to send the inbound call, so there is no webhook, no call row and
 * no error on our side, just a caller who hears nothing. With no route
 * calling it, the repair was unreachable in a running system.
 *
 * These tests pin the caller, not the repair (twilio-subaccount-idempotency
 * covers the repair itself): the route exists, is admin-gated, refuses an
 * unknown org, surfaces the provider error, and only writes an audit entry
 * when something was actually changed.
 */

let orgRows: unknown[] = [];
let syncResult: unknown = { ok: true, checked: 0, repaired: [] };
let syncCalledWith: string[] = [];
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

mock.module("../database", () => ({
  db: {
    select: () => ({
      from: (table: unknown) => thenable(getTableName(table) === "orgs" ? orgRows : []),
    }),
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => Promise.resolve(),
        returning: () => Promise.resolve([]),
      }),
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
    delete: () => ({ where: () => Promise.resolve() }),
  },
}));

// mock.module swaps the whole module, so every export admin-routes imports
// from twilio-provisioning has to exist here or the file fails to load.
mock.module("./twilio-provisioning", () => ({
  getTwilioStatus: async () => null,
  ensureSubaccountForOrg: async () => ({ ok: false, error: "not used in these tests" }),
  buyNumberForOrg: async () => ({ ok: false, error: "not used in these tests" }),
  listAvailableNumbers: async () => ({ ok: false, error: "not used in these tests" }),
  releaseNumberForOrg: async () => ({ ok: false, error: "not used in these tests" }),
  setByoCredentials: async () => ({ ok: false, error: "not used in these tests" }),
  resetToPlatformDefault: async () => ({ ok: false, error: "not used in these tests" }),
  syncNumberWebhooksForOrg: async (orgId: string) => {
    syncCalledWith.push(orgId);
    return syncResult;
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

describe("POST /orgs/:orgId/twilio/sync-webhooks", () => {
  beforeEach(() => {
    orgRows = [{ id: "org-1" }];
    syncResult = { ok: true, checked: 0, repaired: [] };
    syncCalledWith = [];
    auditEntries = [];
  });

  it("is admin-gated", async () => {
    const res = await admin.request("/orgs/org-1/twilio/sync-webhooks", { method: "POST" });
    expect(res.status).toBe(401);
    // The gate must stop the request before it can touch Twilio.
    expect(syncCalledWith).toEqual([]);
  });

  it("repairs an org's numbers and reports which ones changed", async () => {
    syncResult = { ok: true, checked: 3, repaired: ["+15551110001", "+15551110002"] };

    const res = await admin.request("/orgs/org-1/twilio/sync-webhooks", { method: "POST", headers: adminHeaders });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ checked: 3, repaired: ["+15551110001", "+15551110002"] });
    expect(syncCalledWith).toEqual(["org-1"]);
  });

  it("audit-logs a repair with the numbers it touched", async () => {
    syncResult = { ok: true, checked: 2, repaired: ["+15551110001"] };

    await admin.request("/orgs/org-1/twilio/sync-webhooks", { method: "POST", headers: adminHeaders });

    expect(auditEntries).toHaveLength(1);
    expect(auditEntries[0]!.action).toBe("twilio.webhooks.synced");
    expect(auditEntries[0]!.detail).toMatchObject({ orgId: "org-1", checked: 2, repaired: ["+15551110001"] });
  });

  it("does not audit-log a no-op sync", async () => {
    syncResult = { ok: true, checked: 4, repaired: [] };

    const res = await admin.request("/orgs/org-1/twilio/sync-webhooks", { method: "POST", headers: adminHeaders });

    expect(res.status).toBe(200);
    // A clean run is not a repair. Logging it would make the audit trail
    // claim fixes that never happened.
    expect(auditEntries).toEqual([]);
  });

  it("404s an unknown org without calling Twilio", async () => {
    orgRows = [];

    const res = await admin.request("/orgs/org-nope/twilio/sync-webhooks", { method: "POST", headers: adminHeaders });

    expect(res.status).toBe(404);
    expect(syncCalledWith).toEqual([]);
  });

  it("surfaces the provider error instead of reporting success", async () => {
    syncResult = { ok: false, error: "PUBLIC_APP_URL is not set" };

    const res = await admin.request("/orgs/org-1/twilio/sync-webhooks", { method: "POST", headers: adminHeaders });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "PUBLIC_APP_URL is not set" });
    expect(auditEntries).toEqual([]);
  });
});
