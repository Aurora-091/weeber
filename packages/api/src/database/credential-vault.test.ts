import { describe, it, expect, mock, beforeEach } from "bun:test";

/**
 * Audit 2026-07-19 finding #1 (second half) — CRM/calendar credentials were read/written as
 * raw `orgIntegrations.credentials` jsonb despite a working Supabase Vault already existing for
 * telephony tokens. These cover the new vault-backed integration-credential helpers: per-field
 * storage (mirrors TWILIO_FIELDS/PLIVO_FIELDS/EXOTEL_FIELDS), only-known-fields-for-provider
 * reads, and org/provider isolation.
 *
 * `db.execute` is mocked with a tiny in-memory secret store keyed the same way the real
 * `store_org_credential`/`read_org_credential` Postgres functions key vault secrets
 * (`org:{orgId}:{field}`) — reconstructed from the drizzle `sql` tagged template's
 * `queryChunks` (interleaved literal-string chunks and raw param values) rather than mocking
 * `storeCredential`/`readCredential` directly, since those live in the same module under test.
 */

type QueryChunks = Array<{ value?: string[] } | string>;

let secrets: Record<string, string> = {};

mock.module("./index", () => ({
  db: {
    execute: async (query: { queryChunks?: QueryChunks }) => {
      const chunks = query.queryChunks ?? [];
      const literal = (chunks[0] as { value?: string[] })?.value?.[0] ?? "";
      const params = chunks.filter((_, i) => i % 2 === 1) as string[];

      if (literal.includes("store_org_credential")) {
        const [orgId, field, value] = params;
        secrets[`org:${orgId}:${field}`] = value;
        return [];
      }
      if (literal.includes("read_org_credential")) {
        const [orgId, field] = params;
        return [{ value: secrets[`org:${orgId}:${field}`] ?? null }];
      }
      throw new Error(`unmocked vault query: ${literal}`);
    },
  },
}));

import {
  readOrgIntegrationCredentials,
  storeOrgIntegrationCredentials,
  INTEGRATION_CREDENTIAL_FIELDS,
} from "./credential-vault";

describe("readOrgIntegrationCredentials / storeOrgIntegrationCredentials", () => {
  beforeEach(() => {
    secrets = {};
  });

  it("round-trips every known field for a provider through the vault", async () => {
    await storeOrgIntegrationCredentials("org-a", "gohighlevel", { api_key: "key-1", location_id: "loc-1" });
    const result = await readOrgIntegrationCredentials("org-a", "gohighlevel");
    expect(result).toEqual({ api_key: "key-1", location_id: "loc-1" });
  });

  it("returns only the fields actually present — a partially-vaulted provider isn't padded with nulls", async () => {
    await storeOrgIntegrationCredentials("org-a", "salesforce", { access_token: "tok-1" });
    const result = await readOrgIntegrationCredentials("org-a", "salesforce");
    expect(result).toEqual({ access_token: "tok-1" });
    expect(result.instance_url).toBeUndefined();
  });

  it("returns {} (not throw) for a provider with no vaulted credentials at all", async () => {
    const result = await readOrgIntegrationCredentials("org-with-nothing", "hubspot");
    expect(result).toEqual({});
  });

  it("never leaks another org's credentials for the same provider", async () => {
    await storeOrgIntegrationCredentials("org-a", "hubspot", { api_key: "org-a-key" });
    await storeOrgIntegrationCredentials("org-b", "hubspot", { api_key: "org-b-key" });
    expect(await readOrgIntegrationCredentials("org-a", "hubspot")).toEqual({ api_key: "org-a-key" });
    expect(await readOrgIntegrationCredentials("org-b", "hubspot")).toEqual({ api_key: "org-b-key" });
  });

  it("never reads a different provider's field for the same org", async () => {
    await storeOrgIntegrationCredentials("org-a", "gohighlevel", { api_key: "ghl-key" });
    const hubspotResult = await readOrgIntegrationCredentials("org-a", "hubspot");
    expect(hubspotResult).toEqual({});
  });

  it("returns {} for an unknown provider instead of throwing", async () => {
    const result = await readOrgIntegrationCredentials("org-a", "some_future_provider");
    expect(result).toEqual({});
  });

  it("INTEGRATION_CREDENTIAL_FIELDS covers every provider these helpers are used for today", () => {
    expect(INTEGRATION_CREDENTIAL_FIELDS.gohighlevel).toEqual(["api_key", "location_id"]);
    expect(INTEGRATION_CREDENTIAL_FIELDS.salesforce).toEqual(["access_token", "instance_url"]);
    expect(INTEGRATION_CREDENTIAL_FIELDS.hubspot).toEqual(["api_key"]);
    expect(INTEGRATION_CREDENTIAL_FIELDS.google_calendar).toEqual(["access_token", "calendar_id"]);
  });
});
