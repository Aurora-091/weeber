import { mock, describe, it, expect, beforeEach } from "bun:test";

/**
 * Defect (ADR-083): "the agent's voice changed partway through the call, and
 * the provider was healthy the whole time."
 *
 * stream.ts used to open the per-turn TTS websocket at the *top* of the turn,
 * before generate() had run the LLM and any tool round-trips. On a turn with a
 * tool call that gap is seconds long, and both live providers hang up on a
 * socket nobody has spoken on:
 *
 *   Cartesia: close code 1000 "connection idle timeout"
 *   Sarvam:   close code 408 "Websocket was left open without any messages for too long."
 *
 * That close arrived at stream.ts's `onError`, which could not distinguish
 * "this provider is broken" from "we connected too early". So it burned a link
 * off the per-call failover chain, recorded a provider failover, and — because
 * failover is deliberately sticky for the rest of the call (see
 * stream-tts-voice-identity.test.ts) — permanently moved the caller onto a
 * different provider's default voice.
 *
 * Phase C1 (2026-08-24, docs/plans/phase-c-latency.md): stream.ts now holds
 * one TTS *session* per call instead of reconnecting every turn — see
 * getOrOpenTtsSession/closeTtsSession in stream.ts. The mock below models a
 * session, not a one-shot connection: `sessionOpens` records one entry per
 * actual new socket (connectTtsSession call), separate from how many turns
 * ran on it. Three guarantees are asserted here:
 *   1. Exactly one socket opens for the whole call under healthy conditions
 *      (the pre-warm at call start) — turns after it reuse the same session.
 *   2. A session that dies without ever being handed a turn's text is not
 *      treated as a provider failure: the next turn reconnects transparently
 *      on the same provider, same voice, chain intact.
 *   3. A turn that produces no text at all still releases the ttsDone waiter
 *      instead of stalling.
 */

type SessionRecord = {
  provider: string | undefined;
  voiceId: string | undefined;
  dead: boolean;
};
let sessionOpens: SessionRecord[] = [];
/** Providers whose session reports failure before any turn is ever started on
 * it — models an immediate connect rejection / idle close between turns. */
let failOnConnectProviders = new Set<string>();
/** Providers that fail only once a turn has sent text: a genuine synthesis
 * fault, which must still fail over. */
let failAfterTextProviders = new Set<string>();

let lastOnTranscript:
  | ((params: { text: string; isFinal: boolean; speechFinal: boolean }) => void)
  | null = null;

/** Resolved by the test to release a turn that is "waiting on a tool call",
 * reproducing the dead air the socket used to idle through. */
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
  select: () => ({
    from: (table: unknown) => chain(getTableName(table) === "calls" ? [callRow] : []),
  }),
  insert: () => chain([]),
  update: () => chain([]),
  execute: async () => [],
};

// ADR-116 addendum: org-queries.ts (getEffectiveFlags, called from stream.ts)
// imports both `db` and `dbBackground` — both must resolve here.
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
  // Session-based reuse (Phase C1) — one call per actual new socket, not per
  // turn. `startTurn` is what a per-turn `attemptTts` invokes.
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
    const failsOnFirstUse = failOnConnectProviders.has(String(provider));
    const failsAfterText = failAfterTextProviders.has(String(provider));
    return {
      provider,
      session: {
        startTurn(onAudioChunk: (b: string) => void, onDone?: () => void, onError?: (e: unknown) => void) {
          if (failsOnFirstUse) {
            // Synchronously, before startTurn has even returned — the
            // hostile ordering the TDZ guard in stream.ts exists for (a real
            // provider is free to report an idle-timeout close the instant
            // it's asked to do anything, before any text was ever sent).
            onError?.(new Error(`simulated ${provider} idle close (code 1000)`));
          }
          return {
            sendText: () => {
              if (failsAfterText) {
                queueMicrotask(() => onError?.(new Error(`simulated ${provider} synthesis failure`)));
                return;
              }
              onAudioChunk(Buffer.from(`audio-from-${provider}`).toString("base64"));
            },
            endTurn: () => onDone?.(),
            close: () => {
              record.dead = true;
            },
          };
        },
        // Looks open right up until a turn actually tries it and discovers
        // the idle-timeout — matches isOpen() being a live readyState check
        // in the real providers, not something that predicts a future close.
        isOpen: () => !record.dead,
        close: () => {
          record.dead = true;
        },
      },
    };
  },
  // One-shot shape — still used by warmFillerCache (flag-gated off in this
  // test) and stream.ts statically imports it, so it must exist regardless.
  connectTts: () => ({
    sendText: () => {},
    endTurn: () => {},
    close: () => {},
  }),
  resolveTtsProvider: (override?: string | null) => override ?? "cartesia",
}));

