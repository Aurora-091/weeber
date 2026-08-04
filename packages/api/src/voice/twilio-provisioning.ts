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
import { storeCredential, deleteCredential, TWILIO_FIELDS, TELEPHONY_VAULT_FIELDS } from "../database/credential-vault";
import { twilioClient, resolveOrgTwilioCreds } from "./twilio-client";

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

  await storeCredential(orgId, TWILIO_FIELDS.accountSid, account.sid);
  await storeCredential(orgId, TWILIO_FIELDS.authToken, account.authToken);

  return { ok: true, accountSid: account.sid };
}

export type EnsureSubaccountResult =
  | { ok: true; accountSid: string; reused: boolean }
  | { ok: false; error: string };

/**
 * Idempotent "make sure this org has a sub-account". Returns the existing SID
 * with `reused: true` instead of erroring, and only calls Twilio when there
 * genuinely isn't one yet.
 *
 * WHY THIS EXISTS (bug, 2026-08-04)
 * Getting a dedicated number is two Twilio calls: create the sub-account, then
 * buy a number into it. The client ran them back to back and the sub-account
 * route answered 409 "already provisioned — reset first" whenever one existed.
 * So the moment step 1 succeeded and step 2 failed — no numbers in the area
 * code, parent account out of funds, a dropped connection — the org was stuck
 * in a state where it HAD a sub-account but no number, and every retry died on
 * step 1 before it could ever reach step 2. The 409 was protecting against
 * creating a second sub-account, which is a real risk, but it was doing it by
 * making the retry path impossible rather than by making the step idempotent.
 *
 * `createSubaccountForOrg` is left non-idempotent on purpose: it is the honest
 * "create one now" primitive. Callers that mean "ensure one exists" want this.
 */
export async function ensureSubaccountForOrg(orgId: string, friendlyName: string): Promise<EnsureSubaccountResult> {
  const existing = await getTwilioStatus(orgId);
  if (!existing) return { ok: false, error: "org not found" };

  // BYO orgs already have working credentials that are not ours to replace —
  // silently provisioning a platform sub-account over the top would hijack
  // their telephony and start billing us for it.
  if (existing.mode === "byo") {
    return { ok: false, error: "This org is on its own Twilio credentials (BYO) — reset to platform mode first." };
  }
  if (existing.accountSid) return { ok: true, accountSid: existing.accountSid, reused: true };

  const created = await createSubaccountForOrg(orgId, friendlyName);
  if (!created.ok) return created;
  return { ok: true, accountSid: created.accountSid, reused: false };
}

export type BuyNumberResult = { ok: true; phoneNumber: string } | { ok: false; error: string };
export type AvailableNumbersResult =
  | { ok: true; numbers: { phoneNumber: string; locality: string | null; region: string | null }[] }
  | { ok: false; error: string };

async function getSubClient(orgId: string): Promise<{ ok: true; client: Twilio.Twilio } | { ok: false; error: string }> {
  // Vault-first (plaintext fallback during transition) via the shared resolver
  // in twilio-client.ts — never read orgs.twilioAuthToken directly here.
  const creds = await resolveOrgTwilioCreds(orgId);
  if (!creds) {
    // This string reaches the user as a toast, so it names the user-facing
    // step ("get a dedicated number") rather than an internal function.
    return {
      ok: false,
      error: "No Twilio sub-account provisioned for this org yet — start the dedicated-number setup first.",
    };
  }
  return { ok: true, client: Twilio(creds.accountSid, creds.authToken) };
}

