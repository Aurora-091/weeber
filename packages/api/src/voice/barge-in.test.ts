import { describe, expect, test } from "bun:test";
import { decideBargeIn, BARGE_IN_STREAK_REQUIRED, BARGE_IN_MIN_CHARS } from "./barge-in";

describe("decideBargeIn", () => {
  test("never fires when the agent isn't speaking", () => {
    const d = decideBargeIn({ agentIsSpeaking: false, text: "wait wait wait", priorStreak: 0 });
    expect(d.fire).toBe(false);
    expect(d.nextStreak).toBe(0);
  });

  test("never fires on empty/whitespace-only text", () => {
    const d = decideBargeIn({ agentIsSpeaking: true, text: "   ", priorStreak: 0 });
    expect(d.fire).toBe(false);
    expect(d.nextStreak).toBe(0);
  });

  test("fires immediately on text at/above BARGE_IN_MIN_CHARS, no streak needed", () => {
    const text = "x".repeat(BARGE_IN_MIN_CHARS);
    const d = decideBargeIn({ agentIsSpeaking: true, text, priorStreak: 0 });
    expect(d.fire).toBe(true);
  });

  test("an urgent short interruption word fires on the first hit if long enough", () => {
    // "Wait" and "Stop" are both >= BARGE_IN_MIN_CHARS (4), so they must cut
    // in immediately — this is the case the exemption exists to protect.
    expect(decideBargeIn({ agentIsSpeaking: true, text: "Wait", priorStreak: 0 }).fire).toBe(true);
    expect(decideBargeIn({ agentIsSpeaking: true, text: "Stop", priorStreak: 0 }).fire).toBe(true);
  });

  test("a short fragment below BARGE_IN_MIN_CHARS does NOT fire on the first hit", () => {
    const d = decideBargeIn({ agentIsSpeaking: true, text: "uh", priorStreak: 0 });
    expect(d.fire).toBe(false);
    expect(d.nextStreak).toBe(1);
  });

  test("a short fragment fires once it reaches BARGE_IN_STREAK_REQUIRED consecutive hits", () => {
    let streak = 0;
    for (let hit = 1; hit <= BARGE_IN_STREAK_REQUIRED; hit++) {
      const d = decideBargeIn({ agentIsSpeaking: true, text: "no", priorStreak: streak });
      if (hit < BARGE_IN_STREAK_REQUIRED) {
        expect(d.fire).toBe(false);
      } else {
        expect(d.fire).toBe(true);
      }
      streak = d.nextStreak;
    }
  });

  test("a single isolated short blip (streak never repeats) never fires — the noise case", () => {
    // Simulates a cough: one short interim, then silence (empty text resets).
    const first = decideBargeIn({ agentIsSpeaking: true, text: "uh", priorStreak: 0 });
    expect(first.fire).toBe(false);
    const afterSilence = decideBargeIn({ agentIsSpeaking: true, text: "", priorStreak: first.nextStreak });
    expect(afterSilence.fire).toBe(false);
    expect(afterSilence.nextStreak).toBe(0);
  });

  test("streak resets to 0 once it fires, so a new utterance starts clean", () => {
    const d = decideBargeIn({ agentIsSpeaking: true, text: "x".repeat(BARGE_IN_MIN_CHARS), priorStreak: 3 });
    expect(d.fire).toBe(true);
    expect(d.nextStreak).toBe(0);
  });

  describe("D7: nonInterruptibleInFlight", () => {
    test("never fires on a long/urgent utterance while non-interruptible, even though it would otherwise fire immediately", () => {
      const d = decideBargeIn({
        agentIsSpeaking: true,
        text: "Wait, stop, hold on",
        priorStreak: 0,
        nonInterruptibleInFlight: true,
      });
      expect(d.fire).toBe(false);
    });

    test("never fires even once a short fragment's streak would otherwise satisfy BARGE_IN_STREAK_REQUIRED", () => {
      let streak = 0;
      for (let hit = 1; hit <= BARGE_IN_STREAK_REQUIRED + 2; hit++) {
        const d = decideBargeIn({
          agentIsSpeaking: true,
          text: "no",
          priorStreak: streak,
          nonInterruptibleInFlight: true,
        });
        expect(d.fire).toBe(false);
        streak = d.nextStreak;
      }
    });

    test("freezes the streak rather than resetting or advancing it", () => {
      const d = decideBargeIn({
        agentIsSpeaking: true,
        text: "no",
        priorStreak: 1,
        nonInterruptibleInFlight: true,
      });
      expect(d.nextStreak).toBe(1);
    });

    test("a short fragment's streak resumes advancing normally once the flag clears", () => {
      const frozen = decideBargeIn({
        agentIsSpeaking: true,
        text: "no",
        priorStreak: 1,
        nonInterruptibleInFlight: true,
      });
      expect(frozen.fire).toBe(false);
      expect(frozen.nextStreak).toBe(1);
      const resumed = decideBargeIn({
        agentIsSpeaking: true,
        text: "no",
        priorStreak: frozen.nextStreak,
        nonInterruptibleInFlight: false,
      });
      expect(resumed.fire).toBe(true);
    });

    test("agent-not-speaking still short-circuits before the non-interruptible check (order doesn't matter)", () => {
      const d = decideBargeIn({
        agentIsSpeaking: false,
        text: "Wait",
        priorStreak: 0,
        nonInterruptibleInFlight: true,
      });
      expect(d.fire).toBe(false);
      expect(d.nextStreak).toBe(0);
    });

    test("undefined nonInterruptibleInFlight behaves identically to false (default/back-compat)", () => {
      const withUndefined = decideBargeIn({ agentIsSpeaking: true, text: "Wait", priorStreak: 0 });
      const withFalse = decideBargeIn({
        agentIsSpeaking: true,
        text: "Wait",
        priorStreak: 0,
        nonInterruptibleInFlight: false,
      });
      expect(withUndefined).toEqual(withFalse);
    });
  });
});
