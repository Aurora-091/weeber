import { describe, expect, test } from "bun:test";
import { checkAssertion, type SyntheticTurn } from "./synthetic-test";
import { SYNTHETIC_SCENARIOS } from "./synthetic-scenarios";
import { voiceTools } from "./agent";

// `lookupInfo` is the one tool never present in the static `voiceTools`
// object — it's constructed per-org by buildVoiceTools (A3b) — so add it to
// the valid set explicitly.
const VALID_TOOL_NAMES = new Set([...Object.keys(voiceTools), "lookupInfo"]);

const transcript: SyntheticTurn[] = [
  { role: "caller", text: "I'm calling about order ORD-48213" },
  { role: "agent", text: "I can help with that — let me look into it right away." },
  { role: "caller", text: "Great, thanks." },
  { role: "agent", text: "Your callback number is 98765 43210, is that correct?" },
];
const toolCallsByAgent = ["captureField", "hangUp"];

describe("synthetic-test assertions", () => {
  test("toolCalled passes when the tool appears anywhere in the call", () => {
    expect(checkAssertion({ type: "toolCalled", tool: "captureField", description: "" }, transcript, toolCallsByAgent)).toBe(true);
  });

  test("toolCalled fails when the tool never fires", () => {
    expect(checkAssertion({ type: "toolCalled", tool: "transferToHuman", description: "" }, transcript, toolCallsByAgent)).toBe(false);
  });

  test("toolNeverCalled passes when the tool never fires", () => {
    expect(checkAssertion({ type: "toolNeverCalled", tool: "transferToHuman", description: "" }, transcript, toolCallsByAgent)).toBe(true);
  });

  test("toolNeverCalled fails when the tool does fire", () => {
    expect(checkAssertion({ type: "toolNeverCalled", tool: "hangUp", description: "" }, transcript, toolCallsByAgent)).toBe(false);
  });

  test("agentSaid is case-insensitive and only checks agent turns", () => {
    expect(checkAssertion({ type: "agentSaid", text: "HELP", description: "" }, transcript, toolCallsByAgent)).toBe(true);
    expect(checkAssertion({ type: "agentSaid", text: "order ord-48213", description: "" }, transcript, toolCallsByAgent)).toBe(false);
  });

  test("agentNeverSaid fails when the agent did say it", () => {
    expect(checkAssertion({ type: "agentNeverSaid", text: "correct", description: "" }, transcript, toolCallsByAgent)).toBe(false);
  });

  test("agentNeverSaid passes when the agent never said it", () => {
    expect(checkAssertion({ type: "agentNeverSaid", text: "guarantee", description: "" }, transcript, toolCallsByAgent)).toBe(true);
  });
});

describe("synthetic scenario catalog integrity", () => {
  test("scenario keys are unique", () => {
    const keys = SYNTHETIC_SCENARIOS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("every scenario has at least one assertion and a positive turn cap", () => {
    for (const s of SYNTHETIC_SCENARIOS) {
      expect(s.assertions.length).toBeGreaterThan(0);
      expect(s.maxTurns).toBeGreaterThan(0);
    }
  });

  // Guards the "assertion references a tool that doesn't exist → the check
  // silently passes forever" trap: a toolCalled/toolNeverCalled assertion
  // naming a bogus tool is a dead assertion, not a real regression guard.
  test("every tool assertion references a real, invokable tool", () => {
    for (const s of SYNTHETIC_SCENARIOS) {
      for (const a of s.assertions) {
        if (a.type === "toolCalled" || a.type === "toolNeverCalled") {
          expect(VALID_TOOL_NAMES.has(a.tool)).toBe(true);
        }
      }
    }
  });
});