/**
 * getSubClient, but provisions the sub-account first when the org hasn't got
 * one yet. For the number paths this is what the caller always meant.
 *
 * WHY THIS EXISTS (bug, 2026-08-04)
 * Every number operation needs a sub-account, but creating one was left to the
 * client as a separate first request — and only ONE of the three surfaces that
 * buy numbers actually made it. The onboarding setup modal
 * (components/app/setup-modal.tsx, "get a number" / autoProvisionMutation) and
 * the Phone Numbers page (pages/app/numbers.tsx, search + buy) both went
 * straight to the number step, so on any org that had never visited
 * Integrations they failed with "No Twilio sub-account provisioned for this org
 * yet" — from a first-run modal and a top-level nav page, neither of which
 * offers a button that would fix it. Dead end, and the error blamed a step the
 * user was never shown.
 *
 * Fixing it at the three route call sites would have left the same trap set for
 * the fourth surface, so the precondition lives here instead, in the primitives
 * that actually need it. Safe to do implicitly because an idle sub-account with
 * no numbers costs nothing (same reasoning closeOrgTelephony documents) and
 * ensureSubaccountForOrg never creates a second one — the *number* is the
 * chargeable step, and that stays an explicit user action.
 *
 * releaseNumberForOrg deliberately does NOT use this: if there's no
 * sub-account there is no number to release, so provisioning one to service a
 * release would be pure waste and its plain "no sub-account" error is honest.
 */
async function getSubClientEnsuring(orgId: string): Promise<{ ok: true; client: Twilio.Twilio } | { ok: false; error: string }> {
  const direct = await getSubClient(orgId);
  if (direct.ok) return direct;

  const [org] = await db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, orgId)).limit(1);
  if (!org) return { ok: false, error: "org not found" };

  // Refuses BYO orgs and reuses an existing SID rather than minting a second.
  const ensured = await ensureSubaccountForOrg(orgId, org.name ?? orgId);
  if (!ensured.ok) return { ok: false, error: ensured.error };

  const retry = await getSubClient(orgId);
  if (retry.ok) return retry;

  // Reached only when the org row claims a sub-account SID that ensure happily
  // reused, yet the credential resolver still can't produce a usable pair —
  // i.e. the auth token is missing or unreadable while the SID is set. Retrying
  // can never clear that (ensure keeps reusing the same SID), so say what the
  // state actually is instead of repeating "no sub-account provisioned" and
  // sending the user back around the same loop.
  return {
    ok: false,
    error: ensured.reused
      ? "This org's Twilio sub-account credentials are stored but unreadable — reset telephony and provision a dedicated number again."
      : retry.error,
  };
}

/**
 * Searches for local numbers available to buy, scoped to the org's own
 * sub-account — does NOT purchase anything. Returns a candidate list so
 * the caller (the numbers picker UI) can let the user choose, rather than
 * this module silently auto-picking one for them.
 */
