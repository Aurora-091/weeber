import { mock, describe, it, expect, beforeEach } from "bun:test";

/**
 * Phase C1 follow-up (2026-08-25, docs/plans/phase-c-latency.md) — a caller
 * barge-in used to force-close the whole held TTS session
 * (`stream.ts`'s old `closeTtsSession()` call in the barge-in handler),
 * paying a fresh ~80-280ms socket handshake on the very next turn even
 * though the interrupted turn's own provider (Cartesia, ElevenLabs) can
 * cancel just that turn's context without touching the connection.
 * `tts/cartesia.ts` and `tts/elevenlabs.ts` now do exactly that; this test
 * proves the `stream.ts` side of the fix — that a barge-in no longer tears
 * the session down at all, and the following turn reuses it — using the
 * same session-shaped `./tts` mock `stream-tts-lazy-connect.test.ts` uses,
 * extended to distinguish a turn-level cancel (must NOT kill the session)
 * from a session-level close (still must).
 */

type SessionRecord = { provider: string | undefined; voiceId: string | undefined; dead: boolean };
let sessionOpens: SessionRecord[] = [];
/** One entry per turn-level `close()` call on a session's `startTurn()`
 * handle — the barge-in cancel path, distinct from the session dying. */
let turnCancelCalls = 0;

let lastOnTranscript:
  | ((params: { text: string; isFinal: boolean; speechFinal: boolean }) => void)
  | null = null;

/** Resolved by the test to let a deliberately-held-open turn finish. */
let releaseTurn: (() => void) | null = null;

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
  select: () => ({ from: (table: unknown) => chain(getTableName(table) === "calls" ? [callRow] : []) }),
  insert: () => chain([]),
  update: () => chain([]),
  execute: async () => [],
};

mock.module("../database", () => ({ db: dbLike, dbBackground: dbLike }));

mock.module("./stt", () => ({
  connectStt: (onTranscript: NonNullable<typeof lastOnTranscript>) => {
    lastOnTranscript = onTranscript;
    return { sendAudio: () => {}, getStats: () => ({ reconnectCount: 0, totalGapMs: 0 }), close: () => {} };
  },
  resolveSttProvider: (override?: string | null) => override ?? "deepgram",
}));

mock.module("./tts", () => ({
  connectTtsSession: (
    providerOverride?: string | null,
    voiceId?: string,
    _language?: string,
    onConnected?: (ms: number) => void,
  ) => {
    const provider = providerOverride ?? "cartesia";
    const record: SessionRecord = { provider, voiceId, dead: false };
    sessionOpens.push(record);
    onConnected?.(0);
    return {
      provider,
      session: {
        startTurn(onAudioChunk: (b: string) => void, onDone?: () => void, _onError?: (e: unknown) => void) {
          return {
            sendText: () => onAudioChunk(Buffer.from(`audio-from-${provider}`).toString("base64")),
            endTurn: () => onDone?.(),
            // Models the real, fixed Cartesia/ElevenLabs behavior (2026-08-25):
            // a turn-level close cancels just this turn's context — the
            // session/socket is untouched, so it stays reusable.
            close: () => {
              turnCancelCalls += 1;
            },
          };
        },
        isOpen: () => !record.dead,
        close: () => {
          record.dead = true;
        },
      },
    };
  },
  connectTts: () => ({ sendText: () => {}, endTurn: () => {}, close: () => {} }),
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
  // Streams one delta (so sendText/session.startTurn actually runs, unlike
  // the "waiting on a tool" mock in stream-tts-lazy-connect.test.ts, which
  // blocks BEFORE any text — this turn must be genuinely mid-speech, with a
  // real per-turn TTS handle live, for the barge-in cancel path to fire).
  // Must be >= TONE_TAG_MAX_BUFFER_CHARS (24, tone-tags.ts) or stream.ts's
  // tone-tag filter holds it back waiting to see whether a `[[tone:...]]`
  // tag is coming, and sendText never fires at all.
  runVoiceAgentTurn: async ({ onTextDelta }: { onTextDelta?: (d: string) => void }) => {
    onTextDelta?.("Let me check that for you right away. ");
    if (releaseTurn) {
      await new Promise<void>((resolve) => {
        releaseTurn = resolve;
      });
    }
    onTextDelta?.("for you.");
    return "Let me check that for you.";
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
  sessionOpens = [];
  turnCancelCalls = 0;
  lastOnTranscript = null;
  releaseTurn = null;
});

describe("Barge-in no longer force-closes the held TTS session (Phase C1 follow-up)", () => {
  it("a barge-in mid-turn cancels only that turn — the session survives and the next turn reuses it", async () => {
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();
    await handlers.onMessage(START_EVENT, ws);
    await settle();

    // Greeting served by the pre-warmed session.
    expect(sessionOpens.length).toBe(1);

    // Caller speaks; the turn starts streaming text (sendText fires, so a
    // real per-turn TTS handle exists), then blocks mid-turn.
    releaseTurn = () => {};
    lastOnTranscript?.({ text: "what is my order status", isFinal: true, speechFinal: true });
    await settle();
    expect(sessionOpens.length).toBe(1); // still the same session, no reconnect yet

    // Caller barges in with deliberate speech (>= BARGE_IN_MIN_CHARS) while
    // the agent is mid-turn — decideBargeIn fires on the first hit.
    lastOnTranscript?.({ text: "wait actually never mind", isFinal: false, speechFinal: false });
    await settle();

    // The interrupted turn's context was canceled...
    expect(turnCancelCalls).toBe(1);
    // ...but the session itself was never torn down.
    expect(sessionOpens.length).toBe(1);
    expect(sessionOpens[0]?.dead).toBe(false);

    // A fresh caller utterance now runs a whole new turn.
    lastOnTranscript?.({ text: "actually tell me about pricing", isFinal: true, speechFinal: true });
    await settle();

    // Still exactly one socket for the entire call — the barge-in did not
    // force a reconnect, matching the fixed Cartesia/ElevenLabs behavior.
    expect(sessionOpens.length).toBe(1);

    // Let the held mock resolve so the test doesn't leave a dangling promise.
    releaseTurn?.();
    handlers.onClose();
  });
});
