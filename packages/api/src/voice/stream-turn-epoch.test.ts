import { mock, describe, it, expect, beforeEach } from "bun:test";

/**
 * Voice-pipeline hardening plan, Stage 1 (2026-09-05) — closes a race
 * `AbortController` timing alone doesn't guarantee.
 *
 * `tts` and `agentIsSpeaking` are shared closure state in stream.ts,
 * reassigned across turns rather than turn-scoped. A barge-in aborts the
 * interrupted turn and nulls `tts`, but the interrupted turn's own
 * `runVoiceAgentTurn` call is a promise already in flight — nothing forces
 * it to stop producing deltas synchronously, and if the NEXT turn has
 * already started (its own `speak()` call has already reassigned `tts` to a
 * fresh facade) by the time a stale delta from the OLD turn resolves, that
 * delta would reach the NEW turn's TTS connection: a word or two of an
 * answer the caller already interrupted, bleeding into the next reply.
 *
 * `turnEpoch` (stream.ts) closes this with a value comparison instead of a
 * timing assumption. This test reproduces the exact race: hold turn 1's
 * delta back with a controllable promise, barge in, let turn 2 start and
 * begin speaking, THEN release turn 1's stale delta — and assert it never
 * reaches TTS.
 */

type TtsCall = { provider: string | undefined; voiceId: string | undefined };
let ttsCalls: TtsCall[] = [];
let sentTextByCall: string[][] = [];

let lastOnTranscript:
  | ((params: { text: string; isFinal: boolean; speechFinal: boolean }) => void)
  | null = null;

/** Resolved by the test to release turn 1's held-back delta, simulating a
 * delta that was already in flight when the barge-in fired. */
let releaseStaleDelta: (() => void) | null = null;
let turnCallCount = 0;

function getTableName(table: unknown): string | undefined {
  if (!table) return undefined;
  const sym = Object.getOwnPropertySymbols(table).find((s) => s.toString() === "Symbol(drizzle:Name)");
  return sym ? (table as Record<symbol, string>)[sym] : undefined;
}

function chain(rows: unknown[]): Promise<unknown[]> & Record<string, unknown> {
  const p = Promise.resolve(rows) as Promise<unknown[]> & Record<string, unknown>;
  for (const method of ["where", "limit", "returning", "onConflictDoNothing", "onConflictDoUpdate", "set", "values"]) {
    p[method] = () => chain(rows);
  }
  return p;
}

const callRow = {
  id: 1,
  orgId: "org_test",
  direction: "inbound",
  fromNumber: "+919999999999",
  toNumber: "+911111111111",
  webhookUrl: null,
  agentPersona: null,
  capturedState: {},
};

const dbLike = {
  select: () => ({
    from: (table: unknown) => chain(getTableName(table) === "calls" ? [callRow] : []),
  }),
  insert: () => chain([]),
  update: () => chain([]),
  execute: async () => [],
};

mock.module("../database", () => ({ db: dbLike, dbBackground: dbLike }));

mock.module("./stt", () => ({
  connectStt: (onTranscript: NonNullable<typeof lastOnTranscript>) => {
    lastOnTranscript = onTranscript;
    return {
      sendAudio: () => {},
      getStats: () => ({ reconnectCount: 0, totalGapMs: 0 }),
      close: () => {},
    };
  },
  resolveSttProvider: (override?: string | null) => override ?? "deepgram",
}));

mock.module("./tts", () => ({
  connectTts: (
    onAudioChunk: (base64Audio: string) => void,
    onDone?: () => void,
    _onError?: (err: unknown) => void,
    providerOverride?: string | null,
    voiceId?: string,
  ) => {
    const callIndex = ttsCalls.push({ provider: providerOverride ?? undefined, voiceId }) - 1;
    sentTextByCall[callIndex] = [];
    return {
      sendText: (text: string) => {
        sentTextByCall[callIndex]!.push(text);
        onAudioChunk(Buffer.from(`audio-for-${text}`).toString("base64"));
      },
      endTurn: () => onDone?.(),
      close: () => {},
    };
  },
  resolveTtsProvider: (override?: string | null) => override ?? "cartesia",
}));

