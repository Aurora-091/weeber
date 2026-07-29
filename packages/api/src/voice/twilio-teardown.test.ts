import { mock, describe, it, expect, beforeEach } from "bun:test";

/**
 * closeOrgTelephony (2026-07-20) — the inactivity/close-account teardown.
 * Guarantees:
 *   1. "close" releases every rented number AND closes the subaccount, then
 *      clears creds + marks the org "closed".
 *   2. "suspend" releases numbers + suspends the subaccount (reversible),
 *      marks org "suspended", keeps creds.
 *   3. BYO orgs never have their (customer-owned) Twilio account touched —
 *      only the org row flips.
 *   4. Platform orgs with no subaccount yet just flip the org row.
 */

let mockOrgRow:
  | { twilioMode: string; accountSid: string | null; authToken: string | null }
  | undefined;
let updatedSets: { table: string; set: Record<string, unknown> }[] = [];

let removedNumberSids: string[] = [];
let incomingListResult: { sid: string }[] = [];
let accountStatusUpdates: { sid: string; status: string }[] = [];

function getTableName(table: unknown): string | undefined {
  if (!table) return undefined;
  const sym = Object.getOwnPropertySymbols(table).find((s) => s.toString() === "Symbol(drizzle:Name)");
  return sym ? (table as Record<symbol, string>)[sym] : undefined;
}

mock.module("../database", () => ({
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: () => (getTableName(table) === "orgs" && mockOrgRow ? [mockOrgRow] : []),
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => ({
        where: () => {
          updatedSets.push({ table: getTableName(table) ?? "", set });
          return Promise.resolve();
        },
      }),
    }),
    // deleteCredential (called on "close") runs a raw db.execute against the
    // vault delete function — no-op it here.
    execute: async () => [],
  },
}));

// Sub-account client (constructed with sub creds) exposes incomingPhoneNumbers;
// the parent client (twilioClient) exposes api.v2010.accounts(sid).update.
mock.module("twilio", () => {
  function Twilio() {
    return {
      incomingPhoneNumbers: Object.assign(
        (sid: string) => ({ remove: async () => void removedNumberSids.push(sid) }),
        { list: async () => incomingListResult },
      ),
    };
  }
  return { default: Twilio };
});

mock.module("./twilio-client", () => ({
  twilioClient: {
    api: {
      v2010: {
        accounts: (sid: string) => ({
          update: async ({ status }: { status: string }) => {
            accountStatusUpdates.push({ sid, status });
            return { sid, status };
          },
        }),
      },
    },
  },
  // Vault-first cred resolver — return creds from the mocked org row, mirroring
  // the previous direct plaintext-column read.
  resolveOrgTwilioCreds: async () =>
    mockOrgRow?.accountSid && mockOrgRow?.authToken
      ? { accountSid: mockOrgRow.accountSid, authToken: mockOrgRow.authToken }
      : null,
}));

const { closeOrgTelephony } = await import("./twilio-provisioning");

beforeEach(() => {
  updatedSets = [];
  removedNumberSids = [];
  incomingListResult = [];
  accountStatusUpdates = [];
});

describe("closeOrgTelephony", () => {
  it("close: releases all numbers, closes the subaccount, clears creds + marks org closed", async () => {
    mockOrgRow = { twilioMode: "platform", accountSid: "AC_sub", authToken: "tok" };
    incomingListResult = [{ sid: "PN1" }, { sid: "PN2" }];

    const res = await closeOrgTelephony("org-1", "close");

    expect(res).toEqual({ ok: true, releasedNumbers: 2, subaccountAction: "closed" });
    expect(removedNumberSids).toEqual(["PN1", "PN2"]);
    expect(accountStatusUpdates).toEqual([{ sid: "AC_sub", status: "closed" }]);
    const orgUpdate = updatedSets.find((u) => u.table === "orgs");
    expect(orgUpdate?.set).toMatchObject({ status: "closed", twilioAccountSid: null, twilioAuthToken: null });
  });

  it("suspend: releases numbers + suspends subaccount, marks org suspended (creds kept)", async () => {
    mockOrgRow = { twilioMode: "platform", accountSid: "AC_sub", authToken: "tok" };
    incomingListResult = [{ sid: "PN1" }];

    const res = await closeOrgTelephony("org-1", "suspend");

    expect(res).toEqual({ ok: true, releasedNumbers: 1, subaccountAction: "suspended" });
    expect(accountStatusUpdates).toEqual([{ sid: "AC_sub", status: "suspended" }]);
    const orgUpdate = updatedSets.find((u) => u.table === "orgs");
    expect(orgUpdate?.set).toMatchObject({ status: "suspended" });
    expect(orgUpdate?.set).not.toHaveProperty("twilioAccountSid");
  });

  it("BYO: flips the org row only, never touches the customer's Twilio account", async () => {
    mockOrgRow = { twilioMode: "byo", accountSid: "AC_cust", authToken: "tok" };

    const res = await closeOrgTelephony("org-1", "close");

    expect(res).toEqual({ ok: true, releasedNumbers: 0, subaccountAction: "none" });
    expect(removedNumberSids).toEqual([]);
    expect(accountStatusUpdates).toEqual([]);
    expect(updatedSets.find((u) => u.table === "orgs")?.set).toMatchObject({ status: "closed" });
  });

  it("platform with no subaccount yet: flips org row only", async () => {
    mockOrgRow = { twilioMode: "platform", accountSid: null, authToken: null };

    const res = await closeOrgTelephony("org-1", "suspend");

    expect(res).toEqual({ ok: true, releasedNumbers: 0, subaccountAction: "none" });
    expect(accountStatusUpdates).toEqual([]);
    expect(updatedSets.find((u) => u.table === "orgs")?.set).toMatchObject({ status: "suspended" });
  });
});
