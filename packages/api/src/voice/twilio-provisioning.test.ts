import { mock, describe, it, expect, beforeEach } from "bun:test";

/**
 * C2b — number provisioning UX. Covers the three behavioral guarantees this
 * feature is built on:
 *   1. listAvailableNumbers returns the full candidate list (no auto-pick).
 *   2. buyNumberForOrg purchases exactly the number the caller passed in
 *      (never re-searches or picks its own), and records it in
 *      org_phone_numbers rather than only orgs.outboundNumber.
 *   3. releaseNumberForOrg is airtight org-scoped: a phoneNumberId that
 *      exists but belongs to a different org must be rejected, not released.
 */

let mockOrgRow: { accountSid: string | null; authToken: string | null } | undefined;
let mockPhoneNumberRows: { id: number; orgId: string; phoneNumber: string; status: string }[] = [];
let insertedRows: Record<string, unknown>[] = [];
let updatedSets: { table: string; set: Record<string, unknown> }[] = [];

let searchResult: { phoneNumber: string; locality: string | null; region: string | null }[] = [];
let removedSids: string[] = [];
let incomingListResult: { sid: string }[] = [];
let createShouldThrow = false;

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
          limit: () => {
            const name = getTableName(table);
            if (name === "orgs") return mockOrgRow ? [mockOrgRow] : [];
            if (name === "org_phone_numbers") return mockPhoneNumberRows;
            return [];
          },
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        insertedRows.push({ table: getTableName(table), ...values });
        return Promise.resolve();
      },
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => ({
        where: () => {
          updatedSets.push({ table: getTableName(table) ?? "", set });
          return Promise.resolve();
        },
      }),
    }),
  },
}));

mock.module("twilio", () => {
  function Twilio() {
    return {
      availablePhoneNumbers: () => ({
        local: {
          list: async () => {
            if (searchResult.length === 0) return [];
            return searchResult;
          },
        },
      }),
      incomingPhoneNumbers: Object.assign(
        (sid: string) => ({
          remove: async () => {
            removedSids.push(sid);
          },
        }),
        {
          create: async ({ phoneNumber }: { phoneNumber: string }) => {
            if (createShouldThrow) throw new Error("Twilio purchase failed");
            return { sid: `PN_${phoneNumber}` };
          },
          list: async () => incomingListResult,
        },
      ),
    };
  }
  return { default: Twilio };
});

// Cred resolution now lives in twilio-client (vault-first, plaintext fallback);
// mock it so these tests exercise twilio-provisioning's own logic. Returns creds
// straight from mockOrgRow, mirroring the previous direct-db-read behavior.
mock.module("./twilio-client", () => ({
  twilioClient: {
    api: { v2010: { accounts: () => ({ update: async () => ({}) }) } },
  },
  // mock.module replaces the whole module, so every export twilio-provisioning
  // imports has to be present here or the import fails at load time.
  getPublicUrl: () => "https://api.weeber.test",
  resolveOrgTwilioCreds: async () =>
    mockOrgRow?.accountSid && mockOrgRow?.authToken
      ? { accountSid: mockOrgRow.accountSid, authToken: mockOrgRow.authToken }
      : null,
}));

const { listAvailableNumbers, buyNumberForOrg, releaseNumberForOrg } = await import("./twilio-provisioning");

describe("C2b number provisioning", () => {
  beforeEach(() => {
    mockOrgRow = { accountSid: "AC_sub_123", authToken: "authtoken123" };
    mockPhoneNumberRows = [];
    insertedRows = [];
    updatedSets = [];
    searchResult = [];
    removedSids = [];
    incomingListResult = [];
    createShouldThrow = false;
  });

  describe("listAvailableNumbers", () => {
    it("returns the full candidate list instead of auto-picking one", async () => {
      searchResult = [
        { phoneNumber: "+15551110001", locality: "San Francisco", region: "CA" },
        { phoneNumber: "+15551110002", locality: "Oakland", region: "CA" },
      ];
      const result = await listAvailableNumbers("org-1", "US", "415");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.numbers).toHaveLength(2);
        expect(result.numbers.map((n) => n.phoneNumber)).toEqual(["+15551110001", "+15551110002"]);
      }
    });

    // An org with no sub-account no longer errors here — it gets one
    // provisioned on the spot (see "number provisioning bootstraps its own
    // sub-account" in twilio-subaccount-idempotency.test.ts). A missing org ROW
    // is the only remaining hard stop, and it must say so rather than blaming a
    // sub-account that was never the problem.
    it("errors with the actual cause when the org row does not exist at all", async () => {
      mockOrgRow = undefined;
      const result = await listAvailableNumbers("org-does-not-exist", "US");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/org not found/i);
    });

    it("errors when the search returns nothing", async () => {
      searchResult = [];
      const result = await listAvailableNumbers("org-1", "US", "999");
      expect(result.ok).toBe(false);
    });
  });

  describe("buyNumberForOrg", () => {
    it("purchases exactly the number passed in, never a different one", async () => {
      const result = await buyNumberForOrg("org-1", "+15551110001");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.phoneNumber).toBe("+15551110001");
    });

    it("records the purchase in org_phone_numbers, not just orgs.outboundNumber", async () => {
      await buyNumberForOrg("org-1", "+15551110001");
      const phoneNumberInsert = insertedRows.find((r) => r.table === "org_phone_numbers");
      expect(phoneNumberInsert).toBeDefined();
      expect(phoneNumberInsert?.orgId).toBe("org-1");
      expect(phoneNumberInsert?.phoneNumber).toBe("+15551110001");
      expect(phoneNumberInsert?.status).toBe("active");

      const legacyUpdate = updatedSets.find((u) => u.table === "orgs");
      expect(legacyUpdate?.set.outboundNumber).toBe("+15551110001");
    });

    it("surfaces the Twilio error instead of silently succeeding when the purchase call fails", async () => {
      createShouldThrow = true;
      const result = await buyNumberForOrg("org-1", "+15551110001");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/failed to purchase|Failed to purchase/i);
      expect(insertedRows).toHaveLength(0);
    });
  });

  describe("releaseNumberForOrg — org-scoping", () => {
    it("releases a number that belongs to the calling org", async () => {
      mockPhoneNumberRows = [{ id: 42, orgId: "org-1", phoneNumber: "+15551110001", status: "active" }];
      incomingListResult = [{ sid: "PN_sid_1" }];
      const result = await releaseNumberForOrg("org-1", 42);
      expect(result.ok).toBe(true);
      expect(removedSids).toEqual(["PN_sid_1"]);
      const statusUpdate = updatedSets.find((u) => u.table === "org_phone_numbers");
      expect(statusUpdate?.set.status).toBe("released");
    });

    it("rejects release when the row lookup (scoped by BOTH id and orgId) finds nothing — cross-org id guess", async () => {
      // The row exists, but for a different org — the mocked select's `where`
      // doesn't actually filter here (mock limitation), so this test asserts
      // the real behavior via an empty rows array, which is what the real
      // `and(eq(id), eq(orgId))` filter produces for a mismatched org.
      mockPhoneNumberRows = [];
      const result = await releaseNumberForOrg("org-attacker", 42);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/not found/i);
      expect(removedSids).toHaveLength(0);
    });

    it("rejects double-release of an already-released number", async () => {
      mockPhoneNumberRows = [{ id: 42, orgId: "org-1", phoneNumber: "+15551110001", status: "released" }];
      const result = await releaseNumberForOrg("org-1", 42);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/already released/i);
    });
  });
});
