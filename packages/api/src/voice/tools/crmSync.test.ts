import { describe, it, expect, mock, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
// A4: every guardrail_events row this test's mocked db saw inserted.
let guardrailInserts: Record<string, unknown>[] = [];

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
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        guardrailInserts.push(values);
        return Promise.resolve();
      },
    }),
  },
}));

// Vault-first read (audit 2026-07-19 finding #1) — defaults to empty so these existing tests
// exercise the legacy plaintext `orgIntegrations.credentials` fallback path unchanged.
mock.module("../../database/credential-vault", () => ({
  readOrgIntegrationCredentials: async () => ({}) as Record<string, string>,
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

import { createCrmSyncTool, resolveCrmSyncContext, resolveLiveCrmSyncContext } from "./crmSync";

function callTool(orgId: string, phoneNumber = "+15551234567", callId = 1) {
  const tool = createCrmSyncTool({ orgId, phoneNumber, callId });
  return (tool.execute as (input: unknown) => Promise<unknown>)({
    callerName: "Jamie",
    notes: "asked about pricing",
  });
}

/** insert() is fire-and-forget (`void db.insert(...).catch(...)`) — give its
 * microtask a tick to land before asserting on it. */
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("createCrmSyncTool — §P0 multi-tenant CRM isolation", () => {
  beforeEach(() => {
    orgIntegrationRows = [];
    lastGoHighLevelArgs = null;
    lastSalesforceArgs = null;
    lastHubspotArgs = null;
    guardrailInserts = [];
    queryCallIndex = 0;
  });

  it("returns a clear not-configured result when the org has no CRM connected", async () => {
    orgIntegrationRows = [];
    const result = (await callTool("org-a")) as { crm: null; synced: false; message: string };
    expect(result.synced).toBe(false);
    expect(result.message).toContain("No CRM connected for this organization");
  });

  it("A4: the not-configured path also produces a durable, queryable undelivered-outcome row", async () => {
    // Two production calls both returned {"synced":false} and nothing
    // downstream ever noticed — this is the fix: the failure is now a row a
    // query can find, not just a live-transcript detail.
    orgIntegrationRows = [];
    await callTool("org-a", "+15551234567", 42);
    await flush();

    expect(guardrailInserts).toHaveLength(1);
    expect(guardrailInserts[0]).toMatchObject({
      callId: 42,
      orgId: "org-a",
      category: "undelivered-outcome",
      source: "crm-sync",
    });
    expect(String(guardrailInserts[0].detail)).toContain("No CRM connected");
  });

  it("A4: a real provider failure (synced: false from the adapter) also produces the durable row", async () => {
    orgIntegrationRows = [{ provider: "gohighlevel", credentials: { api_key: "k", location_id: "l" }, enabled: true }];
    mock.module("../integrations/gohighlevel", () => ({
      syncToGoHighLevel: async () => ({ synced: false, message: "GoHighLevel API returned 401" }),
    }));

    await callTool("org-a");
    await flush();

    expect(guardrailInserts).toHaveLength(1);
    expect(guardrailInserts[0].category).toBe("undelivered-outcome");
    expect(String(guardrailInserts[0].detail)).toContain("401");

    // Restore the default success mock so later tests in this file aren't affected.
    mock.module("../integrations/gohighlevel", () => ({
      syncToGoHighLevel: async (...args: unknown[]) => {
        lastGoHighLevelArgs = args;
        return { synced: true, contactId: "ghl-1" };
      },
    }));
  });

  it("A4: a successful sync produces no undelivered-outcome row", async () => {
    orgIntegrationRows = [{ provider: "gohighlevel", credentials: { api_key: "k", location_id: "l" }, enabled: true }];
    await callTool("org-a");
    await flush();
    expect(guardrailInserts).toHaveLength(0);
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

/**
 * G1.4 / ADR-069 (2026-08-01) — the caller's phone number is the CRM *upsert
 * key*, so whoever authors it decides which contact record this call's notes
 * land on. It used to be a required, model-authored input. These tests pin the
 * two halves of the fix: the model can no longer name the contact, and the
 * context that binds it refuses anything that isn't a real, carrier-reported
 * number rather than upserting on a placeholder.
 */
describe("createCrmSyncTool — the model cannot choose whose CRM record this writes to (ADR-069)", () => {
  beforeEach(() => {
    orgIntegrationRows = [{ provider: "gohighlevel", credentials: { api_key: "k", location_id: "l" }, enabled: true }];
    lastGoHighLevelArgs = null;
    queryCallIndex = 0;
  });

  it("does not expose phoneNumber as a model-supplied input at all", () => {
    const tool = createCrmSyncTool({ orgId: "org-a", phoneNumber: "+15551234567", callId: 1 });
    // The JSON Schema the model actually sees. If `phoneNumber` reappears here,
    // the upsert key is model-authored again and this whole ADR is undone.
    const schema = tool.inputSchema as { shape?: Record<string, unknown> };
    const fields = Object.keys(schema.shape ?? {});
    expect(fields.sort()).toEqual(["callerName", "notes"]);
    expect(fields).not.toContain("phoneNumber");
  });

  it("upserts on the bound number, ignoring anything extra the model tries to pass", async () => {
    const tool = createCrmSyncTool({ orgId: "org-a", phoneNumber: "+15551234567", callId: 1 });
    await (tool.execute as (input: unknown) => Promise<unknown>)({
      callerName: "Jamie",
      notes: "asked about pricing",
      // A model that has seen the old schema (or is being steered by a caller
      // saying "log this under …") may still emit this field. It must have no
      // effect whatsoever.
      phoneNumber: "+919999999999",
    });
    expect((lastGoHighLevelArgs ?? [])[0]).toBe("+15551234567");
  });
});

describe("resolveCrmSyncContext — non-registration is the gate (ADR-069)", () => {
  it("binds the carrier-reported number when org, number, and callId are all present", () => {
    expect(resolveCrmSyncContext({ orgId: "org-a", humanNumber: "+15551234567", callId: 1 })).toEqual({
      orgId: "org-a",
      phoneNumber: "+15551234567",
      callId: 1,
    });
  });

  it("returns undefined with no org — an unattributed call must not reach any CRM", () => {
    expect(resolveCrmSyncContext({ orgId: undefined, humanNumber: "+15551234567", callId: 1 })).toBeUndefined();
    expect(resolveCrmSyncContext({ orgId: "   ", humanNumber: "+15551234567", callId: 1 })).toBeUndefined();
  });

  it("returns undefined when caller ID was withheld — the tool is omitted, not called with a guess", () => {
    expect(resolveCrmSyncContext({ orgId: "org-a", humanNumber: undefined, callId: 1 })).toBeUndefined();
    expect(resolveCrmSyncContext({ orgId: "org-a", humanNumber: "", callId: 1 })).toBeUndefined();
  });

  it("rejects placeholder values a provider may send instead of a number", () => {
    for (const placeholder of ["unknown", "anonymous", "Anonymous", "restricted", "+"]) {
      expect(resolveCrmSyncContext({ orgId: "org-a", humanNumber: placeholder, callId: 1 })).toBeUndefined();
    }
  });

  it("accepts formatted numbers the providers actually emit", () => {
    expect(resolveCrmSyncContext({ orgId: "org-a", humanNumber: "+91 98765 43210", callId: 1 })?.phoneNumber).toBe(
      "+91 98765 43210",
    );
    expect(resolveCrmSyncContext({ orgId: "org-a", humanNumber: "(555) 123-4567", callId: 1 })?.phoneNumber).toBe(
      "(555) 123-4567",
    );
  });

  it("A4: returns undefined with no callId — nowhere to attach an undelivered-sync guardrail row", () => {
    expect(resolveCrmSyncContext({ orgId: "org-a", humanNumber: "+15551234567" })).toBeUndefined();
    expect(resolveCrmSyncContext({ orgId: "org-a", humanNumber: "+15551234567", callId: null })).toBeUndefined();
    expect(resolveCrmSyncContext({ orgId: "org-a", humanNumber: "+15551234567", callId: 0 })).toBeUndefined();
  });
});

describe("resolveLiveCrmSyncContext — withhold when no CRM is connected (ADR-122)", () => {
  beforeEach(() => {
    orgIntegrationRows = [];
    queryCallIndex = 0;
  });

  it("returns undefined when the org has no CRM credentials — the tool must not be registered", async () => {
    orgIntegrationRows = [];
    expect(
      await resolveLiveCrmSyncContext({ orgId: "org-a", humanNumber: "+15551234567", callId: 1 }),
    ).toBeUndefined();
  });

  it("returns the bound context when a CRM is connected", async () => {
    orgIntegrationRows = [{ provider: "hubspot", credentials: { api_key: "k" }, enabled: true }];
    expect(await resolveLiveCrmSyncContext({ orgId: "org-a", humanNumber: "+15551234567", callId: 1 })).toEqual({
      orgId: "org-a",
      phoneNumber: "+15551234567",
      callId: 1,
    });
  });

  it("still returns undefined when the number itself is unusable, even if a CRM is connected", async () => {
    orgIntegrationRows = [{ provider: "hubspot", credentials: { api_key: "k" }, enabled: true }];
    expect(await resolveLiveCrmSyncContext({ orgId: "org-a", humanNumber: "anonymous", callId: 1 })).toBeUndefined();
  });
});

describe("stream.ts registers crmSync only through resolveLiveCrmSyncContext (ADR-122)", () => {
  const streamSource = readFileSync(join(import.meta.dir, "../stream.ts"), "utf8");

  it("the start handler awaits the credential-aware resolver in the pickup batch", () => {
    expect(streamSource).toContain("resolveLiveCrmSyncContext({");
    expect(streamSource).not.toContain("crmSyncContext = resolveCrmSyncContext(");
  });
});
