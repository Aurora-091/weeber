/**
 * Per-org Twilio isolation — provisioning a real sub-account (platform mode)
 * or validating + storing a user's own credentials (BYO mode). See
 * schema.ts's `orgs.twilioMode`/`twilioAccountSid`/`twilioAuthToken` and
 * DECISIONS.md ADR-042 for why this exists (ADR-030 explicitly deferred it).
 */
import Twilio from "twilio";
import { eq, and } from "drizzle-orm";
import { db } from "../database";
import { orgs, orgPhoneNumbers } from "../database/schema";
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
    .set({ telephonyProvider: "twilio", twilioMode: "platform", twilioAccountSid: account.sid, twilioAuthToken: account.authToken })
    .where(eq(orgs.id, orgId));

  return { ok: true, accountSid: account.sid };
}

export type BuyNumberResult = { ok: true; phoneNumber: string } | { ok: false; error: string };
export type AvailableNumbersResult =
  | { ok: true; numbers: { phoneNumber: string; locality: string | null; region: string | null }[] }
  | { ok: false; error: string };

async function getSubClient(orgId: string): Promise<{ ok: true; client: Twilio.Twilio } | { ok: false; error: string }> {
  const [org] = await db
    .select({ accountSid: orgs.twilioAccountSid, authToken: orgs.twilioAuthToken })
    .from(orgs)
    .where(eq(orgs.id, orgId))
    .limit(1);
  if (!org?.accountSid || !org?.authToken) {
    return { ok: false, error: "No Twilio sub-account provisioned for this org yet — call createSubaccountForOrg first" };
  }
  return { ok: true, client: Twilio(org.accountSid, org.authToken) };
}

/**
 * Searches for local numbers available to buy, scoped to the org's own
 * sub-account — does NOT purchase anything. Returns a candidate list so
 * the caller (the numbers picker UI) can let the user choose, rather than
 * this module silently auto-picking one for them.
 */
export async function listAvailableNumbers(orgId: string, countryCode: string, areaCode?: string): Promise<AvailableNumbersResult> {
  const sub = await getSubClient(orgId);
  if (!sub.ok) return sub;

  let candidates: { phoneNumber: string; locality: string | null; region: string | null }[];
  try {
    candidates = await sub.client.availablePhoneNumbers(countryCode).local.list({
      areaCode: areaCode ? Number(areaCode) : undefined,
      voiceEnabled: true,
      limit: 20,
    });
  } catch (err) {
    return { ok: false, error: `Failed to search available numbers: ${(err as Error).message}` };
  }
  if (candidates.length === 0) {
    return { ok: false, error: `No available numbers found for country ${countryCode}${areaCode ? ` / area code ${areaCode}` : ""}` };
  }

  return { ok: true, numbers: candidates.map((c) => ({ phoneNumber: c.phoneNumber, locality: c.locality ?? null, region: c.region ?? null })) };
}

/**
 * Purchases a specific number the caller already chose from
 * listAvailableNumbers — this function no longer searches or auto-picks.
 * Inserts a row into org_phone_numbers rather than overwriting
 * orgs.outboundNumber directly, since an org can now hold several numbers
 * (one per agent) instead of a single shared one.
 */
export async function buyNumberForOrg(orgId: string, phoneNumber: string): Promise<BuyNumberResult> {
  const sub = await getSubClient(orgId);
  if (!sub.ok) return sub;

  try {
    await sub.client.incomingPhoneNumbers.create({ phoneNumber });
  } catch (err) {
    return { ok: false, error: `Failed to purchase ${phoneNumber}: ${(err as Error).message}` };
  }

  await db.insert(orgPhoneNumbers).values({ orgId, provider: "twilio", phoneNumber, status: "active" });

  // Keep legacy orgs.outboundNumber populated as a fallback for orgs that
  // don't yet assign per-agent numbers (resolveOutboundNumberForAgent falls
  // back to it when nothing else applies).
  await db.update(orgs).set({ outboundNumber: phoneNumber }).where(eq(orgs.id, orgId));

  return { ok: true, phoneNumber };
}

export type ReleaseNumberResult = { ok: true } | { ok: false; error: string };

/**
 * Releases (deletes) a number from Twilio and marks its org_phone_numbers
 * row "released". Org-scoped: the row lookup requires both the number's id
 * AND its orgId to match, so one org can never release another org's
 * number even if it guesses an id.
 */
export async function releaseNumberForOrg(orgId: string, phoneNumberId: number): Promise<ReleaseNumberResult> {
  const [row] = await db
    .select()
    .from(orgPhoneNumbers)
    .where(and(eq(orgPhoneNumbers.id, phoneNumberId), eq(orgPhoneNumbers.orgId, orgId)))
    .limit(1);
  if (!row) return { ok: false, error: "Number not found for this org" };
  if (row.status === "released") return { ok: false, error: "Number already released" };

  const sub = await getSubClient(orgId);
  if (!sub.ok) return sub;

  try {
    const incoming = await sub.client.incomingPhoneNumbers.list({ phoneNumber: row.phoneNumber, limit: 1 });
    if (incoming[0]) {
      await sub.client.incomingPhoneNumbers(incoming[0].sid).remove();
    }
  } catch (err) {
    return { ok: false, error: `Failed to release ${row.phoneNumber} on Twilio: ${(err as Error).message}` };
  }

  await db.update(orgPhoneNumbers).set({ status: "released" }).where(eq(orgPhoneNumbers.id, phoneNumberId));

  return { ok: true };
}

export type ByoResult = { ok: true } | { ok: false; error: string };

/**
 * Validates a user's own Twilio credentials against Twilio's own API
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
    .set({ telephonyProvider: "twilio", twilioMode: "byo", twilioAccountSid: accountSid, twilioAuthToken: authToken, outboundNumber: phoneNumber })
    .where(eq(orgs.id, orgId));

  return { ok: true };
}

/** Reverts to the platform global default (Twilio) — clears every
 * provider's stored credentials, not just Twilio's, since only one
 * provider can be active at a time and this is the shared "start over"
 * button all three telephony cards call. Does not delete anything on the
 * provider's own side (e.g. the underlying Twilio sub-account or number),
 * just stops using them; that's a deliberate manual action on the
 * provider's own console, not something to do silently from here. */
export async function resetToPlatformDefault(orgId: string): Promise<void> {
  await db
    .update(orgs)
    .set({
      telephonyProvider: "twilio",
      twilioMode: "platform",
      twilioAccountSid: null,
      twilioAuthToken: null,
      plivoAuthId: null,
      plivoAuthToken: null,
      exotelSid: null,
      exotelApiKey: null,
      exotelApiToken: null,
      exotelSubdomain: null,
      outboundNumber: null,
    })
    .where(eq(orgs.id, orgId));
}
