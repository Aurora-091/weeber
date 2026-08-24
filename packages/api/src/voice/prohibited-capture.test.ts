import { describe, it, expect } from "bun:test";
import {
  screenCapture,
  redactCaptureValue,
  isProhibitedCaptureKey,
  findProhibitedCapture,
  PROHIBITED_CAPTURE_KEYS,
} from "./prohibited-capture";
import { captureField } from "./tools/captureField";

/**
 * The guard existed with 16 keys, full tests, and zero callers — nothing
 * screened the write. These tests cover the two things that were missing: that
 * a refusal actually happens, and that it does not fire on the fields the
 * qualifying agent is supposed to collect.
 */

/**
 * `tool()` from the `ai` SDK requires a full ToolExecutionOptions (toolCallId,
 * messages, context) that this tool never reads. Build it once through the
 * tool's own parameter type so the shape stays correct if the SDK changes.
 */
type CaptureExecuteOptions = Parameters<NonNullable<typeof captureField.execute>>[1];
const executeOptions = (toolCallId: string): CaptureExecuteOptions =>
  ({ toolCallId, messages: [], context: undefined }) as unknown as CaptureExecuteOptions;

/** The nine permitted pre-qual keys from insurance/closer-brief.ts PREQUAL_FIELDS. */
const PERMITTED_PREQUAL_KEYS = [
  "coverage_purpose",
  "service_preference",
  "beneficiary_relationship",
  "income_type",
  "budget_comfort",
  "benefit_timing",
  "tobacco",
  "banking_ready",
  "health_flag",
];

describe("prohibited capture screening", () => {
  it("refuses the regulated fields the pilot script asks for", () => {
    for (const key of [
      "ssn",
      "applicant_ssn",
      "applicantSSN",
      "Social Security Number",
      "routing_number",
      "bankRoutingNumber",
      "account_number",
      "date_of_birth",
      "dob",
      "premium_amount",
      "carrier",
      "beneficiary_name",
      "medical_condition",
      "voice_signature",
      "ach_authorization",
    ]) {
      const result = screenCapture(key);
      expect(result.allowed).toBe(false);
    }
  });

  it("refuses identity and payment-instrument numbers that the list used to miss", () => {
    // These were absent while the list was insurance-only, so an agent that
    // captured aadhaar_number or cvv passed a guard built to stop exactly that.
    for (const key of [
      "aadhaar_number",
      "aadhar",
      "passport_number",
      "pan",
      "pan_card",
      "iban",
      "ifsc_code",
      "cvv",
      "credit_card_number",
      "debit_card",
      "drivers_license",
    ]) {
      expect(isProhibitedCaptureKey(key)).toBe(true);
    }
  });

  it("does NOT fire on any of the nine permitted pre-qual fields", () => {
    // This is the test that stops the obvious-looking refactor. Merging this
    // list with leads/intake-schema's REGULATED_FIELD_MARKERS makes `health`,
    // `income` and `bank` block health_flag, income_type and banking_ready —
    // three fields the agent is REQUIRED to collect. A guard that fires on
    // correct behaviour gets switched off.
    for (const key of PERMITTED_PREQUAL_KEYS) {
      expect(isProhibitedCaptureKey(key)).toBe(false);
    }
  });

  it("does not flag ordinary vocabulary that merely contains a short entry", () => {
    // Short entries are whole-word matched for this reason.
    for (const key of ["reachable_time", "expansion_plans", "reach_out_again", "panel_preference"]) {
      expect(isProhibitedCaptureKey(key)).toBe(false);
    }
  });

  it("treats a blank or non-string field as allowed rather than throwing", () => {
    expect(screenCapture("").allowed).toBe(true);
    expect(screenCapture(undefined).allowed).toBe(true);
    expect(screenCapture(42).allowed).toBe(true);
  });

  it("keeps findProhibitedCapture working for the closer brief's after-the-fact report", () => {
    const found = findProhibitedCapture({ tobacco: "no", applicant_ssn: "…", coverage_purpose: "burial" });
    expect(found).toEqual(["applicant_ssn"]);
  });
});

describe("redactCaptureValue", () => {
  it("removes the value but keeps the key, which is the evidence", () => {
    const redacted = redactCaptureValue({ field: "ssn", value: "123-45-6789" }) as Record<string, unknown>;
    expect(redacted.field).toBe("ssn");
    expect(redacted.value).toBe("[redacted: prohibited field]");
    expect(JSON.stringify(redacted)).not.toContain("123-45-6789");
  });

  it("does not mutate the caller's object", () => {
    const input = { field: "ssn", value: "123-45-6789" };
    redactCaptureValue(input);
    expect(input.value).toBe("123-45-6789");
  });

  it("passes through a payload with no value key", () => {
    expect(redactCaptureValue({ field: "ssn" })).toEqual({ field: "ssn" });
    expect(redactCaptureValue(null)).toBeNull();
  });

  it("also redacts `heard` (ADR-120) — the caller's own quoted words ARE the sensitive data for a prohibited key", () => {
    const redacted = redactCaptureValue({
      field: "ssn",
      value: "123-45-6789",
      heard: "my social is 123-45-6789",
    }) as Record<string, unknown>;
    expect(redacted.field).toBe("ssn");
    expect(redacted.heard).toBe("[redacted: prohibited field]");
    expect(JSON.stringify(redacted)).not.toContain("123-45-6789");
  });
});

describe("captureField tool result", () => {
  it("tells the model the capture was refused instead of confirming it", async () => {
    const result = (await captureField.execute!(
      // ADR-120 makes `heard` a required argument: the verbatim caller line the
      // value came from. The key screen still fires first, so a prohibited key
      // is refused whether or not the caller really said it.
      { field: "ssn", value: "123-45-6789", heard: "my social is 123-45-6789" },
      executeOptions("t1"),
    )) as { captured: boolean; refused?: string };
    expect(result.captured).toBe(false);
    // The refusal has to tell the model not to retry under another key name,
    // or it just captures the same value as `applicant_identifier`.
    expect(result.refused).toContain("not permitted");
    expect(result.refused).toContain("another name");
    expect(JSON.stringify(result)).not.toContain("123-45-6789");
  });

  it("still captures a permitted fact", async () => {
    const result = (await captureField.execute!(
      { field: "coverage_purpose", value: "burial costs", heard: "it's for burial costs" },
      executeOptions("t2"),
    )) as { captured: boolean; value?: string };
    expect(result.captured).toBe(true);
    expect(result.value).toBe("burial costs");
  });

  it("no longer advertises 'account number' as an example in its description", () => {
    // The tool's own description used to invite the exact capture the guard
    // forbids, which is a prompt-level contradiction the model resolves badly.
    expect(captureField.description ?? "").not.toContain("account number");
  });
});

describe("the denylist itself", () => {
  it("has no duplicate entries", () => {
    expect(new Set(PROHIBITED_CAPTURE_KEYS).size).toBe(PROHIBITED_CAPTURE_KEYS.length);
  });
});
