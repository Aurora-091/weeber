import { describe, it, expect } from "bun:test";
import { auditCall, type CallQualityCategory, type CallQualityInput } from "./call-quality";
import { FALLBACK_REPLY } from "./agent";

const baseInput: CallQualityInput = {
  callId: 1,
  healthStatus: "healthy",
  healthReasons: [],
  disclosureText: "Quick heads up — this call may be recorded.",
  disclosureFiredAt: new Date("2026-08-13T13:20:46Z"),
  transcripts: [],
  toolCallCount: 1,
};

describe("auditCall", () => {
  it("flags nothing for a clean, healthy call", () => {
    const input: CallQualityInput = {
      ...baseInput,
      transcripts: [
        { role: "agent", text: "Hi, this is Good Insurance calling. Do you have a minute?" },
        { role: "caller", text: "Sure." },
        { role: "agent", text: "Great, thanks for your time!" },
      ],
    };
    expect(auditCall(input)).toEqual([]);
  });

  it("flags a repeated-fallback loop — the calls 4-7 shape (2026-08-13)", () => {
    const input: CallQualityInput = {
      ...baseInput,
      transcripts: [
        { role: "agent", text: "Hi there, how can I help?" },
        { role: "caller", text: "What is the final expense insurance?" },
        { role: "agent", text: FALLBACK_REPLY },
        { role: "caller", text: "Can you tell me about this insurance?" },
        { role: "agent", text: FALLBACK_REPLY },
      ],
    };
    const findings = auditCall(input);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.category).toBe("repeated-fallback");
    expect(findings[0]!.detail).toContain("2 times");
  });

  it("does not flag a single fallback — normal one-turn recovery", () => {
    const input: CallQualityInput = {
      ...baseInput,
      transcripts: [
        { role: "agent", text: "How can I help today?" },
        { role: "agent", text: FALLBACK_REPLY },
        { role: "caller", text: "I said, tell me about the plan." },
        { role: "agent", text: "Sure — let me tell you about it." },
      ],
    };
    expect(auditCall(input)).toEqual([]);
  });

  it("flags leaked tool-call syntax surviving in a stored transcript — the calls 8/9 shape", () => {
    const input: CallQualityInput = {
      ...baseInput,
      transcripts: [
        {
          role: "agent",
          text: 'Noted. <function=captureField({"field": "coverage_purpose", "value": "final expenses"})',
        },
      ],
    };
    const findings = auditCall(input);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.category).toBe("leaked-tool-syntax");
  });

  it("flags a configured disclosure that never fired", () => {
    const input: CallQualityInput = {
      ...baseInput,
      disclosureFiredAt: null,
      transcripts: [{ role: "agent", text: "Hi there." }],
    };
    const findings = auditCall(input);
    expect(findings.map((f) => f.category)).toContain("missing-disclosure");
  });

  it("does not flag a missing disclosure when none was configured for this call", () => {
    const input: CallQualityInput = { ...baseInput, disclosureText: null, disclosureFiredAt: null };
    expect(auditCall(input).map((f) => f.category)).not.toContain("missing-disclosure");
  });

  it("flags degraded health with its reasons", () => {
    const input: CallQualityInput = {
      ...baseInput,
      healthStatus: "degraded",
      healthReasons: ["slow first audio: 3499ms to first word"],
    };
    const findings = auditCall(input);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.category).toBe("degraded-health");
    expect(findings[0]!.detail).toContain("3499ms");
  });

  it("flags an agent narrating a transfer/booking outcome with zero tool calls recorded — the call 9 shape", () => {
    const input: CallQualityInput = {
      ...baseInput,
      toolCallCount: 0,
      transcripts: [
        { role: "caller", text: "I will prefer to speak with them now." },
        { role: "agent", text: "I'm going to transfer you to a licensed advisor now. Please hold for just a moment." },
      ],
    };
    const findings = auditCall(input);
    expect(findings.map((f) => f.category)).toContain("narrated-without-tool-call");
  });

  it("does not flag narration when a tool call actually was recorded", () => {
    const input: CallQualityInput = {
      ...baseInput,
      toolCallCount: 1,
      transcripts: [{ role: "agent", text: "I'm going to transfer you to a licensed advisor now." }],
    };
    expect(auditCall(input).map((f) => f.category)).not.toContain("narrated-without-tool-call");
  });

  it("can surface multiple independent findings for the same call", () => {
    const input: CallQualityInput = {
      ...baseInput,
      healthStatus: "degraded",
      healthReasons: ["slow first audio"],
      disclosureFiredAt: null,
      toolCallCount: 0,
      transcripts: [
        { role: "agent", text: FALLBACK_REPLY },
        { role: "agent", text: FALLBACK_REPLY },
        { role: "agent", text: "I'm going to connect you with a licensed advisor right now." },
      ],
    };
    const categories = auditCall(input).map((f) => f.category).sort();
    const expected: CallQualityCategory[] = [
      "degraded-health",
      "missing-disclosure",
      "narrated-without-tool-call",
      "repeated-fallback",
    ];
    expect(categories).toEqual(expected.sort());
  });
});
