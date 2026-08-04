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
let updatedSets: Record<string, unknown>[] = [];
let storedCredentials: { orgId: string; field: string; value: string }[] = [];
let accountsCreated: { friendlyName: string }[] = [];
let createShouldThrow: string | null = null;

mock.module("../database", () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: () => (mockOrgRow ? [mockOrgRow] : []) }) }),
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
  function Twilio() {
    return {};
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
  resolveOrgTwilioCreds: async () => null,
}));

const { ensureSubaccountForOrg } = await import("./twilio-provisioning");

describe("ensureSubaccountForOrg — idempotent provisioning", () => {
  beforeEach(() => {
    process.env.TWILIO_ACCOUNT_SID = "AC_parent";
    process.env.TWILIO_AUTH_TOKEN = "parent_token";
    mockOrgRow = { twilioMode: "platform", twilioAccountSid: null, outboundNumber: null };
    updatedSets = [];
    storedCredentials = [];
    accountsCreated = [];
    createShouldThrow = null;
  });

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
