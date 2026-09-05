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

  test("SpeechStarted alone does not barge in — a cough still trips VAD", () => {
    const d = decideBargeIn({
      agentIsSpeaking: true,
      text: "",
      priorStreak: 0,
      vad: "speech_started",
    });
    expect(d.fire).toBe(false);
    expect(d.nextStreak).toBe(1);
  });

  test("SpeechStarted plus one short interim reaches the streak and fires", () => {
    const vad = decideBargeIn({
      agentIsSpeaking: true,
      text: "",
      priorStreak: 0,
      vad: "speech_started",
    });
    const text = decideBargeIn({ agentIsSpeaking: true, text: "uh", priorStreak: vad.nextStreak });
    expect(text.fire).toBe(true);
  });
});
