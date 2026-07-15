import { describe, it, expect, mock, beforeEach } from "bun:test";

/**
 * §P0 fix (audit #06): crmSync used to read a single global env var
 * (GOHIGHLEVEL_API_KEY etc.), shared across every org on the platform — a
 * real cross-tenant data-leak risk the moment more than one paying org had
 * it enabled. It's now a factory (createCrmSyncTool(orgId)) that looks up
 * per-org credentials from org_integrations, with no env-var fallback left
 * anywhere in the underlying integration modules. These tests cover the
 * org-scoping/not-configured branching that fix depends on — untested
 * until now.
 */

let orgIntegrationRows: Array<{ provider: string; credentials: Record<string, string>; enabled: boolean }> = [];
let lastGoHighLevelArgs: unknown[] | null = null;
let lastSalesforceArgs: unknown[] | null = null;
let lastHubspotArgs: unknown[] | null = null;

// getOrgCrmCredentials queries once per provider, in this fixed order,
// short-circuiting on the first match — mirrored here so the mock can
// return only the row that provider's real WHERE clause would have
// matched, instead of blindly returning every configured row regardless
// of which provider is actually being queried this call.
const PROVIDER_QUERY_ORDER = ["gohighlevel", "salesforce", "hubspot"];
let queryCallIndex = 0;

mock.module("../../database", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => {
            const provider = PROVIDER_QUERY_ORDER[queryCallIndex % PROVIDER_QUERY_ORDER.length];
            queryCallIndex += 1;
            return orgIntegrationRows.filter((r) => r.provider === provider && r.enabled);
          },
        }),
      }),
    }),
  },
}));

mock.module("../integrations/gohighlevel", () => ({
  syncToGoHighLevel: async (...args: unknown[]) => {
    lastGoHighLevelArgs = args;
    return { synced: true, contactId: "ghl-1" };
  },
}));
mock.module("../integrations/salesforce", () => ({
  syncToSalesforce: async (...args: unknown[]) => {
    lastSalesforceArgs = args;
    return { synced: true, contactId: "sf-1" };
  },
}));
mock.module("../integrations/hubspot", () => ({
  syncToHubspot: async (...args: unknown[]) => {
    lastHubspotArgs = args;
    return { synced: true, contactId: "hs-1" };
  },
}));

import { createCrmSyncTool } from "./crmSync";

function callTool(orgId: string | undefined) {
  const tool = createCrmSyncTool(orgId);
  return (tool.execute as (input: unknown) => Promise<unknown>)({
    callerName: "Jamie",
    phoneNumber: "+15551234567",
    notes: "asked about pricing",
  });
}

describe("createCrmSyncTool — §P0 multi-tenant CRM isolation", () => {
  beforeEach(() => {
    orgIntegrationRows = [];
    lastGoHighLevelArgs = null;
    lastSalesforceArgs = null;
    lastHubspotArgs = null;
    queryCallIndex = 0;
  });

  it("refuses immediately when no orgId is captured — never falls back to a global/shared credential", async () => {
    const result = (await callTool(undefined)) as { crm: null; synced: false; message: string };
    expect(result.synced).toBe(false);
    expect(result.crm).toBeNull();
    expect(result.message).toContain("No org context");
    // Confirms it short-circuits before ever querying org_integrations —
    // not just that it happens to return the same "not configured" shape.
    expect(lastGoHighLevelArgs).toBeNull();
    expect(lastSalesforceArgs).toBeNull();
    expect(lastHubspotArgs).toBeNull();
  });

  it("returns a clear not-configured result when the org has no CRM connected", async () => {
    orgIntegrationRows = [];
    const result = (await callTool("org-a")) as { crm: null; synced: false; message: string };
    expect(result.synced).toBe(false);
    expect(result.message).toContain("No CRM connected for this organization");
  });

  it("uses this org's own stored GoHighLevel credentials, not any other org's or a shared one", async () => {
    orgIntegrationRows = [{ provider: "gohighlevel", credentials: { api_key: "org-a-key", location_id: "org-a-loc" }, enabled: true }];
    const result = (await callTool("org-a")) as { crm: string; synced: true; contactId: string };
    expect(result).toEqual({ crm: "gohighlevel", synced: true, contactId: "ghl-1" });
    expect(lastGoHighLevelArgs).toEqual(["+15551234567", "Jamie", "asked about pricing", "org-a-key", "org-a-loc"]);
  });

  it("routes to Salesforce with this org's own access token + instance URL when that's the connected provider", async () => {
    orgIntegrationRows = [{ provider: "salesforce", credentials: { access_token: "org-b-token", instance_url: "https://org-b.my.salesforce.com" }, enabled: true }];
    const result = (await callTool("org-b")) as { crm: string; synced: true; contactId: string };
    expect(result).toEqual({ crm: "salesforce", synced: true, contactId: "sf-1" });
    expect(lastSalesforceArgs).toEqual([
      "+15551234567",
      "Jamie",
      "asked about pricing",
      "org-b-token",
      "https://org-b.my.salesforce.com",
    ]);
  });

  it("routes to HubSpot with this org's own API key when that's the connected provider", async () => {
    orgIntegrationRows = [{ provider: "hubspot", credentials: { api_key: "org-c-key" }, enabled: true }];
    const result = (await callTool("org-c")) as { crm: string; synced: true; contactId: string };
    expect(result).toEqual({ crm: "hubspot", synced: true, contactId: "hs-1" });
    expect(lastHubspotArgs).toEqual(["+15551234567", "Jamie", "asked about pricing", "org-c-key"]);
  });
});
