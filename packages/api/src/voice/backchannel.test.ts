import { describe, expect, test } from "bun:test";
import {
  shouldBackchannel,
  BACKCHANNEL_MIN_UTTERANCE_MS,
  BACKCHANNEL_MIN_GAP_MS,
  BACKCHANNEL_LINES,
  type BackchannelDecisionInput,
} from "./backchannel";

// A baseline input that WOULD fire — each test flips one field to prove the
// corresponding guardrail is the thing gating it.
const firing: BackchannelDecisionInput = {
  enabled: true,
  agentIsSpeaking: false,
  speechFinal: false,
  hasText: true,
  utteranceMs: BACKCHANNEL_MIN_UTTERANCE_MS + 500,
  msSinceLastBackchannel: null,
};

describe("shouldBackchannel", () => {
  test("fires on a long-enough mid-utterance with no prior backchannel", () => {
    expect(shouldBackchannel(firing)).toBe(true);
  });

  test("never fires when disabled", () => {
    expect(shouldBackchannel({ ...firing, enabled: false })).toBe(false);
  });

  test("never fires while the agent is speaking (would talk over the agent)", () => {
    expect(shouldBackchannel({ ...firing, agentIsSpeaking: true })).toBe(false);
  });

  test("never fires on speech_final (that's a real end-of-turn)", () => {
    expect(shouldBackchannel({ ...firing, speechFinal: true })).toBe(false);
  });

  test("never fires on empty interim text", () => {
    expect(shouldBackchannel({ ...firing, hasText: false })).toBe(false);
  });

  test("does not fire before the minimum utterance duration", () => {
    expect(shouldBackchannel({ ...firing, utteranceMs: BACKCHANNEL_MIN_UTTERANCE_MS - 1 })).toBe(false);
  });

  test("fires exactly at the minimum utterance duration", () => {
    expect(shouldBackchannel({ ...firing, utteranceMs: BACKCHANNEL_MIN_UTTERANCE_MS })).toBe(true);
  });

  test("respects the rate limit — no second backchannel within the gap", () => {
    expect(shouldBackchannel({ ...firing, msSinceLastBackchannel: BACKCHANNEL_MIN_GAP_MS - 1 })).toBe(false);
  });

  test("allows a second backchannel once the gap has elapsed", () => {
    expect(shouldBackchannel({ ...firing, msSinceLastBackchannel: BACKCHANNEL_MIN_GAP_MS })).toBe(true);
  });

  test("backchannel lines are short and non-empty", () => {
    expect(BACKCHANNEL_LINES.length).toBeGreaterThan(0);
    for (const line of BACKCHANNEL_LINES) {
      expect(line.trim().length).toBeGreaterThan(0);
      expect(line.length).toBeLessThanOrEqual(12);
    }
  });
});
