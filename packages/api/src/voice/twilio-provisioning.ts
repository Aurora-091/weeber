/**
 * Per-org Twilio isolation — provisioning a real sub-account (platform mode)
 * or validating + storing a merchant's own credentials (BYO mode). See
 * schema.ts's `orgs.twilioMode`/`twilioAccountSid`/`twilioAuthToken` and
 * DECISIONS.md ADR-042 for why this exists (ADR-030 explicitly deferred it).
 */
import Twilio from "twilio";
import { eq } from "drizzle-orm";
import { db } from "../database";
import { orgs } from "../database/schema";
import { twilioClient } from "./twilio-client";

export type TwilioStatus = {
  mode: "platform" | "byo";
  /** Full SID only if it's a real dedicated account — never returns the
   * auth token, here or anywhere else. */
  accountSid: string | null;
  outboundNumber: string | null;
  /** True when twilioMode is "platform" but no sub-account has actually
   * been provisioned yet — i.e. still riding the global env credentials. */
  usingGlobalDefault: boolean;
};

export async function getTwilioStatus(orgId: string): Promise<TwilioStatus | null> {
  const [org] = await db
    .select({
      twilioMode: orgs.twilioMode,
      twilioAccountSid: orgs.twilioAccountSid,
      outboundNumber: orgs.outboundNumber,
    })
    .from(orgs)
    .where(eq(orgs.id, orgId))
    .limit(1);
  if (!org) return null;
  const mode = org.twilioMode === "byo" ? "byo" : "platform";
  return {
    mode,
    accountSid: org.twilioAccountSid,
    outboundNumber: org.outboundNumber,
    usingGlobalDefault: mode === "platform" && !org.twilioAccountSid,
  };
}

export type ProvisionResult = { ok: true; accountSid: string } | { ok: false; error: string };

/**
 * Creates a real Twilio sub-account under the platform's parent account and
 * stores its credentials on the org row. Does NOT buy a number — that's a
 * separate step (buyNumberForOrg) since it costs money and the caller
 * should get to pick an area code/country first.
 */
export async function createSubaccountForOrg(orgId: string, friendlyName: string): Promise<ProvisionResult> {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    return { ok: false, error: "Platform Twilio credentials (TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN) are not configured" };
  }

  let account: { sid: string; authToken: string };
  try {
    const created = await twilioClient.api.v2010.accounts.create({ friendlyName });
    account = { sid: created.sid, authToken: created.authToken };
  } catch (err) {
    return { ok: false, error: `Failed to create Twilio sub-account: ${(err as Error).message}` };
  }

  await db
    .update(orgs)
    .set({ twilioMode: "platform", twilioAccountSid: account.sid, twilioAuthToken: account.authToken })
    .where(eq(orgs.id, orgId));

  return { ok: true, accountSid: account.sid };
}

export type BuyNumberResult = { ok: true; phoneNumber: string } | { ok: false; error: string };

/**
 * Searches for and purchases a local number, scoped to the org's own
 * sub-account (not the parent) — a sub-account's numbers must be bought
 * with its own credentials, Twilio doesn't let the parent buy on its
 * behalf. Only usable once createSubaccountForOrg has run for this org.
 */
export async function buyNumberForOrg(orgId: string, countryCode: string, areaCode?: string): Promise<BuyNumberResult> {
  const [org] = await db
    .select({ accountSid: orgs.twilioAccountSid, authToken: orgs.twilioAuthToken })
    .from(orgs)
    .where(eq(orgs.id, orgId))
    .limit(1);
  if (!org?.accountSid || !org?.authToken) {
    return { ok: false, error: "No Twilio sub-account provisioned for this org yet — call createSubaccountForOrg first" };
  }

  const subClient = Twilio(org.accountSid, org.authToken);

  let candidates: { phoneNumber: string }[];
  try {
    candidates = await subClient.availablePhoneNumbers(countryCode).local.list({
      areaCode: areaCode ? Number(areaCode) : undefined,
      voiceEnabled: true,
      limit: 1,
    });
  } catch (err) {
    return { ok: false, error: `Failed to search available numbers: ${(err as Error).message}` };
  }
  if (candidates.length === 0) {
    return { ok: false, error: `No available numbers found for country ${countryCode}${areaCode ? ` / area code ${areaCode}` : ""}` };
  }

  const chosen = candidates[0]!.phoneNumber;
  try {
    await subClient.incomingPhoneNumbers.create({ phoneNumber: chosen });
  } catch (err) {
    return { ok: false, error: `Found ${chosen} but failed to purchase it: ${(err as Error).message}` };
  }

  await db.update(orgs).set({ outboundNumber: chosen }).where(eq(orgs.id, orgId));
  return { ok: true, phoneNumber: chosen };
}

export type ByoResult = { ok: true } | { ok: false; error: string };

/**
 * Validates a merchant's own Twilio credentials against Twilio's own API
 * before persisting anything — a typo'd SID/token should fail immediately
 * here, not silently on the first real call three steps later.
 */
export async function setByoCredentials(
  orgId: string,
  input: { accountSid: string; authToken: string; phoneNumber: string },
): Promise<ByoResult> {
  const { accountSid, authToken, phoneNumber } = input;
  if (!accountSid.startsWith("AC")) return { ok: false, error: "Account SID must start with AC" };

  try {
    const account = await Twilio(accountSid, authToken).api.v2010.accounts(accountSid).fetch();
    if (account.status !== "active") {
      return { ok: false, error: `Twilio account status is "${account.status}", not active` };
    }
  } catch (err) {
    return { ok: false, error: `Could not verify these Twilio credentials: ${(err as Error).message}` };
  }

  await db
    .update(orgs)
    .set({ twilioMode: "byo", twilioAccountSid: accountSid, twilioAuthToken: authToken, outboundNumber: phoneNumber })
    .where(eq(orgs.id, orgId));

  return { ok: true };
}

/** Reverts to the platform global default — clears the dedicated
 * credentials entirely (does not delete the underlying Twilio sub-account
 * or number, just stops using them; that's a deliberate manual Twilio
 * Console action, not something to do silently from a reset button). */
export async function resetToPlatformDefault(orgId: string): Promise<void> {
  await db
    .update(orgs)
    .set({ twilioMode: "platform", twilioAccountSid: null, twilioAuthToken: null, outboundNumber: null })
    .where(eq(orgs.id, orgId));
}
