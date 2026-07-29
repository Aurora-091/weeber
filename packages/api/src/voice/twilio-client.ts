import Twilio from "twilio";
import { db } from "../database";
import { orgs } from "../database/schema";
import { eq } from "drizzle-orm";
import { readCredential, TWILIO_FIELDS } from "../database/credential-vault";

/** Platform default — the parent/global Twilio account. */
export const twilioClient = Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

type OrgTwilioCreds = { accountSid: string; authToken: string } | null;

/**
 * Reads org Twilio credentials — Vault first (encrypted), plaintext column fallback
 * during the migration transition period. Exported so the provisioning/teardown
 * paths (twilio-provisioning.ts) resolve creds through this ONE vault-first
 * helper instead of reading the plaintext `orgs.twilioAuthToken` column directly
 * (audit 2026-07-29 finding #2 — the last two plaintext reads).
 */
export async function resolveOrgTwilioCreds(orgId: string): Promise<OrgTwilioCreds> {
  const vaultSid = await readCredential(orgId, TWILIO_FIELDS.accountSid);
  const vaultToken = await readCredential(orgId, TWILIO_FIELDS.authToken);

  if (vaultSid && vaultToken) {
    return { accountSid: vaultSid, authToken: vaultToken };
  }

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
 * BYO credentials when configured, otherwise the platform default.
 */
export async function getTwilioClientForOrg(orgId?: string | null) {
  if (!orgId) return twilioClient;
  const creds = await resolveOrgTwilioCreds(orgId);
  if (!creds) return twilioClient;
  return Twilio(creds.accountSid, creds.authToken);
}

/**
 * Resolves the auth token for webhook signature validation.
 * Twilio signs webhooks with the token of the account that placed/owns the call.
 */
export async function getAuthTokenForOrg(orgId?: string | null): Promise<string | undefined> {
  if (!orgId) return process.env.TWILIO_AUTH_TOKEN;
  const creds = await resolveOrgTwilioCreds(orgId);
  return creds?.authToken ?? process.env.TWILIO_AUTH_TOKEN;
}

/** Public base URL Twilio can reach. */
export function getPublicUrl() {
  const url = process.env.PUBLIC_APP_URL;
  if (!url) throw new Error("PUBLIC_APP_URL is not set — Twilio needs a public HTTPS/WSS URL");
  return url.replace(/\/$/, "");
}

export function getWsUrl() {
  return getPublicUrl().replace(/^https/, "wss").replace(/^http/, "ws");
}
