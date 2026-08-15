import { mock, describe, it, expect, beforeEach } from "bun:test";

/**
 * Public hosted intake form (GET/POST /public/leads/:orgId/form). The org's
 * UUID is the public form token. We mock the org lookup, schema resolver, and
 * upsert so this exercises the router's public-surface behavior: 404 on an
 * unknown org, honeypot silent-drop, required-phone validation, and a clean
 * form-sourced upsert. intake-schema (validateFields) stays REAL.
 */
process.env.DATABASE_URL ??= "file:./.test-hosted-form.db";

import { defaultIntakeSchema } from "../voice/leads/intake-schema";

let org: { id: string; name: string | null; vertical: string | null; countryCode?: string | null } | null = {
  id: "org_1",
  name: "Acme Insurance",
  vertical: "insurance",
  countryCode: "+1",
};
const upsertCalls: Array<Record<string, unknown>> = [];

mock.module("../voice/org-queries", () => ({
  getOrg: async () => org,
}));
mock.module("../voice/leads/schema-store", () => ({
  resolveIntakeSchema: async (_orgId: string, vertical: string | null | undefined) => defaultIntakeSchema(vertical),
}));
mock.module("../voice/leads/leads", () => ({
  upsertLead: async (input: Record<string, unknown>) => {
    upsertCalls.push(input);
    return { id: 7, created: true };
  },
}));

const { publicRoutes } = await import("./public-routes");

function get(orgId: string) {
  return publicRoutes.request(`/leads/${orgId}/form`);
}
function post(orgId: string, body: unknown, headers: Record<string, string> = {}) {
  return publicRoutes.request(`/leads/${orgId}/form`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": `1.2.3.${Math.random()}`, ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  org = { id: "org_1", name: "Acme Insurance", vertical: "insurance", countryCode: "+1" };
  upsertCalls.length = 0;
});

describe("GET /leads/:orgId/form", () => {
  it("returns the org name + field schema for a known org", async () => {
    const res = await get("org_1");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { orgName: string; fields: unknown[] };
    expect(json.orgName).toBe("Acme Insurance");
    expect(Array.isArray(json.fields)).toBe(true);
    expect(json.fields.length).toBeGreaterThan(0);
  });

  it("404s for an unknown org (invalid form token)", async () => {
    org = null;
    const res = await get("nope");
    expect(res.status).toBe(404);
  });
});

describe("POST /leads/:orgId/form", () => {
  it("creates a form-sourced lead on a valid submit", async () => {
    const res = await post("org_1", { phone: "+15551234567", name: "Jane" });
    expect([200, 201]).toContain(res.status);
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0].source).toBe("form");
    expect(upsertCalls[0].phone).toBe("+15551234567");
  });

  it("silently drops a honeypot-filled submission (no upsert) but looks successful", async () => {
    const res = await post("org_1", { phone: "+15551234567", _website: "http://spam.example" });
    expect(res.status).toBe(201);
    expect(upsertCalls).toHaveLength(0);
  });

  it("400s when phone is missing", async () => {
    const res = await post("org_1", { name: "No Phone" });
    expect(res.status).toBe(400);
    expect(upsertCalls).toHaveLength(0);
  });

  it("404s for an unknown org", async () => {
    org = null;
    const res = await post("nope", { phone: "+15551234567" });
    expect(res.status).toBe(404);
  });

  it("rate-limits a flood from the same IP+org", async () => {
    const ip = "9.9.9.9";
    let limited = false;
    for (let i = 0; i < 14; i++) {
      const res = await post("org_1", { phone: "+15551234567" }, { "x-forwarded-for": ip });
      if (res.status === 429) limited = true;
    }
    expect(limited).toBe(true);
  });
});

describe("POST /leads/:orgId/form — phone normalization (pilot latency audit F1)", () => {
  // A human filling a public form is the likeliest source of a bare national
  // number. Before this fix it was stored verbatim, so it could never match
  // `getLeadGreetingContext`'s exact E.164 lookup at call time.

  it("normalizes a bare national number using the org's country code", async () => {
    const res = await post("org_1", { phone: "(555) 123-4567", name: "Jane" });
    expect([200, 201]).toContain(res.status);
    expect(upsertCalls[0]!.phone).toBe("+15551234567");
  });

  it("400s on an unparseable phone rather than storing it verbatim", async () => {
    const res = await post("org_1", { phone: "abc" });
    expect(res.status).toBe(400);
    expect(upsertCalls).toHaveLength(0);
  });
});
