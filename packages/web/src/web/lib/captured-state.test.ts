import { describe, it, expect } from "bun:test";
import { capturedValue, isUnanswered } from "./captured-state";

describe("capturedValue", () => {
  it("reads .value off an ADR-120 entry object", () => {
    expect(capturedValue({ value: "a@b.com", heard: "my email is a@b.com", transcriptId: 1, turn: 0 })).toBe(
      "a@b.com",
    );
  });

  it("tolerates a pre-migration bare string", () => {
    expect(capturedValue("a@b.com")).toBe("a@b.com");
  });

  it("renders an unanswered entry (value: null) as an empty string, not the literal 'null'", () => {
    expect(capturedValue({ value: null, heard: "just do some kind of drinks", transcriptId: 1, turn: 0 })).toBe("");
  });

  it("renders absent/null input as an empty string", () => {
    expect(capturedValue(undefined)).toBe("");
    expect(capturedValue(null)).toBe("");
  });
});

describe("isUnanswered — A2, phase-a-integrity.md", () => {
  it("is true for a markFieldUnanswered entry", () => {
    expect(isUnanswered({ value: null, heard: "just do some kind of drinks", transcriptId: 1, turn: 0 })).toBe(true);
  });

  it("is false for a real captured value", () => {
    expect(isUnanswered({ value: "a@b.com", heard: "a@b.com", transcriptId: 1, turn: 0 })).toBe(false);
  });

  it("is false for a pre-migration bare string, which is never null", () => {
    expect(isUnanswered("a@b.com")).toBe(false);
  });

  it("is false for absent/null input", () => {
    expect(isUnanswered(undefined)).toBe(false);
    expect(isUnanswered(null)).toBe(false);
  });
});
