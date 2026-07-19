import { describe, it, expect, mock, beforeEach } from "bun:test";

/**
 * Audit 2026-07-19 finding #1 (second half) — getOrgCrmCredentials used to return
 * `row.credentials` (raw plaintext jsonb) directly. Now vault-first with the plaintext row as a
 * fallback for pre-vault rows, same transition pattern telephony already uses. This was
 * previously untested directly (only exercised indirectly through crm-mirror.test.ts, which
 * mocks this whole module away).
 */

let orgIntegrationRows: Array<{ provider: string; credentials: Record<string, string>; enabled: boolean }> = [];
let vaultedByProvider: Record<string, Record<string, string>> = {};

// getOrgCrmCredentials queries providers in its own fixed priority order
// (gohighlevel -> salesforce -> hubspot), one `.where().limit()` call per provider per
// iteration — mirror that order here instead of parsing the drizzle `and(...)` condition object
// (which contains circular refs and isn't meant to be introspected in a unit test).
const PROVIDER_QUERY_ORDER = ["gohighlevel", "salesforce", "hubspot"];
let queryCallIndex = 0;

mock.module("../../database", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => {
          const provider = PROVIDER_QUERY_ORDER[queryCallIndex % PROVIDER_QUERY_ORDER.length];
          queryCallIndex++;
          const match = orgIntegrationRows.find((r) => r.provider === provider && r.enabled);
          return { limit: () => (match ? [match] : []) };
        },
      }),
    }),
  },
}));

mock.module("../../database/credential-vault", () => ({
  readOrgIntegrationCredentials: async (_orgId: string, provider: string) => vaultedByProvider[provider] ?? {},
}));

import { getOrgCrmCredentials } from "./resolve-crm";

describe("getOrgCrmCredentials", () => {
  beforeEach(() => {
    orgIntegrationRows = [];
    vaultedByProvider = {};
    queryCallIndex = 0;
  });

  it("returns null when no CRM provider is connected/enabled", async () => {
    const result = await getOrgCrmCredentials("org-a");
    expect(result).toBeNull();
  });

  it("prefers vaulted credentials over the legacy plaintext row when both exist", async () => {
    orgIntegrationRows = [{ provider: "hubspot", credentials: { api_key: "legacy-key" }, enabled: true }];
    vaultedByProvider.hubspot = { api_key: "vaulted-key" };
    const result = await getOrgCrmCredentials("org-a");
    expect(result).toEqual({ provider: "hubspot", credentials: { api_key: "vaulted-key" } });
  });

  it("falls back to the legacy plaintext row when the vault has nothing for this provider yet", async () => {
    orgIntegrationRows = [{ provider: "hubspot", credentials: { api_key: "legacy-key" }, enabled: true }];
    const result = await getOrgCrmCredentials("org-a");
    expect(result).toEqual({ provider: "hubspot", credentials: { api_key: "legacy-key" } });
  });

  it("respects the fixed provider priority order (gohighlevel -> salesforce -> hubspot)", async () => {
    orgIntegrationRows = [
      { provider: "hubspot", credentials: { api_key: "hs-key" }, enabled: true },
      { provider: "gohighlevel", credentials: { api_key: "ghl-key", location_id: "loc-1" }, enabled: true },
    ];
    const result = await getOrgCrmCredentials("org-a");
    expect(result?.provider).toBe("gohighlevel");
  });

  it("never returns a disabled provider's credentials", async () => {
    orgIntegrationRows = [{ provider: "hubspot", credentials: { api_key: "hs-key" }, enabled: false }];
    const result = await getOrgCrmCredentials("org-a");
    expect(result).toBeNull();
  });
});
