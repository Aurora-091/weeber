import { describe, it, expect } from "bun:test";
import { isValidE164 } from "./validation";

describe("isValidE164", () => {
  it("accepts valid E.164 numbers", () => {
    expect(isValidE164("+15551234567")).toBe(true);
    expect(isValidE164("+919876543210")).toBe(true);
    expect(isValidE164("+442071234567")).toBe(true);
  });

  it("rejects malformed numbers", () => {
    expect(isValidE164("5551234567")).toBe(false); // missing +
    expect(isValidE164("+0123456789")).toBe(false); // leading zero after +
    expect(isValidE164("+1555")).toBe(false); // too short
    expect(isValidE164("+1555123456789012345")).toBe(false); // too long
    expect(isValidE164("not-a-number")).toBe(false);
    expect(isValidE164("")).toBe(false);
  });

  it("rejects non-string input", () => {
    expect(isValidE164(undefined)).toBe(false);
    expect(isValidE164(null)).toBe(false);
    expect(isValidE164(12345)).toBe(false);
    expect(isValidE164({})).toBe(false);
  });
});
