import { mock, describe, it, expect, beforeEach } from "bun:test";
import { clearTtsCacheForTests } from "./tts-cache";

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

const callRow = { id: 1, orgId: "org_test", direction: "inbound", status: "in-progress" };

function chain(rows: unknown[]): Promise<unknown[]> & Record<string, unknown> {
  const p = Promise.resolve(rows) as Promise<unknown[]> & Record<string, unknown>;
  for (const method of ["where", "limit", "orderBy", "returning", "onConflictDoNothing", "onConflictDoUpdate", "set", "values", "from"]) {
    p[method] = () => chain(rows);
  }
  return p;
}

function getTableName(table: unknown): string {
  const sym = Object.getOwnPropertySymbols(table as object).find((s) => String(s).includes("Name"));
  return sym ? String((table as Record<symbol, unknown>)[sym]) : "";
}

const dbLike = {
  select: () => ({ from: (table: unknown) => chain(getTableName(table) === "calls" ? [callRow] : []) }),
  insert: () => chain([]),
  update: () => chain([]),
  execute: async () => [],
};

mock.module("../database", () => ({ db: dbLike, dbBackground: dbLike }));

let lastOnTranscript: ((params: { text: string; isFinal: boolean; speechFinal: boolean }) => void) | null = null;

mock.module("./stt", () => ({
  connectStt: (onTranscript: NonNullable<typeof lastOnTranscript>) => {
    lastOnTranscript = onTranscript;
    return { sendAudio: () => {}, getStats: () => ({ reconnectCount: 0, totalGapMs: 0 }), close: () => {} };
  },
  resolveSttProvider: (override?: string | null) => override ?? "deepgram",
}));

mock.module("./tts", () => ({
  connectTts: (onAudioChunk: (base64Audio: string) => void, onDone?: () => void) => ({
    sendText: () => onAudioChunk(Buffer.from("audio").toString("base64")),
    endTurn: () => onDone?.(),
    close: () => {},
  }),
  connectTtsSession: (providerOverride?: string | null, _voiceId?: string, _language?: string, onConnected?: (ms: number) => void) => {
    onConnected?.(0);
    return {
      provider: providerOverride ?? "cartesia",
      session: {
        startTurn: (onAudioChunk: (base64Audio: string) => void, onDone?: () => void) => ({
          sendText: () => onAudioChunk(Buffer.from("audio").toString("base64")),
          endTurn: () => onDone?.(),
          close: () => {},
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

mock.module("./twilio-client", () => ({
  twilioClient: {},
  getWsUrl: () => "wss://api.weeber.test",
  getPublicUrl: () => "https://api.weeber.test",
  getTwilioClientForOrg: async () => ({ calls: () => ({ update: async () => ({}) }) }),
}));

let agentFlagsOverride: Record<string, boolean> | undefined;
mock.module("./org-queries", () => ({
  getEffectiveFlags: async () => agentFlagsOverride ?? {},
}));
mock.module("./leads/leads", () => ({
  promoteLeadFromCall: async () => undefined,
  getLeadGreetingContext: async () => ({}),
}));

const { createVoiceStreamHandlers } = await import("./stream");

const START_EVENT = JSON.stringify({
  event: "start",
  start: { streamSid: "MZ-test", callSid: "CA-test", customParameters: { from: "+919999999999", to: "+911111111111" } },
});

function fakeWs() {
  const sent: string[] = [];
  return { sent, send: (data: string) => sent.push(data), close: () => {} };
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// BACKCHANNEL_MIN_UTTERANCE_MS is 2500 — the interim STT events below are
// spaced past it deliberately, so this is not an arbitrary settle().
const PAST_MIN_UTTERANCE_MS = 2600;

beforeEach(() => {
  lastOnTranscript = null;
  agentFlagsOverride = undefined;
  clearTtsCacheForTests();
});

describe("backchannel default flip (2026-08-25)", () => {
  it("with no flags row at all, a long caller utterance gets a mid-utterance backchannel", async () => {
    agentFlagsOverride = undefined; // {} from the mock above — the real production shape
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();
    await handlers.onMessage(START_EVENT, ws);
    await settle(30);

    // Starts the utterance timer.
    lastOnTranscript?.({ text: "well, so, I was calling about", isFinal: false, speechFinal: false });
    await settle(PAST_MIN_UTTERANCE_MS);
    const sentBeforeSecondInterim = ws.sent.length;
    // Still mid-utterance (not speechFinal) — this is where a backchannel
    // may fire, now that the utterance has run past BACKCHANNEL_MIN_UTTERANCE_MS.
    lastOnTranscript?.({ text: "well, so, I was calling about my order", isFinal: false, speechFinal: false });
    await settle(30);
    handlers.onClose();

    expect(ws.sent.length).toBeGreaterThan(sentBeforeSecondInterim);
  }, 10000);

  it("an explicit enabled: false still suppresses the backchannel — the kill switch survives the default flip", async () => {
    agentFlagsOverride = { backchannels: false };
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();
    await handlers.onMessage(START_EVENT, ws);
    await settle(30);

    lastOnTranscript?.({ text: "well, so, I was calling about", isFinal: false, speechFinal: false });
    await settle(PAST_MIN_UTTERANCE_MS);
    const sentBeforeSecondInterim = ws.sent.length;
    lastOnTranscript?.({ text: "well, so, I was calling about my order", isFinal: false, speechFinal: false });
    await settle(30);
    handlers.onClose();

    expect(ws.sent.length).toBe(sentBeforeSecondInterim);
  }, 10000);
});
