import { mock, describe, it, expect, beforeEach } from "bun:test";

/**
 * createLeadManual (dashboard "add lead" form). Regression coverage for the
 * pilot latency audit F1 fix: this used to store `args.phone` verbatim, so a
 * merchant typing "4155551234" or "(415) 555-1234" into the dashboard created
 * a row `getLeadGreetingContext` could never find at call time (it does an
 * exact match against the telephony provider's E.164 caller ID). The
 * literal-greeting fast path then silently fell back to a full LLM turn on
 * every call to that lead — this is the bug the audit's "literal greeting
 * rejected 11/11 times" diagnostic was pointing at.
 *
 * Only `db` and `resolveIntakeSchema` are mocked; `createLeadManual` and
 * `upsertLead` run for real so the actual normalization logic is under test.
 * The mock always reports "no existing row", so every call takes the insert
 * branch — the `values(...)` payload is what we assert on.
 */
process.env.DATABASE_URL ??= "file:./.test-leads-manual.db";

import { defaultIntakeSchema } from "./intake-schema";

const insertedValues: Array<Record<string, unknown>> = [];

mock.module("../../database", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        insertedValues.push(v);
        return {
          onConflictDoUpdate: () => ({ returning: () => Promise.resolve([{ id: 7 }]) }),
        };
      },
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve([]) }) }),
  },
}));

mock.module("./schema-store", () => ({
  resolveIntakeSchema: async (_orgId: string, vertical: string | null | undefined) => defaultIntakeSchema(vertical),
}));

const { createLeadManual } = await import("./leads");

beforeEach(() => {
  insertedValues.length = 0;
});

describe("createLeadManual — phone normalization", () => {
  it("normalizes a bare national number using the org's default country code", async () => {
    const result = await createLeadManual({
      orgId: "org_1",
      phone: "(415) 555-1234",
      vertical: "shopify",
      defaultCountryCode: "+1",
    });
    expect(result.phoneError).toBeUndefined();
    expect(insertedValues[0]!.phone).toBe("+14155551234");
  });

  it("stores an already-E.164 number unchanged, even with no default country code", async () => {
    const result = await createLeadManual({
      orgId: "org_1",
      phone: "+14155551234",
      vertical: "shopify",
      defaultCountryCode: null,
    });
    expect(result.phoneError).toBeUndefined();
    expect(insertedValues[0]!.phone).toBe("+14155551234");
  });

  it("returns a phoneError instead of storing an unparseable number, when no org country code is set", async () => {
    const result = await createLeadManual({
      orgId: "org_1",
      phone: "5551234", // too short to be a real number even with a guessed country
      vertical: "shopify",
      defaultCountryCode: null,
    });
    expect(result.phoneError).toBeTruthy();
    expect(result.created).toBe(false);
    expect(insertedValues).toHaveLength(0);
  });

  it("returns a phoneError for garbage input rather than silently storing it", async () => {
    const result = await createLeadManual({
      orgId: "org_1",
      phone: "call me maybe",
      vertical: "shopify",
      defaultCountryCode: "+1",
    });
    expect(result.phoneError).toBeTruthy();
    expect(insertedValues).toHaveLength(0);
  });
});
