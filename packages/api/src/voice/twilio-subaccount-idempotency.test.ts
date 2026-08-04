import { mock, describe, it, expect, beforeEach } from "bun:test";

/**
 * Regression: the dedicated-number flow could brick itself permanently.
 *
 * Getting a dedicated number is two Twilio calls — create the sub-account, then
 * buy a number into it — issued back to back by the client. The sub-account
 * route answered 409 whenever a sub-account already existed, so once step 1
 * succeeded and step 2 failed (no numbers in that area code, parent account out
 * of funds, dropped connection), the org sat in "sub-account, no number" and
 * every retry died on step 1 before it could reach step 2. The UI's only other
 * button, Reset, was hidden in exactly that state.
 *
 * These tests pin the fix at the layer that caused it: "ensure a sub-account
 * exists" must be idempotent, must not mint a second one, and must refuse to
 * trample BYO credentials.
 */

type OrgRow = {
  twilioMode: string | null;
  twilioAccountSid: string | null;
  twilioAuthToken?: string | null;
  outboundNumber: string | null;
  name?: string | null;
};

let mockOrgRow: OrgRow | undefined;
let mockPhoneNumberRows: { id: number; orgId: string; phoneNumber: string; status: string }[] = [];
let updatedSets: Record<string, unknown>[] = [];
let storedCredentials: { orgId: string; field: string; value: string }[] = [];
let accountsCreated: { friendlyName: string }[] = [];
let createShouldThrow: string | null = null;

/** Set to null to force "creds unreadable"; leave undefined to derive them from
 * whatever the vault mock has stored, so a sub-account created mid-test starts
 * resolving exactly like it would in production. */
let mockResolvedCreds: { accountSid: string; authToken: string } | null | undefined;

let availableNumbers: { phoneNumber: string; locality: string | null; region: string | null }[] = [];
let purchasedNumbers: string[] = [];

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
            if (name === "org_phone_numbers") return mockPhoneNumberRows;
            return mockOrgRow ? [mockOrgRow] : [];
          },
        }),
      }),
    }),
    update: () => ({
      set: (set: Record<string, unknown>) => ({
        where: () => {
          updatedSets.push(set);
          return Promise.resolve();
        },
      }),
    }),
    insert: () => ({ values: () => Promise.resolve() }),
  },
}));

mock.module("../database/credential-vault", () => ({
  storeCredential: async (orgId: string, field: string, value: string) => {
    storedCredentials.push({ orgId, field, value });
  },
  deleteCredential: async () => {},
  readCredential: async () => null,
  TWILIO_FIELDS: { accountSid: "twilio_account_sid", authToken: "twilio_auth_token" },
  TELEPHONY_VAULT_FIELDS: { twilio: [], plivo: [], exotel: [] },
}));

mock.module("twilio", () => {
  // The sub-account-scoped client getSubClient builds from resolved creds.
  function Twilio() {
    return {
      availablePhoneNumbers: () => ({ local: { list: async () => availableNumbers } }),
      incomingPhoneNumbers: Object.assign((sid: string) => ({ remove: async () => void sid }), {
        create: async ({ phoneNumber }: { phoneNumber: string }) => {
          purchasedNumbers.push(phoneNumber);
          return { sid: `PN_${phoneNumber}` };
        },
        list: async () => [],
      }),
    };
  }
  return { default: Twilio };
});

mock.module("./twilio-client", () => ({
  twilioClient: {
    api: {
      v2010: {
        accounts: Object.assign(() => ({ update: async () => ({}) }), {
          create: async ({ friendlyName }: { friendlyName: string }) => {
            if (createShouldThrow) throw new Error(createShouldThrow);
            accountsCreated.push({ friendlyName });
            return { sid: "AC_newly_created", authToken: "token_new" };
          },
        }),
      },
    },
  },
  resolveOrgTwilioCreds: async () => {
    if (mockResolvedCreds !== undefined) return mockResolvedCreds;
    const accountSid = storedCredentials.find((c) => c.field === "twilio_account_sid")?.value;
    const authToken = storedCredentials.find((c) => c.field === "twilio_auth_token")?.value;
    return accountSid && authToken ? { accountSid, authToken } : null;
  },
}));

