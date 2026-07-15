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
 * Removes all vault-stored credentials for an org (used on org deletion).
 */
export async function deleteOrgCredentials(orgId: string): Promise<void> {
  await db.execute(sql`SELECT public.delete_org_credentials(${orgId})`);
}

/**
 * Reads multiple credential fields for an org in a single round-trip.
 * Returns a record of field -> value (null if not found).
 */
export async function readCredentials(
  orgId: string,
  fields: string[],
): Promise<Record<string, string | null>> {
  const result: Record<string, string | null> = {};
  for (const field of fields) {
    result[field] = await readCredential(orgId, field);
  }
  return result;
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

export const CRM_PROVIDERS = ["gohighlevel", "salesforce", "hubspot"] as const;
export const CALENDAR_PROVIDERS = ["google_calendar"] as const;
