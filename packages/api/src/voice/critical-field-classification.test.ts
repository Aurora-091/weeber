import { describe, it, expect } from "bun:test";
import { isCriticalField, CRITICAL_FIELD_KEYS } from "./critical-field-classification";

describe("isCriticalField — D8 spell-back classification", () => {
  it("classifies exact key names for every category the plan names", () => {
    expect(isCriticalField("name")).toBe(true);
    expect(isCriticalField("phone")).toBe(true);
    expect(isCriticalField("order")).toBe(true);
    expect(isCriticalField("policy")).toBe(true);
    expect(isCriticalField("vehicle")).toBe(true);
    expect(isCriticalField("pan")).toBe(true);
    expect(isCriticalField("ssn")).toBe(true);
  });

  it("classifies realistic snake_case/camelCase keys a model would actually author", () => {
    expect(isCriticalField("caller_name")).toBe(true);
    expect(isCriticalField("fullName")).toBe(true);
    expect(isCriticalField("phone_number")).toBe(true);
    expect(isCriticalField("mobileNumber")).toBe(true);
    expect(isCriticalField("order_id")).toBe(true);
    expect(isCriticalField("policy_number")).toBe(true);
    expect(isCriticalField("vehicle_registration_number")).toBe(true);
    expect(isCriticalField("registration_number")).toBe(true);
  });

  it("is case- and separator-insensitive, like isProhibitedCaptureKey", () => {
    expect(isCriticalField("Caller Name")).toBe(true);
    expect(isCriticalField("CALLER-NAME")).toBe(true);
    expect(isCriticalField("caller.name")).toBe(true);
  });

  it("does not classify ordinary, low-stakes fields as critical", () => {
    expect(isCriticalField("coverage_purpose")).toBe(false);
    expect(isCriticalField("income_type")).toBe(false);
    expect(isCriticalField("email")).toBe(false);
    expect(isCriticalField("callback_time")).toBe(false);
    expect(isCriticalField("banking_ready")).toBe(false);
    expect(isCriticalField("health_flag")).toBe(false);
  });

  it("does not false-positive on ordinary vocabulary containing a short critical token as a substring", () => {
    // "pan" and "ssn" are whole-token matched specifically to avoid this.
    expect(isCriticalField("expansion_plans")).toBe(false);
    expect(isCriticalField("assessment")).toBe(false);
  });

  it("still matches the short tokens (pan/ssn) when they stand alone as a whole word", () => {
    expect(isCriticalField("pan_number")).toBe(true);
    expect(isCriticalField("ssn_last4")).toBe(true);
  });

  it("every entry in CRITICAL_FIELD_KEYS classifies itself", () => {
    for (const key of CRITICAL_FIELD_KEYS) {
      expect(isCriticalField(key)).toBe(true);
    }
  });
});
