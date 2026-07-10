import Twilio from "twilio";
import { db } from "../database";
import { orgs } from "../database/schema";
import { eq } from "drizzle-orm";

/** Platform default — the parent/global Twilio account. Used directly for
 * every org that hasn't been provisioned a sub-account or set BYO
 * credentials (today's single-tenant behavior, unchanged), and as the
 * account that creates sub-accounts for others (see twilio-provisioning.ts). */
export const twilioClient = Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

type OrgTwilioCreds = { accountSid: string; authToken: string } | null;

/** Cache-free by design — org Twilio creds change rarely (a manual admin
 * action), but a stale cached client after a credential rotation would
 * silently keep using the old auth token. The extra DB round-trip per call
 * is negligible next to the call itself. */
async function lookupOrgCreds(orgId: string): Promise<OrgTwilioCreds> {
  const [org] = await db
    .select({ accountSid: orgs.twilioAccountSid, authToken: orgs.twilioAuthToken })
    .from(orgs)
    .where(eq(orgs.id, orgId))
    .limit(1);
  if (!org?.accountSid || !org?.authToken) return null;
  return { accountSid: org.accountSid, authToken: org.authToken };
}

/**
 * Resolves the right Twilio client for a call: the org's own sub-account or
 * BYO credentials when configured, otherwise the platform default. Every
 * real call-placing/call-modifying site (outbound trigger, hangup, transfer,
 * workflow retry, SMS action) should resolve through this instead of
 * importing `twilioClient` directly once an orgId is known — using the
 * wrong account's client doesn't fail loudly, it just silently bills/logs
 * the action against the wrong Twilio account.
 */
export async function getTwilioClientForOrg(orgId?: string | null) {
  if (!orgId) return twilioClient;
  const creds = await lookupOrgCreds(orgId);
  if (!creds) return twilioClient;
  return Twilio(creds.accountSid, creds.authToken);
}

/**
 * Resolves the auth token that would have signed a given org's webhooks —
 * consumed by voice/middleware/twilio-signature.ts, which needs the *token*
 * specifically (not a client instance) to validate `X-Twilio-Signature`.
 * Twilio signs every webhook with the auth token of whichever account
 * (parent or sub-account) actually placed/owns the call, so validating
 * every request against only the global token silently rejects every
 * sub-account/BYO org's webhooks.
 */
export async function getAuthTokenForOrg(orgId?: string | null): Promise<string | undefined> {
  if (!orgId) return process.env.TWILIO_AUTH_TOKEN;
  const creds = await lookupOrgCreds(orgId);
  return creds?.authToken ?? process.env.TWILIO_AUTH_TOKEN;
}

/** Public base URL Twilio can reach (https for webhooks, wss derived for streams). */
export function getPublicUrl() {
  const url = process.env.PUBLIC_APP_URL;
  if (!url) throw new Error("PUBLIC_APP_URL is not set — Twilio needs a public HTTPS/WSS URL");
  return url.replace(/\/$/, "");
}

export function getWsUrl() {
  return getPublicUrl().replace(/^https/, "wss").replace(/^http/, "ws");
}
