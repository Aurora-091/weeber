import { mock, describe, it, expect, beforeEach } from "bun:test";

/**
 * POST /api/leads/ingest — the one inbound contract every external source
 * calls. Auth (per-org key), regulated-field rejection, source-tagging, and
 * idempotent upsert are the invariants under test. The DB and key/upsert
 * modules are mocked so this exercises the router's HTTP behavior with no
 * external dependency (the whole point of the v1 ingest design). intake-schema
 * is left REAL — the compliance validation must run for real here.
 */

process.env.DATABASE_URL ??= "file:./.test-lead-ingest.db";

import { defaultIntakeSchema } from "./intake-schema";

// Resolve-key behavior is swapped per test.
let resolveResult: { id: number; orgId: string } | null = { id: 1, orgId: "org_1" };
// Records every upsertLead call so we can assert source-tagging + dedup shape.
const upsertCalls: Array<Record<string, unknown>> = [];
let upsertReturn: { id: number; created: boolean } = { id: 42, created: true };

mock.module("./api-keys", () => ({
  resolveLeadApiKey: async () => resolveResult,
}));

mock.module("../org-queries", () => ({
  getOrg: async () => ({ id: "org_1", vertical: "insurance", countryCode: "+1" }),
}));

mock.module("./leads", () => ({
  upsertLead: async (input: Record<string, unknown>) => {
    upsertCalls.push(input);
    return upsertReturn;
  },
}));

// resolveIntakeSchema hits the DB (per-org override lookup); the ingest router
// only cares that it gets the effective schema, so resolve to the real vertical
// default. intake-schema stays REAL so the compliance validation still runs.
mock.module("./schema-store", () => ({
  resolveIntakeSchema: async (_orgId: string, vertical: string | null | undefined) =>
    defaultIntakeSchema(vertical),
}));

const { leadsIngest } = await import("./ingest");

function post(body: unknown, headers: Record<string, string> = {}) {
  return leadsIngest.request("/ingest", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

// The ingest response shape (only the fields the tests assert on).
type IngestJson = {
  ok?: boolean;
  leadId?: number;
  created?: boolean;
  externalId?: string;
  rejectedRegulated?: string[];
  droppedUnknown?: string[];
  note?: string;
  error?: string;
};

beforeEach(() => {
  resolveResult = { id: 1, orgId: "org_1" };
  upsertReturn = { id: 42, created: true };
  upsertCalls.length = 0;
});

describe("POST /ingest — auth", () => {
  it("401s when no API key is sent", async () => {
    const res = await post({ phone: "+15551234567" });
    expect(res.status).toBe(401);
    expect(upsertCalls).toHaveLength(0);
  });

  it("401s when the key is invalid or revoked (resolve returns null)", async () => {
    resolveResult = null;
    const res = await post({ phone: "+15551234567" }, { Authorization: "Bearer wlk_bad" });
    expect(res.status).toBe(401);
    expect(upsertCalls).toHaveLength(0);
  });

  it("accepts the key via X-Api-Key as well as Bearer", async () => {
    const res = await post({ phone: "+15551234567" }, { "X-Api-Key": "wlk_good" });
    expect(res.status).toBe(201);
  });
});

describe("POST /ingest — validation", () => {
  it("400s when phone is missing", async () => {
    const res = await post({ name: "Asha" }, { Authorization: "Bearer wlk_good" });
    expect(res.status).toBe(400);
    expect(upsertCalls).toHaveLength(0);
  });

  it("scopes the write to the key's org, never the payload", async () => {
    await post(
      { phone: "+15551234567", orgId: "org_ATTACKER" },
      { Authorization: "Bearer wlk_good" },
    );
    expect(upsertCalls[0]!.orgId).toBe("org_1");
  });

  it("rejects regulated fields and surfaces only the offending keys (not values)", async () => {
    const secret = "ABCDE1234F";
    const res = await post(
      { phone: "+15551234567", fields: { full_name: "Asha", pan: secret } },
      { Authorization: "Bearer wlk_good" },
    );
    const json = (await res.json()) as IngestJson;
    expect(json.rejectedRegulated).toContain("pan");
    // The stored fields must not contain the regulated value.
    expect(JSON.stringify(upsertCalls[0]!.fields)).not.toContain(secret);
    // The whole response must never echo the secret value.
    expect(JSON.stringify(json)).not.toContain(secret);
  });
});

describe("POST /ingest — phone normalization (pilot latency audit F1)", () => {
  // Regression coverage for the bug behind "literal greeting rejected 11/11
  // times": this endpoint used to store `phone.trim()` verbatim, so a
  // non-E.164 lead could never match `getLeadGreetingContext`'s exact-string
  // lookup against the telephony provider's E.164 caller ID at call time.

  it("normalizes a bare national number using the org's country code before storing", async () => {
    const res = await post({ phone: "(555) 123-4567" }, { Authorization: "Bearer wlk_good" });
    expect(res.status).toBe(201);
    expect(upsertCalls[0]!.phone).toBe("+15551234567");
  });

  it("stores an already-E.164 number unchanged", async () => {
    await post({ phone: "+15551234567" }, { Authorization: "Bearer wlk_good" });
    expect(upsertCalls[0]!.phone).toBe("+15551234567");
  });

  it("400s on an unparseable phone rather than storing it verbatim", async () => {
    const res = await post({ phone: "not-a-phone-number" }, { Authorization: "Bearer wlk_good" });
    expect(res.status).toBe(400);
    expect(upsertCalls).toHaveLength(0);
  });
});

describe("POST /ingest — source tagging", () => {
  it("uses the caller-declared source when valid", async () => {
    await post({ phone: "+15551234567", source: "pipedream" }, { Authorization: "Bearer wlk_good" });
    expect(upsertCalls[0]!.source).toBe("pipedream");
  });

  it("defaults to webhook for an unknown/absent source", async () => {
    await post({ phone: "+15551234567", source: "totally-made-up" }, { Authorization: "Bearer wlk_good" });
    expect(upsertCalls[0]!.source).toBe("webhook");
  });

  it("never lets an external caller claim source 'call' (in-process only)", async () => {
    await post({ phone: "+15551234567", source: "call" }, { Authorization: "Bearer wlk_good" });
    expect(upsertCalls[0]!.source).toBe("webhook");
  });
});

describe("POST /ingest — idempotency + workflow", () => {
  it("returns 201 on create and 200 on an existing (deduped) lead", async () => {
    const created = await post({ phone: "+15551234567" }, { Authorization: "Bearer wlk_good" });
    expect(created.status).toBe(201);
    expect(((await created.json()) as IngestJson).created).toBe(true);

    upsertReturn = { id: 42, created: false };
    const merged = await post({ phone: "+15551234567" }, { Authorization: "Bearer wlk_good" });
    expect(merged.status).toBe(200);
    const json = (await merged.json()) as IngestJson;
    expect(json.created).toBe(false);
    expect(json.leadId).toBe(42);
  });

  it("acknowledges triggerWorkflow as not-yet-supported instead of silently ignoring it", async () => {
    const res = await post(
      { phone: "+15551234567", triggerWorkflow: "insurance-callback" },
      { Authorization: "Bearer wlk_good" },
    );
    const json = (await res.json()) as IngestJson;
    expect(json.note).toContain("triggerWorkflow");
  });

  it("echoes externalId back for the caller's reconciliation", async () => {
    const res = await post(
      { phone: "+15551234567", externalId: "crm-99" },
      { Authorization: "Bearer wlk_good" },
    );
    expect(((await res.json()) as IngestJson).externalId).toBe("crm-99");
  });
});