const { ensureSubaccountForOrg, listAvailableNumbers, buyNumberForOrg, releaseNumberForOrg } = await import("./twilio-provisioning");

function resetMocks() {
  process.env.TWILIO_ACCOUNT_SID = "AC_parent";
  process.env.TWILIO_AUTH_TOKEN = "parent_token";
  mockOrgRow = { twilioMode: "platform", twilioAccountSid: null, outboundNumber: null };
  mockPhoneNumberRows = [];
  updatedSets = [];
  storedCredentials = [];
  accountsCreated = [];
  createShouldThrow = null;
  mockResolvedCreds = undefined;
  availableNumbers = [];
  purchasedNumbers = [];
}

describe("ensureSubaccountForOrg — idempotent provisioning", () => {
  beforeEach(resetMocks);

  it("creates a sub-account when the org has none, and stores its creds in the vault", async () => {
    const result = await ensureSubaccountForOrg("org-1", "Acme Clinic");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.accountSid).toBe("AC_newly_created");
    expect(result.reused).toBe(false);
    expect(accountsCreated).toEqual([{ friendlyName: "Acme Clinic" }]);
    expect(storedCredentials.map((c) => c.field)).toEqual(["twilio_account_sid", "twilio_auth_token"]);
  });

  it("THE BUG: reuses the existing sub-account instead of erroring, so the number step stays retryable", async () => {
    // This is the exact stuck state: sub-account provisioned, number purchase
    // failed. Before the fix this path returned an error and the caller aborted
    // before it could retry buying a number.
    mockOrgRow = { twilioMode: "platform", twilioAccountSid: "AC_already_there", outboundNumber: null };

    const result = await ensureSubaccountForOrg("org-1", "Acme Clinic");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.accountSid).toBe("AC_already_there");
    expect(result.reused).toBe(true);
  });

  it("never mints a second sub-account for an org that already has one", async () => {
    // The cost-leak half of the same bug: a second sub-account overwrites the
    // SID on the org row, orphaning the first one on Twilio — where it still
    // exists, still bills, and nothing in this system can find it again.
    mockOrgRow = { twilioMode: "platform", twilioAccountSid: "AC_already_there", outboundNumber: null };

    await ensureSubaccountForOrg("org-1", "Acme Clinic");

    expect(accountsCreated).toHaveLength(0);
    expect(updatedSets).toHaveLength(0);
    expect(storedCredentials).toHaveLength(0);
  });

  it("refuses to provision over BYO credentials — that would hijack the org's own Twilio account", async () => {
    mockOrgRow = { twilioMode: "byo", twilioAccountSid: "AC_customer_owned", outboundNumber: "+15551110000" };

    const result = await ensureSubaccountForOrg("org-1", "Acme Clinic");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/BYO/i);
    expect(accountsCreated).toHaveLength(0);
  });

  it("reports a missing org rather than provisioning against a phantom id", async () => {
    mockOrgRow = undefined;
    const result = await ensureSubaccountForOrg("org-nope", "Ghost");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/org not found/i);
    expect(accountsCreated).toHaveLength(0);
  });

  it("surfaces missing platform credentials as a clear config error, not a Twilio stack trace", async () => {
    process.env.TWILIO_ACCOUNT_SID = "";
    process.env.TWILIO_AUTH_TOKEN = "";
    const result = await ensureSubaccountForOrg("org-1", "Acme Clinic");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/TWILIO_ACCOUNT_SID/);
    expect(accountsCreated).toHaveLength(0);
  });

  it("propagates a Twilio-side creation failure without half-writing the org row", async () => {
    createShouldThrow = "Account creation is not allowed for trial accounts";
    const result = await ensureSubaccountForOrg("org-1", "Acme Clinic");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/trial accounts/);
    expect(updatedSets).toHaveLength(0);
    expect(storedCredentials).toHaveLength(0);
  });
});