export async function listAvailableNumbers(orgId: string, countryCode: string, areaCode?: string): Promise<AvailableNumbersResult> {
  const sub = await getSubClientEnsuring(orgId);
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
  const sub = await getSubClientEnsuring(orgId);
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

/**
 * Keeps the Twilio subaccount's friendly name in sync when the org renames
 * itself — the friendly name is set once at createSubaccountForOrg and would
 * otherwise go stale, leaving the Twilio console showing an old/placeholder
 * name that's the only human-readable hook for reconciling which subaccount
 * belongs to whom. Best-effort: a failure here never blocks the rename
 * itself (the DB name is the source of truth), just logs. Platform mode with
 * a provisioned subaccount only.
 */
export async function syncSubaccountFriendlyName(orgId: string, friendlyName: string): Promise<void> {
  const [org] = await db
    .select({ mode: orgs.twilioMode, accountSid: orgs.twilioAccountSid })
    .from(orgs)
    .where(eq(orgs.id, orgId))
    .limit(1);
  if (!org || org.mode !== "platform" || !org.accountSid) return;
  try {
    await twilioClient.api.v2010.accounts(org.accountSid).update({ friendlyName });
  } catch (err) {
    console.error(`[twilio] failed to sync friendly name for ${orgId}: ${(err as Error).message}`);
  }
}

export type CloseTelephonyResult =
  | { ok: true; releasedNumbers: number; subaccountAction: "closed" | "suspended" | "none" }
  | { ok: false; error: string };

/**
 * Tears down an org's telephony to stop it billing when the org goes cold or
 * the user closes their account. Two modes:
 *
 *  - "suspend": reversible. Releases every rented number (the actual monthly
 *    cost) and suspends the Twilio subaccount. The org can come back later —
 *    its creds stay on the row, status -> "suspended". Used by the 30-day
 *    inactivity step.
 *  - "close": permanent. Releases numbers, then CLOSES the subaccount on
 *    Twilio (irreversible — Twilio won't let it reopen), clears the stored
 *    creds, and marks the org "closed". Used by the 60-day sweep step and by
 *    the user's own "close account" action.
 *
 * Billing note: an idle subaccount with no numbers costs nothing, so the
 * number release is what actually stops the bleed; the subaccount status
 * change is cleanup. BYO orgs (twilioMode "byo") only have their org row
 * updated — we never touch a customer's own Twilio account.
 */
export async function closeOrgTelephony(orgId: string, mode: "suspend" | "close"): Promise<CloseTelephonyResult> {
  const [org] = await db
    .select({ twilioMode: orgs.twilioMode })
    .from(orgs)
    .where(eq(orgs.id, orgId))
    .limit(1);
  if (!org) return { ok: false, error: "Org not found" };

  const orgStatus = mode === "close" ? "closed" : "suspended";

  // BYO: never touch the customer's own Twilio account — just flip our
  // org row so we stop routing calls through it.
  if (org.twilioMode === "byo") {
    await db.update(orgs).set({ status: orgStatus }).where(eq(orgs.id, orgId));
    return { ok: true, releasedNumbers: 0, subaccountAction: "none" };
  }

  // Resolve creds vault-first (plaintext fallback) — never read
  // orgs.twilioAuthToken directly. Platform mode but no subaccount ever
  // provisioned (still on global default) → nothing on Twilio to tear down.
  const creds = await resolveOrgTwilioCreds(orgId);
  if (!creds) {
    await db.update(orgs).set({ status: orgStatus }).where(eq(orgs.id, orgId));
    return { ok: true, releasedNumbers: 0, subaccountAction: "none" };
  }

  const subClient = Twilio(creds.accountSid, creds.authToken);
  let releasedNumbers = 0;

  // Release every rented number first — this is what stops the monthly
  // rental. (Closing the subaccount would auto-release them too, but suspend
  // would NOT, so we always do it explicitly for consistent behavior.)
  try {
    const numbers = await subClient.incomingPhoneNumbers.list({ limit: 100 });
    for (const n of numbers) {
      await subClient.incomingPhoneNumbers(n.sid).remove();
      releasedNumbers++;
    }
  } catch (err) {
    return { ok: false, error: `Failed to release numbers: ${(err as Error).message}` };
  }

  // Mark our own org_phone_numbers rows released so the DB matches Twilio.
  await db
    .update(orgPhoneNumbers)
    .set({ status: "released" })
    .where(and(eq(orgPhoneNumbers.orgId, orgId), eq(orgPhoneNumbers.status, "active")));

  // Suspend or close the subaccount itself (via the PARENT client — a
  // subaccount can't change its own status).
  try {
    await twilioClient.api.v2010.accounts(creds.accountSid).update({ status: mode === "close" ? "closed" : "suspended" });
  } catch (err) {
    return { ok: false, error: `Numbers released but failed to ${mode} subaccount: ${(err as Error).message}` };
  }

  if (mode === "close") {
    // Terminal: clear creds so nothing tries to use the dead subaccount —
    // both the plaintext columns AND the vault entries (otherwise the
    // vault-first read path would keep resolving the dead subaccount).
    await db
      .update(orgs)
      .set({ status: "closed", twilioAccountSid: null, twilioAuthToken: null, outboundNumber: null })
      .where(eq(orgs.id, orgId));
    for (const field of TELEPHONY_VAULT_FIELDS.twilio) await deleteCredential(orgId, field);
  } else {
    await db.update(orgs).set({ status: "suspended", outboundNumber: null }).where(eq(orgs.id, orgId));
  }

  return { ok: true, releasedNumbers, subaccountAction: mode === "close" ? "closed" : "suspended" };
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

  await storeCredential(orgId, TWILIO_FIELDS.accountSid, accountSid);
  await storeCredential(orgId, TWILIO_FIELDS.authToken, authToken);

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

  // Purge every provider's vault entries too — clearing only the plaintext
  // columns would leave the vault-first read path resolving stale creds. This
  // is field-scoped to telephony, so CRM/calendar credentials are untouched.
  for (const provider of ["twilio", "plivo", "exotel"] as const) {
    for (const field of TELEPHONY_VAULT_FIELDS[provider]) await deleteCredential(orgId, field);
  }
}
