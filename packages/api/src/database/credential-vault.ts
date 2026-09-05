import { db } from "./index";
import { sql } from "drizzle-orm";

/**
 * Stores a per-org credential in Supabase Vault (encrypted at rest via pgsodium).
 * Uses the `store_org_credential` PL/pgSQL function which handles upsert logic.
 */
export async function storeCredential(orgId: string, field: string, value: string): Promise<void> {
  await db.execute(sql`SELECT public.store_org_credential(${orgId}, ${field}, ${value})`);
}

/**
 * Reads a decrypted credential from Supabase Vault.
 * Returns null if no credential is stored for this org+field.
 */
export async function readCredential(orgId: string, field: string): Promise<string | null> {
  const result = await db.execute(
    sql`SELECT public.read_org_credential(${orgId}, ${field}) as value`,
  );
  const row = (result as unknown as Array<{ value: string | null }>)[0];
  return row?.value ?? null;
}

/**
 * Removes a SINGLE vault-stored credential field for an org. Used when a
 * telephony provider is reset/torn down: the org row's plaintext columns get
 * nulled, so the matching vault entry must be cleared too — otherwise the
 * vault-first read path (resolveOrgTwilioCreds etc.) keeps resolving the stale
 * credential after a reset. Unlike deleteOrgCredentials this is field-scoped,
 * so clearing telephony never touches CRM/calendar credentials.
 */
export async function deleteCredential(orgId: string, field: string): Promise<void> {
  await db.execute(sql`SELECT public.delete_org_credential(${orgId}, ${field})`);
}

export const TWILIO_FIELDS = {
  accountSid: "twilio_account_sid",
  authToken: "twilio_auth_token",
} as const;

export const PLIVO_FIELDS = {
  authId: "plivo_auth_id",
  authToken: "plivo_auth_token",
} as const;

export const EXOTEL_FIELDS = {
  sid: "exotel_sid",
  apiKey: "exotel_api_key",
  apiToken: "exotel_api_token",
} as const;

/**
 * Every vault field a telephony provider can occupy — used to purge the vault
 * on reset/teardown so a vault-first read never resolves a stale credential
 * after the org's plaintext columns have been cleared.
 */
export const TELEPHONY_VAULT_FIELDS = {
  twilio: [TWILIO_FIELDS.accountSid, TWILIO_FIELDS.authToken],
  plivo: [PLIVO_FIELDS.authId, PLIVO_FIELDS.authToken],
  exotel: [EXOTEL_FIELDS.sid, EXOTEL_FIELDS.apiKey, EXOTEL_FIELDS.apiToken],
} as const;

/**
 * Which credential fields each `orgIntegrations` provider actually uses (audit
 * 2026-07-19 finding #1, second half — "CRM/calendar creds in
 * `integrations.credentials` jsonb not vaulted"). Mirrors the field-per-secret
 * pattern above (TWILIO_FIELDS/PLIVO_FIELDS/EXOTEL_FIELDS) instead of vaulting
 * the whole jsonb blob as one opaque string, so a single field can be rotated
 * without touching the others and `read_org_credential`'s existing per-field
 * shape needs no changes.
 */
export const INTEGRATION_CREDENTIAL_FIELDS: Record<string, readonly string[]> = {
  gohighlevel: ["api_key", "location_id"],
  salesforce: ["access_token", "instance_url"],
  hubspot: ["api_key"],
  google_calendar: ["access_token", "calendar_id"],
};

/**
 * Vault-backed replacement for reading `orgIntegrations.credentials` raw. Reads
 * every known field for this provider from the vault and returns only the ones
 * that resolved to a value (so callers can `if (!creds.access_token)` exactly
 * like they did against the old raw jsonb). Returns `{}` (not null) when the
 * org has no vaulted credentials for this provider yet — callers should fall
 * back to the legacy plaintext `orgIntegrations.credentials` column during the
 * transition, the same pattern `twilio-provisioning.ts` already uses.
 */
export async function readOrgIntegrationCredentials(
  orgId: string,
  provider: string,
): Promise<Record<string, string>> {
  const fields = INTEGRATION_CREDENTIAL_FIELDS[provider] ?? [];
  const out: Record<string, string> = {};
  for (const field of fields) {
    const value = await readCredential(orgId, `integration_${provider}_${field}`);
    if (value != null) out[field] = value;
  }
  return out;
}

/**
 * Vault-backed replacement for writing `orgIntegrations.credentials` raw. No
 * live call site writes plaintext integration credentials today (audit found
 * none), but this exists so the next connector UI/OAuth callback that
 * provisions a CRM/calendar integration has a vault-first path to write
 * through from day one instead of introducing a new plaintext write.
 */
export async function storeOrgIntegrationCredentials(
  orgId: string,
  provider: string,
  credentials: Record<string, string>,
): Promise<void> {
  for (const [field, value] of Object.entries(credentials)) {
    await storeCredential(orgId, `integration_${provider}_${field}`, value);
  }
}
