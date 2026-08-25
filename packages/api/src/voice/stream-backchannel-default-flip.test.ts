import { mock, describe, it, expect, beforeEach } from "bun:test";
import { clearTtsCacheForTests } from "./tts-cache";
import {
  createDbHarness,
  createSttHarness,
  createTtsHarness,
  twilioClientHarnessModule,
  createOrgQueriesHarness,
  leadsHarnessModule,
  fakeWs,
  settle,
  buildStartEvent,
} from "./test-helpers/stream-harness";

/**
 * Backchannel default flip (2026-08-25, at the user's explicit direction —
 * same D4-pattern opt-out flip as HYBRID_AUDIO_CACHE_FLAG, see
 * `backchannel.ts`'s doc comment): `backchannelsEnabled` in stream.ts used
 * to read an absent `feature_flags` row as OFF (`=== true`). Production's
 * `feature_flags` table is empty, so this Phase IV feature was built and
 * never once fired. Flipped to `!== false` so an absent row now means ON;
 * an explicit `enabled: false` row is still the kill switch.
 *
 * `shouldBackchannel`'s own gating logic (utterance-length threshold, rate
 * limit, never-while-agent-speaking, never-on-speech_final) is unit-tested
 * in isolation in backchannel.test.ts and is untouched by this change — this
 * file only proves the flag-resolution flip itself, end to end, against the
 * real `createVoiceStreamHandlers` state machine. `BACKCHANNEL_MIN_UTTERANCE_MS`
 * (2500ms) is measured off real `Date.now()` calls in stream.ts, so this test
 * genuinely waits past it rather than mocking the clock.
 */

const db = createDbHarness();
const stt = createSttHarness();
const orgQueries = createOrgQueriesHarness();

mock.module("../database", db.module);
mock.module("./stt", stt.module);
mock.module("./tts", createTtsHarness().module);

mock.module("./agent", () => ({
  composeSystemPrompt: (opts: { jobDescription: string }) => ({ text: opts.jobDescription, segments: [] }),
  hasExhaustedField: () => false,
  resolveAgentConfig: async () => ({
    systemPrompt: "You are a test agent.",
    enabledTools: undefined,
    llmModel: "test-model",
    llmProvider: "gateway",
    sttProvider: "deepgram",
    ttsProvider: "cartesia",
    voiceId: "cartesia-voice-uuid",
    language: "en",
    literalGreetingTemplate: undefined,
  }),
  runVoiceAgentGreeting: async ({ onTextDelta }: { onTextDelta?: (d: string) => void }) => {
    onTextDelta?.("Hello, this is the agent.");
    return "Hello, this is the agent.";
  },
  runVoiceAgentTurn: async ({ onTextDelta }: { onTextDelta?: (d: string) => void }) => {
    onTextDelta?.("Sure, I can help with that.");
    return "Sure, I can help with that.";
  },
}));

mock.module("./twilio-client", twilioClientHarnessModule);
mock.module("./org-queries", orgQueries.module);
mock.module("./leads/leads", leadsHarnessModule);

const { createVoiceStreamHandlers } = await import("./stream");

const START_EVENT = buildStartEvent();

// BACKCHANNEL_MIN_UTTERANCE_MS is 2500 — the interim STT events below are
// spaced past it deliberately, so this is not an arbitrary settle().
const PAST_MIN_UTTERANCE_MS = 2600;

beforeEach(() => {
  orgQueries.reset();
  clearTtsCacheForTests();
});

describe("backchannel default flip (2026-08-25)", () => {
  it("with no flags row at all, a long caller utterance gets a mid-utterance backchannel", async () => {
    orgQueries.setFlags({}); // the real production shape
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();
    await handlers.onMessage(START_EVENT, ws);
    await settle(30);

    // Starts the utterance timer.
    stt.getLastOnTranscript()?.({ text: "well, so, I was calling about", isFinal: false, speechFinal: false });
    await settle(PAST_MIN_UTTERANCE_MS);
    const sentBeforeSecondInterim = ws.sent.length;
    // Still mid-utterance (not speechFinal) — this is where a backchannel
    // may fire, now that the utterance has run past BACKCHANNEL_MIN_UTTERANCE_MS.
    stt.getLastOnTranscript()?.({ text: "well, so, I was calling about my order", isFinal: false, speechFinal: false });
    await settle(30);
    handlers.onClose();

    expect(ws.sent.length).toBeGreaterThan(sentBeforeSecondInterim);
  }, 10000);

  it("an explicit enabled: false still suppresses the backchannel — the kill switch survives the default flip", async () => {
    orgQueries.setFlags({ backchannels: false });
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();
    await handlers.onMessage(START_EVENT, ws);
    await settle(30);

    stt.getLastOnTranscript()?.({ text: "well, so, I was calling about", isFinal: false, speechFinal: false });
    await settle(PAST_MIN_UTTERANCE_MS);
    const sentBeforeSecondInterim = ws.sent.length;
    stt.getLastOnTranscript()?.({ text: "well, so, I was calling about my order", isFinal: false, speechFinal: false });
    await settle(30);
    handlers.onClose();

    expect(ws.sent.length).toBe(sentBeforeSecondInterim);
  }, 10000);
});