mock.module("./agent", () => ({
  // ADR-115: stream.ts composes the call-control layer again when a call
  // turns out to be unable to hand off, so the mocked module has to expose
  // this export too. These configs carry no `promptInputs`, so the
  // recomposition is skipped and only the override block is appended.
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
  // Models the real shape of a tool-using turn: the LLM emits nothing until a
  // tool round-trip completes, THEN streams its text.
  runVoiceAgentTurn: async ({ onTextDelta }: { onTextDelta?: (d: string) => void }) => {
    if (releaseTurn) {
      await new Promise<void>((resolve) => {
        releaseTurn = resolve;
      });
    }
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
  failOnConnectProviders = new Set();
  failAfterTextProviders = new Set();
  lastOnTranscript = null;
  releaseTurn = null;
});

describe("TTS session reuse across turns (Phase C1) and the idle-close carve-out (ADR-083)", () => {
  it("opens exactly one socket for the whole call — later turns reuse it, including one that waits on a tool round-trip", async () => {
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();
    await handlers.onMessage(START_EVENT, ws);
    await settle();

    // The greeting is served by the pre-warmed session opened at call start.
    expect(sessionOpens.length).toBe(1);
    expect(sessionOpens[0]).toMatchObject({ provider: "cartesia", voiceId: "cartesia-voice-uuid" });

    // Arm the "waiting on a tool" turn, then let the caller speak.
    releaseTurn = () => {};
    lastOnTranscript?.({ text: "what is my order status", isFinal: true, speechFinal: true });
    await settle();

    // Still mid-tool-call, no text produced yet — no new socket, same as
    // before this change (the reuse doesn't make this guarantee weaker: a
    // socket that opened too early still risks an idle-timeout kill).
    expect(sessionOpens.length).toBe(1);

    // Tool returns, text streams — served by the SAME session, not a new one.
    releaseTurn?.();
    await settle();
    expect(sessionOpens.length).toBe(1);

    handlers.onClose();
  });

  it("treats a session that died before this turn's text as an idle close, not a provider failure — reconnects on the same provider", async () => {
    // The pre-warmed session for cartesia is dead on arrival (models an idle
    // timeout that fired between the greeting and this turn).
    failOnConnectProviders.add("cartesia");

    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();
    await handlers.onMessage(START_EVENT, ws);
    await settle();

    // Every session opened (the dead pre-warm, and every reconnect after it)
    // stays on the configured provider and voice — the old code would have
    // shifted "elevenlabs" off the chain and stuck the rest of the call on
    // its default voice.
    expect(sessionOpens.length).toBeGreaterThanOrEqual(1);
    for (const s of sessionOpens) {
      expect(s.provider).toBe("cartesia");
      expect(s.voiceId).toBe("cartesia-voice-uuid");
    }
    expect(sessionOpens.some((s) => s.provider === "elevenlabs")).toBe(false);

    handlers.onClose();
  });

  it("still fails over when the provider breaks after text was sent", async () => {
    // Regression guard: the idle-close carve-out must not swallow real faults.
    failAfterTextProviders.add("cartesia");

    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();
    await handlers.onMessage(START_EVENT, ws);
    await settle();

    expect(sessionOpens.length).toBeGreaterThanOrEqual(2);
    expect(sessionOpens[0]).toMatchObject({ provider: "cartesia", voiceId: "cartesia-voice-uuid" });
    expect(sessionOpens[1]?.provider).toBe("elevenlabs");
    expect(sessionOpens[1]?.voiceId).toBeUndefined();

    handlers.onClose();
  });

  it("does not stall the turn when it ends without ever producing text", async () => {
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();
    await handlers.onMessage(START_EVENT, ws);
    await settle();
    const afterGreeting = sessionOpens.length;

    // A turn that resolves with no deltas at all: endTurn() runs against a
    // connection that was never created. It must release the ttsDone waiter
    // rather than leaving the turn to burn its full 8s timeout.
    const started = Date.now();
    lastOnTranscript?.({ text: "hello", isFinal: true, speechFinal: true });
    await settle();

    expect(Date.now() - started).toBeLessThan(2000);
    expect(sessionOpens.length).toBeGreaterThanOrEqual(afterGreeting);

    handlers.onClose();
  });
});