/**
 * Regression, same day, different surface: the sub-account was a precondition
 * the CLIENT had to satisfy, and only one of the three surfaces that buy numbers
 * did. The onboarding setup modal ("get a number") and the Phone Numbers page
 * (search / buy) both went straight to the number step, so any org that had
 * never visited Integrations hit "No Twilio sub-account provisioned for this org
 * yet" from a screen with no button that could fix it.
 *
 * These pin the precondition inside the primitives, where no future surface can
 * forget it. Creating a sub-account is free and never duplicated; buying the
 * number is the chargeable step and stays an explicit user action.
 */
describe("number provisioning bootstraps its own sub-account", () => {
  beforeEach(resetMocks);

  it("THE BUG: searching for numbers on an org with no sub-account provisions one instead of dead-ending", async () => {
    availableNumbers = [{ phoneNumber: "+15551110001", locality: "San Francisco", region: "CA" }];

    const result = await listAvailableNumbers("org-fresh", "US", "415");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.numbers).toHaveLength(1);
    expect(accountsCreated).toHaveLength(1);
  });

  it("THE BUG: buying a number on an org with no sub-account provisions one instead of dead-ending", async () => {
    const result = await buyNumberForOrg("org-fresh", "+15551110001");

    expect(result.ok).toBe(true);
    expect(purchasedNumbers).toEqual(["+15551110001"]);
    expect(accountsCreated).toHaveLength(1);
  });

  it("provisions at most one sub-account across a search followed by a purchase", async () => {
    // The two-request shape every picker UI uses. The second call must reuse.
    availableNumbers = [{ phoneNumber: "+15551110001", locality: null, region: null }];
    await listAvailableNumbers("org-fresh", "US");
    mockOrgRow = { twilioMode: "platform", twilioAccountSid: "AC_newly_created", outboundNumber: null };

    await buyNumberForOrg("org-fresh", "+15551110001");

    expect(accountsCreated).toHaveLength(1);
  });

  it("still refuses BYO orgs — never provisions a platform sub-account over customer-owned credentials", async () => {
    mockOrgRow = { twilioMode: "byo", twilioAccountSid: "AC_customer_owned", outboundNumber: null };
    mockResolvedCreds = null; // customer's token not readable (not yet stored / rotated)

    const result = await buyNumberForOrg("org-byo", "+15551110001");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/BYO/i);
    expect(accountsCreated).toHaveLength(0);
    expect(purchasedNumbers).toHaveLength(0);
  });

  it("names the real problem when the SID is on the org row but its credentials are unreadable", async () => {
    // ensure() happily reuses the existing SID, so retrying can never resolve
    // this. Repeating "no sub-account provisioned" would send the user around
    // the same loop forever; the honest fix is reset-and-reprovision.
    mockOrgRow = { twilioMode: "platform", twilioAccountSid: "AC_desynced", outboundNumber: null };
    mockResolvedCreds = null;

    const result = await buyNumberForOrg("org-desynced", "+15551110001");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/unreadable/i);
    expect(result.error).not.toMatch(/No Twilio sub-account provisioned/);
    expect(accountsCreated).toHaveLength(0);
    expect(purchasedNumbers).toHaveLength(0);
  });

  it("reports a missing org rather than provisioning against a phantom id", async () => {
    mockOrgRow = undefined;
    const result = await buyNumberForOrg("org-nope", "+15551110001");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/org not found/i);
    expect(accountsCreated).toHaveLength(0);
  });

  it("does NOT provision a sub-account to service a release — there'd be no number to release", async () => {
    mockPhoneNumberRows = [{ id: 7, orgId: "org-fresh", phoneNumber: "+15551110001", status: "active" }];
    mockResolvedCreds = null;

    const result = await releaseNumberForOrg("org-fresh", 7);

    expect(result.ok).toBe(false);
    expect(accountsCreated).toHaveLength(0);
  });
});
