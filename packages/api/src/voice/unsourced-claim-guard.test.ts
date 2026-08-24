import { describe, it, expect } from "bun:test";
import { detectUnsourcedPriceClaims } from "./unsourced-claim-guard";

describe("detectUnsourcedPriceClaims — A5, phase-a-integrity.md", () => {
  it("flags the literal call-2 sentence", () => {
    // Production call 2 (2026-08-20), transcript 31 — spoken with no source
    // and no guardrail_events row.
    const claims = detectUnsourcedPriceClaims(
      "Sure, I can share some general context. Cremation services typically run between five thousand and eight thousand dollars.",
    );
    expect(claims).toHaveLength(1);
    expect(claims[0].sentence).toContain("five thousand and eight thousand dollars");
  });

  it("does not flag a figure with an attached source", () => {
    const claims = detectUnsourcedPriceClaims(
      "Your policy shows a monthly premium of two hundred dollars.",
    );
    expect(claims).toHaveLength(0);
  });

  it("does not flag a sentence quoting a real number", () => {
    const claims = detectUnsourcedPriceClaims("The quote we sent you was for three hundred dollars a month.");
    expect(claims).toHaveLength(0);
  });

  it("does not flag a sentence with no currency at all", () => {
    const claims = detectUnsourcedPriceClaims("I can connect you with a licensed advisor right now.");
    expect(claims).toHaveLength(0);
  });

  it("does not flag a sentence with a number but no currency", () => {
    const claims = detectUnsourcedPriceClaims("I have five appointment slots open this week.");
    expect(claims).toHaveLength(0);
  });

  it("flags a plain dollar-sign figure with no source", () => {
    const claims = detectUnsourcedPriceClaims("That plan usually runs about $450 a month.");
    expect(claims).toHaveLength(1);
  });

  it("flags only the offending sentence, not the whole turn", () => {
    const claims = detectUnsourcedPriceClaims(
      "Thanks for sharing that. Cremation typically runs five thousand dollars. I'll connect you with an advisor.",
    );
    expect(claims).toHaveLength(1);
    expect(claims[0].sentence).toContain("five thousand dollars");
  });

  it("returns nothing for empty or whitespace-only text", () => {
    expect(detectUnsourcedPriceClaims("")).toEqual([]);
    expect(detectUnsourcedPriceClaims("   ")).toEqual([]);
  });

  it("flags an Indian-rupee figure the same way", () => {
    const claims = detectUnsourcedPriceClaims("That typically costs around fifty thousand rupees.");
    expect(claims).toHaveLength(1);
  });
});
