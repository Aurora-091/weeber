import { mock, describe, it, expect, beforeEach } from "bun:test";

/**
 * ADR-085: outbound templates that open by naming the person had nothing bound
 * to {{lead_name}} / {{interest_area}}, so every such call silently fell back
 * to an LLM-generated greeting. These tests cover the lookup that binds them.
 */

let leadRows: { name: string | null; fields: Record<string, string> }[] = [];
let selectCalls = 0;

function chain(rows: unknown[]): Promise<unknown[]> & Record<string, unknown> {
  const p = Promise.resolve(rows) as Promise<unknown[]> & Record<string, unknown>;
  for (const method of ["where", "limit", "returning"]) {
    p[method] = () => chain(rows);
  }
  return p;
}

mock.module("../../database", () => ({
  db: {
    select: () => {
      selectCalls++;
      return { from: () => chain(leadRows) };
    },
    insert: () => chain([]),
    update: () => chain([]),
  },
}));

const { getLeadGreetingContext } = await import("./leads");

beforeEach(() => {
  leadRows = [];
  selectCalls = 0;
});

describe("getLeadGreetingContext", () => {
  it("binds the lead's name under every tag the outbound templates use", async () => {
    leadRows = [{ name: "Margaret Ellison", fields: {} }];
    const ctx = await getLeadGreetingContext("org_1", "+15551234567");
    expect(ctx.lead_name).toBe("Margaret Ellison");
    // Templates 05/09 use lead_name, 07 uses policyholder_name — one lookup
    // serves all of them.
    expect(ctx.policyholder_name).toBe("Margaret Ellison");
    expect(ctx.full_name).toBe("Margaret Ellison");
  });

  it("exposes schema-validated intake fields as merge tags", async () => {
    leadRows = [{ name: "Margaret Ellison", fields: { interest_area: "final expense coverage" } }];
    const ctx = await getLeadGreetingContext("org_1", "+15551234567");
    // Both tags in template 09's greeting now resolve.
    expect(ctx.lead_name).toBe("Margaret Ellison");
    expect(ctx.interest_area).toBe("final expense coverage");
  });

  it("omits lead_name entirely for a blank name so the caller's guard rejects the line", async () => {
    // The failure this prevents: greeting a lead as "Hi, is this ?"
    leadRows = [{ name: "   ", fields: { interest_area: "final expense" } }];
    const ctx = await getLeadGreetingContext("org_1", "+15551234567");
    expect(ctx.lead_name).toBeUndefined();
    expect(ctx.policyholder_name).toBeUndefined();
    // Unrelated fields still resolve — only the name is withheld.
    expect(ctx.interest_area).toBe("final expense");
  });

  it("drops blank and non-string field values rather than binding empty tags", async () => {
    leadRows = [{
      name: "Ray Whitfield",
      fields: { interest_area: "  ", coverage_goal: "burial costs", stale: "" } as Record<string, string>,
    }];
    const ctx = await getLeadGreetingContext("org_1", "+15551234567");
    expect(ctx.interest_area).toBeUndefined();
    expect(ctx.stale).toBeUndefined();
    expect(ctx.coverage_goal).toBe("burial costs");
  });

  it("lets the lead's own name win over a stale full_name in intake fields", async () => {
    leadRows = [{ name: "Margaret Ellison", fields: { full_name: "M. Ellison (old)" } }];
    const ctx = await getLeadGreetingContext("org_1", "+15551234567");
    expect(ctx.full_name).toBe("Margaret Ellison");
  });

  it("returns an empty context and issues no query without an org or phone", async () => {
    // Self-hosted / no-org usage has no leads layer — must not query at all on
    // the pickup hot path.
    expect(await getLeadGreetingContext(undefined, "+15551234567")).toEqual({});
    expect(await getLeadGreetingContext("org_1", undefined)).toEqual({});
    expect(selectCalls).toBe(0);
  });

  it("returns an empty context when no lead exists for that number", async () => {
    leadRows = [];
    expect(await getLeadGreetingContext("org_1", "+15559999999")).toEqual({});
  });
});

/**
 * The gap ADR-085 left behind (2026-08-09). The tests above set
 * `leads.fields` directly, which bypasses `validateFields` — so they proved
 * the lookup worked while the ingest pipeline could never actually deliver
 * `interest_area`, because the key was not in the insurance intake schema and
 * unknown keys are dropped. These tests assert the round trip a real CRM/CSV
 * push takes: source payload -> validateFields -> stored fields -> merge tags.
 */
describe("interest_area survives the ingest pipeline, not just the lookup", () => {
  it("accepts interest_area and state through the insurance intake schema", async () => {
    const { validateFields, defaultIntakeSchema } = await import("./intake-schema");
    const result = validateFields(
      { full_name: "Margaret Ellison", interest_area: "final expense coverage", state: "Ohio" },
      defaultIntakeSchema("insurance"),
    );
    // Previously both were in droppedUnknown, so the opener could never resolve.
    expect(result.droppedUnknown).not.toContain("interest_area");
    expect(result.droppedUnknown).not.toContain("state");
    expect(result.accepted.interest_area).toBe("final expense coverage");
    expect(result.accepted.state).toBe("Ohio");
    expect(result.rejectedRegulated).toEqual([]);
  });

  it("still blocks the regulated fields the script asks for, on the same payload", async () => {
    const { validateFields, defaultIntakeSchema } = await import("./intake-schema");
    const result = validateFields(
      { interest_area: "final expense coverage", dob: "1948-03-02", routing_number: "021000021", medical_conditions: "COPD" },
      defaultIntakeSchema("insurance"),
    );
    expect(result.accepted.interest_area).toBe("final expense coverage");
    for (const key of ["dob", "routing_number", "medical_conditions"]) {
      expect(result.rejectedRegulated).toContain(key);
      expect(result.accepted[key]).toBeUndefined();
    }
  });

  it("speaks a phrase when the source only sent the product_interest enum", async () => {
    leadRows = [{ name: "Margaret Ellison", fields: { product_interest: "final_expense" } }];
    const ctx = await getLeadGreetingContext("org_1", "+15551234567");
    // "reached out about final_expense" is not a sentence a human says.
    expect(ctx.interest_area).toBe("final expense coverage");
    expect(ctx.product_interest).toBe("final_expense");
  });

  it("prefers an explicit interest_area over the enum-derived phrase", async () => {
    leadRows = [
      { name: "Margaret Ellison", fields: { interest_area: "burial coverage for your family", product_interest: "term" } },
    ];
    const ctx = await getLeadGreetingContext("org_1", "+15551234567");
    expect(ctx.interest_area).toBe("burial coverage for your family");
  });

  it("omits interest_area for an unmappable enum rather than inventing one", async () => {
    leadRows = [{ name: "Margaret Ellison", fields: { product_interest: "other" } }];
    const ctx = await getLeadGreetingContext("org_1", "+15551234567");
    // Guard then rejects the line and a generic greeting is used, which beats
    // asserting the wrong product to the consumer.
    expect(ctx.interest_area).toBeUndefined();
  });
});
