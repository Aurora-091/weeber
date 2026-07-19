import { mock, describe, it, expect, beforeEach } from "bun:test";

/**
 * On-demand CRM mirror — pushes one native lead to the org's connected CRM.
 * Everything external (lead read, CRM-credential resolution, the three
 * adapters) is mocked so we assert the mirror's decision logic: 404/400/502
 * mapping, provider dispatch, and that the note is built only from stored
 * (clean) fields.
 */
process.env.DATABASE_URL ??= "file:./.test-crm-mirror.db";

type LeadRecord = { lead: Record<string, unknown>; calls: unknown[] } | null;
let leadRecord: LeadRecord = null;
let crmCreds: { provider: string; credentials: Record<string, string> } | null = null;
let adapterResult: { synced: boolean; message?: string; contactId?: string | null } = { synced: true, contactId: "c1" };
const adapterCalls: Array<{ provider: string; phone: string; name?: string; notes: string }> = [];

mock.module("./leads", () => ({
  getOrgLead: async () => leadRecord,
}));

mock.module("../integrations/resolve-crm", () => ({
  getOrgCrmCredentials: async () => crmCreds,
}));

mock.module("../integrations/hubspot", () => ({
  syncToHubspot: async (phone: string, name: string | undefined, notes: string) => {
    adapterCalls.push({ provider: "hubspot", phone, name, notes });
    return adapterResult;
  },
}));
mock.module("../integrations/salesforce", () => ({
  syncToSalesforce: async (phone: string, name: string | undefined, notes: string) => {
    adapterCalls.push({ provider: "salesforce", phone, name, notes });
    return adapterResult;
  },
}));
mock.module("../integrations/gohighlevel", () => ({
  syncToGoHighLevel: async (phone: string, name: string | undefined, notes: string) => {
    adapterCalls.push({ provider: "gohighlevel", phone, name, notes });
    return adapterResult;
  },
}));

const { mirrorLeadToCrm } = await import("./crm-mirror");

beforeEach(() => {
  leadRecord = {
    lead: {
      id: 1,
      phone: "+15551234567",
      name: "Jane",
      status: "new",
      source: "call",
      fields: { coverage_type: "Auto", lead_notes: "wants a quote" },
    },
    calls: [{ id: 9 }],
  };
  crmCreds = { provider: "hubspot", credentials: { api_key: "k" } };
  adapterResult = { synced: true, contactId: "c1" };
  adapterCalls.length = 0;
});

describe("mirrorLeadToCrm", () => {
  it("404s when the lead does not exist for the org", async () => {
    leadRecord = null;
    const res = await mirrorLeadToCrm("org_1", 1);
    expect(res.ok).toBe(false);
    expect(res.statusCode).toBe(404);
  });

  it("400s when no CRM is connected", async () => {
    crmCreds = null;
    const res = await mirrorLeadToCrm("org_1", 1);
    expect(res.ok).toBe(false);
    expect(res.statusCode).toBe(400);
    expect(adapterCalls.length).toBe(0);
  });

  it("400s when the lead has no phone", async () => {
    leadRecord!.lead.phone = "";
    const res = await mirrorLeadToCrm("org_1", 1);
    expect(res.ok).toBe(false);
    expect(res.statusCode).toBe(400);
  });

  it("dispatches to the connected provider and builds a note from stored fields", async () => {
    const res = await mirrorLeadToCrm("org_1", 1);
    expect(res.ok).toBe(true);
    expect(res.crm).toBe("hubspot");
    expect(adapterCalls).toHaveLength(1);
    const call = adapterCalls[0];
    expect(call.provider).toBe("hubspot");
    expect(call.phone).toBe("+15551234567");
    expect(call.name).toBe("Jane");
    // Note carries status/source + the clean field values.
    expect(call.notes).toContain("Auto");
    expect(call.notes).toContain("wants a quote");
    expect(call.notes.toLowerCase()).toContain("status");
  });

  it("routes to salesforce when that is the connected provider", async () => {
    crmCreds = { provider: "salesforce", credentials: { access_token: "t", instance_url: "u" } };
    const res = await mirrorLeadToCrm("org_1", 1);
    expect(res.ok).toBe(true);
    expect(adapterCalls[0].provider).toBe("salesforce");
  });

  it("502s when the adapter reports the sync failed", async () => {
    adapterResult = { synced: false, message: "rate limited" };
    const res = await mirrorLeadToCrm("org_1", 1);
    expect(res.ok).toBe(false);
    expect(res.statusCode).toBe(502);
    expect(res.message).toBe("rate limited");
  });
});