mock.module("./agent", () => ({
  composeSystemPrompt: (opts: { jobDescription: string }) => ({ text: opts.jobDescription, segments: [] }),
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
  // First real turn (the caller's first utterance) holds its delta back
  // until the test releases it — modelling a delta already in flight when
  // the caller barges in. Every subsequent turn delivers immediately.
  //
  // Honors `signal` the way the real streamText-backed implementation does
  // (throws an AbortError once aborted) — real agent.ts's own catch block
  // sets `wasInterrupted` from exactly this, which in turn suppresses the
  // dead-air diagnostic for a turn the caller chose to interrupt (see its
  // own doc comment in stream.ts). Skipping this in the mock would produce
  // a real system's benign, expected "aborted turn" mislabeled as the
  // pathological case that diagnostic exists to catch.
  runVoiceAgentTurn: async ({
    onTextDelta,
    signal,
  }: {
    onTextDelta?: (d: string) => void;
    signal?: AbortSignal;
  }) => {
    turnCallCount++;
    if (turnCallCount === 1) {
      await new Promise<void>((resolve) => {
        releaseStaleDelta = resolve;
      });
      // The race this whole fix targets: one chunk was already
      // buffered/in-flight when the abort fired, so it still gets yielded —
      // real AI-SDK streams aren't guaranteed to cut off mid-buffer the
      // instant `signal.aborted` flips. The stream still ends in an
      // AbortError afterward, same as a well-behaved provider.
      onTextDelta?.("STALE reply from the interrupted turn");
      if (signal?.aborted) {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }
      return "STALE reply from the interrupted turn";
    }
    onTextDelta?.("Fresh reply after the interruption");
    return "Fresh reply after the interruption";
  },
}));

mock.module("./twilio-client", () => ({
  twilioClient: {},
  getWsUrl: () => "wss://api.weeber.test",
  getPublicUrl: () => "https://api.weeber.test",
  getTwilioClientForOrg: async () => ({ calls: () => ({ update: async () => ({}) }) }),
}));

mock.module("./org-queries", () => ({ getEffectiveFlags: async () => ({}) }));
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

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

beforeEach(() => {
  ttsCalls = [];
  sentTextByCall = [];
  lastOnTranscript = null;
  releaseStaleDelta = null;
  turnCallCount = 0;
});

describe("turnEpoch stops a barge-in turn's late delta from reaching the next turn's TTS", () => {
  it("drops a stale delta that resolves after the next turn has already started speaking", async () => {
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();
    await handlers.onMessage(START_EVENT, ws);
    await settle();

    // Turn 1: caller's first utterance. runVoiceAgentTurn blocks on
    // releaseStaleDelta before producing anything.
    void lastOnTranscript?.({ text: "what is my order status", isFinal: true, speechFinal: true });
    await settle();

    // Barge-in: agent is "speaking" (speak() already set agentIsSpeaking),
    // even though no audio has gone out yet for turn 1. bumps turnEpoch,
    // nulls tts, aborts turn 1's controller — none of which stops the
    // in-flight runVoiceAgentTurn promise above.
    lastOnTranscript?.({ text: "wait no hold on", isFinal: false, speechFinal: false });
    await settle();

    // Turn 2 starts immediately and delivers its delta right away — this is
    // the turn whose TTS facade a leaking stale delta would otherwise reach.
    void lastOnTranscript?.({ text: "never mind, thanks", isFinal: true, speechFinal: true });
    await settle();

    // NOW release turn 1's held-back delta. Without turnEpoch, this would
    // call sendText on whatever `tts` currently holds — turn 2's facade.
    releaseStaleDelta?.();
    await settle();

    const allSentText = sentTextByCall.flat();
    expect(allSentText.some((t) => t.includes("STALE"))).toBe(false);
    expect(allSentText.some((t) => t.includes("Fresh reply"))).toBe(true);

    handlers.onClose();
  });
});
