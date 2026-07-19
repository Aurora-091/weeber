import { describe, it, expect } from "bun:test";
import {
  defaultIntakeSchema,
  isRegulatedField,
  validateFields,
  type LeadFieldDef,
} from "./intake-schema";

// intake-schema.ts is pure — no DB import — so nothing to stub here. This is
// the single compliance chokepoint every ingest path flows through, so it gets
// the most direct coverage.

describe("isRegulatedField", () => {
  it("flags regulated identifiers by key substring (case-insensitive)", () => {
    for (const key of [
      "ssn",
      "SSN",
      "pan_number",
      "aadhaar",
      "aadhar_no",
      "passport",
      "bank_account",
      "account_number",
      "ifsc",
      "card_number",
      "cvv",
      "date_of_birth",
      "dob",
      "health_condition",
      "diagnosis",
      "medication",
      "policy_number",
      "premium_amount",
      "sum_assured",
      "salary",
      "annual_income",
      "net_worth",
    ]) {
      expect(isRegulatedField(key)).toBe(true);
    }
  });

  it("flags a regulated field even when only the label (not the key) reveals it", () => {
    expect(isRegulatedField("field_1", "Social Security Number")).toBe(true);
  });

  it("does not flag genuinely non-regulated fields", () => {
    for (const key of ["full_name", "city", "product_interest", "best_callback_time", "lead_notes"]) {
      expect(isRegulatedField(key)).toBe(false);
    }
  });
});

describe("defaultIntakeSchema", () => {
  it("returns the insurance schema for the insurance vertical", () => {
    const keys = defaultIntakeSchema("insurance").map((f) => f.key);
    expect(keys).toContain("product_interest");
    expect(keys).toContain("budget_band");
  });

  it("returns the shopify schema for the shopify vertical", () => {
    const keys = defaultIntakeSchema("shopify").map((f) => f.key);
    expect(keys).toContain("order_id");
  });

  it("falls back to name + notes for an unknown/absent vertical", () => {
    const keys = defaultIntakeSchema(null).map((f) => f.key);
    expect(keys).toEqual(["full_name", "lead_notes"]);
    expect(defaultIntakeSchema(undefined).map((f) => f.key)).toEqual(["full_name", "lead_notes"]);
  });

  it("never includes a regulated field in any default schema", () => {
    for (const vertical of ["insurance", "shopify", null, undefined, "unknown"]) {
      for (const f of defaultIntakeSchema(vertical)) {
        expect(isRegulatedField(f.key, f.label)).toBe(false);
      }
    }
  });
});

const SCHEMA: LeadFieldDef[] = [
  { key: "full_name", label: "Full name", type: "text" },
  { key: "existing_policy", label: "Already covered?", type: "boolean" },
  { key: "budget_band", label: "Budget band", type: "enum", options: ["<1k", "1k-3k"] },
];

describe("validateFields", () => {
  it("accepts only defined schema keys", () => {
    const r = validateFields({ full_name: "Asha", budget_band: "1k-3k" }, SCHEMA);
    expect(r.accepted).toEqual({ full_name: "Asha", budget_band: "1k-3k" });
    expect(r.rejectedRegulated).toEqual([]);
    expect(r.droppedUnknown).toEqual([]);
  });

  it("drops unknown keys instead of storing them blindly", () => {
    const r = validateFields({ full_name: "Asha", favourite_colour: "teal" }, SCHEMA);
    expect(r.accepted).toEqual({ full_name: "Asha" });
    expect(r.droppedUnknown).toEqual(["favourite_colour"]);
  });

  it("rejects regulated fields even when they aren't in the schema", () => {
    const r = validateFields({ full_name: "Asha", pan: "ABCDE1234F", ssn: "123-45-6789" }, SCHEMA);
    expect(r.accepted).toEqual({ full_name: "Asha" });
    expect(r.rejectedRegulated.sort()).toEqual(["pan", "ssn"]);
  });

  it("NEVER echoes a rejected regulated value — only the key name", () => {
    const secret = "ABCDE1234F";
    const r = validateFields({ pan: secret }, SCHEMA);
    const serialized = JSON.stringify(r);
    expect(serialized).not.toContain(secret);
    expect(r.rejectedRegulated).toEqual(["pan"]);
    expect(Object.values(r.accepted)).not.toContain(secret);
  });

  it("coerces booleans and numbers to their string form", () => {
    const r = validateFields({ existing_policy: true }, SCHEMA);
    expect(r.accepted.existing_policy).toBe("true");
    expect(validateFields({ existing_policy: "yes" }, SCHEMA).accepted.existing_policy).toBe("true");
    expect(validateFields({ existing_policy: "no" }, SCHEMA).accepted.existing_policy).toBe("false");
  });

  it("skips null/undefined values without erroring", () => {
    const r = validateFields({ full_name: null, budget_band: undefined }, SCHEMA);
    expect(r.accepted).toEqual({});
  });

  it("returns empty results for a null/non-object payload", () => {
    expect(validateFields(null, SCHEMA).accepted).toEqual({});
    expect(validateFields(undefined, SCHEMA).accepted).toEqual({});
  });
});
