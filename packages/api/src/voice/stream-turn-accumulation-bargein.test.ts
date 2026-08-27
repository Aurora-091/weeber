import { mock, describe, it, expect, beforeEach } from "bun:test";
import {
  createDbHarness,
  createSttHarness,
  twilioClientHarnessModule,
  createOrgQueriesHarness,
  leadsHarnessModule,
  fakeWs,
  settle,
  buildStartEvent,
} from "./test-helpers/stream-harness";

/**
 * Bug fix (2026-08-27) — regression found while investigating a live-call
 * complaint ("agent cuts off mid-speech, goes silent, caller has to say
 * hello/continue, agent then apologizes and restarts"). D9's turn-
 * accumulation window (stream-turn-accumulation.test.ts) armed its 1400ms
 * hold unconditionally on every `speech_final` for
 * "insurance-final-expense-qualifier" — including one that just interrupted
 * (`decideBargeIn` fired on) the agent's own in-flight speech. That meant
 * every barge-in on this template produced a mandatory 1.4s+ dead silence
 * immediately after the agent had already been cut off, before it responded
 * to what the caller interrupted to say — not the "caller paused mid-
 * sentence" case D9 was built for. Fixed by excluding `bargeIn.fire` from
 * the accumulation gate (stream.ts).
 *
 * This file needs a TTS mock that can stay "mid-turn" on demand (unlike the
 * vanilla harness, which resolves a turn synchronously) so a test can send a
 * barge-in event while `agentIsSpeaking` is still genuinely true.
 */

let turnCallCount = 0;
let lastTurnHistory: { role: string; content: unknown }[] = [];
/** Captured from the greeting's TTS session so a test can choose exactly
 * when the greeting's turn "finishes" — i.e. when agentIsSpeaking flips
 * back to false on its own, as opposed to via a barge-in abort. */
let releaseCurrentTtsTurn: (() => void) | null = null;

const db = createDbHarness({ tables: { calls: [{ id: 1, orgId: "org-1", direction: "inbound", status: "in-progress" }] } });
const stt = createSttHarness();

mock.module("../database", db.module);
mock.module("./stt", stt.module);

mock.module("./tts", () => ({
  connectTts: () => ({ sendText: () => {}, endTurn: () => {}, close: () => {} }),
  connectTtsSession: (providerOverride?: string | null, _voiceId?: string, _language?: string, onConnected?: (ms: number) => void) => {
    onConnected?.(0);
    return {
      provider: providerOverride ?? "cartesia",
      session: {
        startTurn: (onAudioChunk: (b: string) => void, onDone?: () => void) => ({
          // Delivers real audio (so turnTtsFirstByteMs/agentIsSpeaking behave
          // like a genuine in-progress turn), but does NOT call onDone until
          // the test explicitly releases it via releaseCurrentTtsTurn — this
          // is what keeps agentIsSpeaking true long enough to fire a barge-in
          // event against it.
          sendText: () => onAudioChunk(Buffer.from("audio").toString("base64")),
          endTurn: () => {
            releaseCurrentTtsTurn = () => onDone?.();
          },
          close: () => {
            // A real barge-in's tts.close() — the interrupted turn ends here,
            // not via onDone, matching stream.ts's own close() semantics.
            releaseCurrentTtsTurn = null;
          },
        }),
        isOpen: () => true,
        close: () => {},
      },
    };
  },
  resolveTtsProvider: (override?: string | null) => override ?? "cartesia",
}));

mock.module("./agent", () => ({
  composeSystemPrompt: (opts: { jobDescription: string }) => ({ text: opts.jobDescription, segments: [] }),
  hasExhaustedField: () => false,
  resolveAgentConfig: async () => ({
    systemPrompt: "You are a test agent.",
    ttsProvider: "cartesia",
    voiceId: undefined,
    llmProvider: "gateway",
    sttProvider: "deepgram",
    language: "en",
    // Same value agent.ts's resolveTurnAccumulation returns for
    // insurance-final-expense-qualifier — the one template this shipped for.
    turnAccumulationMs: 1400,
  }),
  runVoiceAgentGreeting: async ({ onTextDelta }: { onTextDelta?: (d: string) => void }) => {
    onTextDelta?.("Hello, this is the agent speaking for a while.");
    return "Hello, this is the agent speaking for a while.";
  },
  runVoiceAgentTurn: async ({
    history,
    onTextDelta,
  }: {
    history: { role: string; content: unknown }[];
    onTextDelta?: (d: string) => void;
  }) => {
    turnCallCount += 1;
    lastTurnHistory = history.map((m) => ({ ...m }));
    onTextDelta?.("Sure, let me help with that.");
    return "Sure, let me help with that.";
  },
}));

mock.module("./twilio-client", twilioClientHarnessModule);
mock.module("./org-queries", createOrgQueriesHarness().module);
mock.module("./leads/leads", leadsHarnessModule);

const { createVoiceStreamHandlers } = await import("./stream");

const START_EVENT = buildStartEvent();

beforeEach(() => {
  turnCallCount = 0;
  lastTurnHistory = [];
  releaseCurrentTtsTurn = null;
});

describe("D9 turn accumulation — barge-in interaction (bug fix, 2026-08-27)", () => {
  it("responds immediately to a barge-in instead of applying the fragmented-answer accumulation hold", async () => {
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();
    await handlers.onMessage(START_EVENT, ws);
    await settle(30);

    // The greeting is still "speaking" — its TTS turn was never released.
    expect(releaseCurrentTtsTurn).not.toBeNull();
    const turnsBeforeBargeIn = turnCallCount;

    // A real interruption: long enough to fire decideBargeIn on the first
    // hit (BARGE_IN_MIN_CHARS), and also speech_final — the exact shape
    // that used to get caught by the accumulation gate.
    stt.getLastOnTranscript()?.({ text: "Wait, I have a question", isFinal: true, speechFinal: true });

    // Give the barge-in's abort + the resulting turn's synchronous work a
    // moment, but nowhere near the 1400ms accumulation window — if the bug
    // were still present, turnCallCount would still equal turnsBeforeBargeIn
    // here and only increment after settle(1400)+.
    await settle(100);

    expect(turnCallCount).toBe(turnsBeforeBargeIn + 1);
    expect(lastTurnHistory.filter((m) => m.role === "user").at(-1)?.content).toBe("Wait, I have a question");

    handlers.onClose();
  });

  it("still applies the accumulation hold for a genuine pause when the agent was NOT speaking", async () => {
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();
    await handlers.onMessage(START_EVENT, ws);
    await settle(30);

    // Let the greeting finish normally (agentIsSpeaking -> false on its own,
    // not via a barge-in abort) before the caller answers.
    releaseCurrentTtsTurn?.();
    await settle(30);
    const turnsAfterGreeting = turnCallCount;

    // A short fragment of the caller's own answer, agent silent — this is
    // exactly D9's intended case and must still wait for the window.
    stt.getLastOnTranscript()?.({ text: "final", isFinal: true, speechFinal: true });
    await settle(300);
    expect(turnCallCount).toBe(turnsAfterGreeting); // still holding

    await settle(1200);
    expect(turnCallCount).toBe(turnsAfterGreeting + 1); // fires after the window

    handlers.onClose();
  });
});
