import { mock, describe, it, expect, beforeEach } from "bun:test";

/**
 * Regression: resetting telephony made a platform-rented number
 * permanently unreleasable while it kept billing.
 *
 * resetToPlatformDefault nulls orgs.twilioAccountSid/twilioAuthToken AND
 * purges the telephony vault entries, but left org_phone_numbers rows at
 * status "active". releaseNumberForOrg resolves its Twilio client from those
 * same credentials, so after a reset there was no route in the system — admin
 * or merchant — that could give the number back. It carried on renting
 * monthly and recovery meant hand-written SQL plus digging the sub-account SID
 * out of the admin audit log.
 *
 * The function's docstring justified leaving Twilio's side alone because a
 * release is "a deliberate manual action on the provider's own console". True
 * for BYO, where the customer owns the account. False for platform mode: the
 * number sits in a sub-account under our parent account and the merchant has
 * no console login for it at all.
 *
 * These tests pin the guard, not the release itself (twilio-provisioning.test
 * covers the release): a platform org holding active numbers is refused and
 * NOTHING is written, a BYO org is still allowed through, and an org with no
 * active numbers resets normally.
 */

let mockOrgRow: { twilioMode: string | null } | undefined;
let mockPhoneNumberRows: { id: number; phoneNumber: string }[] = [];
let updatedSets: { table: string; set: Record<string, unknown> }[] = [];
let vaultDeletes: number = 0;

function getTableName(table: unknown): string | undefined {
  if (!table) return undefined;
  const sym = Object.getOwnPropertySymbols(table).find((s) => s.toString() === "Symbol(drizzle:Name)");
  return sym ? (table as Record<symbol, string>)[sym] : undefined;
}

/**
 * The org lookup ends in .limit(1); the held-numbers lookup is awaited
 * straight off .where() with no limit. A plain object mock only satisfies the
 * first, so the chain has to be awaitable at every step or the guard's query
 * silently resolves to a non-array and the guard can never fire.
 */
function thenable(rows: unknown[]) {
  const promise = Promise.resolve(rows) as Promise<unknown[]> & Record<string, unknown>;
  promise.where = () => thenable(rows);
  promise.limit = () => thenable(rows);
  return promise;
}

mock.module("../database", () => ({
  db: {
    select: () => ({
      from: (table: unknown) => {
        const name = getTableName(table);
        if (name === "orgs") return thenable(mockOrgRow ? [mockOrgRow] : []);
        if (name === "org_phone_numbers") return thenable(mockPhoneNumberRows);
        return thenable([]);
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

mock.module("../database/credential-vault", () => ({
  storeCredential: async () => {},
  deleteCredential: async () => {
    vaultDeletes++;
  },
  TWILIO_FIELDS: { accountSid: "twilio_account_sid", authToken: "twilio_auth_token" },
  TELEPHONY_VAULT_FIELDS: {
    twilio: ["twilio_account_sid", "twilio_auth_token"],
    plivo: ["plivo_auth_id", "plivo_auth_token"],
    exotel: ["exotel_sid", "exotel_api_key", "exotel_api_token"],
  },
}));

mock.module("twilio", () => {
  function Twilio() {
    return { incomingPhoneNumbers: Object.assign(() => ({ remove: async () => {} }), { list: async () => [] }) };
  }
  return { default: Twilio };
});

// mock.module replaces the whole module, so every export twilio-provisioning
// imports from twilio-client has to be present here or the import fails.
mock.module("./twilio-client", () => ({
  twilioClient: { api: { v2010: { accounts: () => ({ update: async () => ({}) }) } } },
  getPublicUrl: () => "https://api.weeber.test",
  resolveOrgTwilioCreds: async () => null,
}));

const { resetToPlatformDefault } = await import("./twilio-provisioning");

beforeEach(() => {
  mockOrgRow = { twilioMode: "platform" };
  mockPhoneNumberRows = [];
  updatedSets = [];
  vaultDeletes = 0;
});

describe("resetToPlatformDefault — orphaned-number guard", () => {
  it("refuses to reset a platform org that still holds active numbers", async () => {
    mockPhoneNumberRows = [
      { id: 1, phoneNumber: "+15551110001" },
      { id: 2, phoneNumber: "+15551110002" },
    ];

    const result = await resetToPlatformDefault("org-1");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The operator has to be told which numbers are blocking it, otherwise
      // the refusal is a dead end.
      expect(result.error).toContain("+15551110001");
      expect(result.error).toContain("+15551110002");
      expect(result.error).toMatch(/release them first/i);
    }
  });

  it("writes nothing at all when it refuses — creds stay resolvable so the numbers stay releasable", async () => {
    mockPhoneNumberRows = [{ id: 1, phoneNumber: "+15551110001" }];

    await resetToPlatformDefault("org-1");

    // This is the whole point of the fix: a partial reset that clears the
    // credentials but leaves the rows active is the unrecoverable state.
    expect(updatedSets).toHaveLength(0);
    expect(vaultDeletes).toBe(0);
  });

  it("resets normally when the org holds no active numbers", async () => {
    mockPhoneNumberRows = [];

    const result = await resetToPlatformDefault("org-1");

    expect(result.ok).toBe(true);
    const orgUpdate = updatedSets.find((u) => u.table === "orgs");
    expect(orgUpdate?.set.twilioAccountSid).toBeNull();
    expect(orgUpdate?.set.twilioMode).toBe("platform");
    // Every provider's vault fields still get purged (2 twilio + 2 plivo + 3 exotel).
    expect(vaultDeletes).toBe(7);
  });

  it("still lets a BYO org reset while holding numbers — the customer owns that Twilio console", async () => {
    mockOrgRow = { twilioMode: "byo" };
    mockPhoneNumberRows = [{ id: 1, phoneNumber: "+15551110001" }];

    const result = await resetToPlatformDefault("org-byo");

    expect(result.ok).toBe(true);
    expect(updatedSets.find((u) => u.table === "orgs")).toBeDefined();
  });

  it("treats an unknown org as platform-owned rather than guessing BYO", async () => {
    // Being wrong in the BYO direction is the expensive one: it would clear
    // the credentials for numbers we are the ones paying for.
    mockOrgRow = undefined;
    mockPhoneNumberRows = [{ id: 1, phoneNumber: "+15551110001" }];

    const result = await resetToPlatformDefault("org-missing");

    expect(result.ok).toBe(false);
    expect(updatedSets).toHaveLength(0);
  });
});
