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
 * Two guarantees are asserted here:
 *   1. No socket is opened until the turn actually has text to synthesize.
 *   2. A socket that dies without ever being handed text is not treated as a
 *      provider failure: same provider, same voice, chain intact.
 */

type TtsCall = {
  provider: string | undefined;
  voiceId: string | undefined;
};
let ttsCalls: TtsCall[] = [];
/** Providers that report failure synchronously, inside connectTts itself —
 * i.e. before any text could possibly have been sent. Models an immediate
 * connect rejection / idle close, not a mid-synthesis fault. */
let failOnConnectProviders = new Set<string>();
/** Providers that fail only once text has arrived: a genuine synthesis fault,
 * which must still fail over. */
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

mock.module("../database", () => ({
  db: {
    select: () => ({
      from: (table: unknown) => chain(getTableName(table) === "calls" ? [callRow] : []),
    }),
    insert: () => chain([]),
    update: () => chain([]),
    execute: async () => [],
  },
}));

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
    onError?: (err: unknown) => void,
    providerOverride?: string | null,
    voiceId?: string,
  ) => {
    const provider = providerOverride ?? undefined;
    ttsCalls.push({ provider: provider ?? undefined, voiceId });
    const failsAfterText = failAfterTextProviders.has(String(provider));
    if (failOnConnectProviders.has(String(provider))) {
      // Synchronously, before connectTts has even returned — the hostile
      // ordering the TDZ guard in stream.ts exists for.
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
      close: () => {},
    };
  },
  resolveTtsProvider: (override?: string | null) => override ?? "cartesia",
}));

mock.module("./agent", () => ({
  // ADR-115: stream.ts composes the call-control layer again when a call
  // turns out to be unable to hand off, so the mocked module has to expose
  // this export too. These configs carry no `promptInputs`, so the
  // recomposition is skipped and only the override block is appended.
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
  ttsCalls = [];
  failOnConnectProviders = new Set();
  failAfterTextProviders = new Set();
  lastOnTranscript = null;
  releaseTurn = null;
});

describe("the TTS socket opens on first text, not at the top of the turn (ADR-083)", () => {
  it("opens no socket while a turn is still waiting on its tool round-trip", async () => {
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();
    await handlers.onMessage(START_EVENT, ws);
    await settle();

    const afterGreeting = ttsCalls.length;
    expect(afterGreeting).toBeGreaterThanOrEqual(1);

    // Arm the "waiting on a tool" turn, then let the caller speak.
    releaseTurn = () => {};
    lastOnTranscript?.({ text: "what is my order status", isFinal: true, speechFinal: true });
    await settle();

    // The turn is mid-flight with no text produced yet. Previously a socket was
    // already open here, ticking toward the provider's idle timeout.
    expect(ttsCalls.length).toBe(afterGreeting);

    // Tool returns, text starts streaming — now the socket is opened.
    releaseTurn?.();
    await settle();
    expect(ttsCalls.length).toBe(afterGreeting + 1);
    expect(ttsCalls[afterGreeting]).toMatchObject({
      provider: "cartesia",
      voiceId: "cartesia-voice-uuid",
    });

    handlers.onClose();
  });

  it("treats a socket that died before any text as an idle close, not a provider failure", async () => {
    // Cartesia rejects the first connection outright, before any text.
    failOnConnectProviders.add("cartesia");

    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();
    await handlers.onMessage(START_EVENT, ws);
    await settle();

    // Every attempt stays on the configured provider with the configured voice.
    // The old code would have shifted "elevenlabs" off the chain and stuck the
    // rest of the call on its default voice.
    expect(ttsCalls.length).toBeGreaterThanOrEqual(1);
    for (const call of ttsCalls) {
      expect(call.provider).toBe("cartesia");
      expect(call.voiceId).toBe("cartesia-voice-uuid");
    }
    expect(ttsCalls.some((c) => c.provider === "elevenlabs")).toBe(false);

    handlers.onClose();
  });

  it("still fails over when the provider breaks after text was sent", async () => {
    // Regression guard: the idle-close carve-out must not swallow real faults.
    failAfterTextProviders.add("cartesia");

    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();
    await handlers.onMessage(START_EVENT, ws);
    await settle();

    expect(ttsCalls.length).toBeGreaterThanOrEqual(2);
    expect(ttsCalls[0]).toMatchObject({ provider: "cartesia", voiceId: "cartesia-voice-uuid" });
    expect(ttsCalls[1]?.provider).toBe("elevenlabs");
    expect(ttsCalls[1]?.voiceId).toBeUndefined();

    handlers.onClose();
  });

  it("does not stall the turn when it ends without ever producing text", async () => {
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();
    await handlers.onMessage(START_EVENT, ws);
    await settle();
    const afterGreeting = ttsCalls.length;

    // A turn that resolves with no deltas at all: endTurn() runs against a
    // connection that was never created. It must release the ttsDone waiter
    // rather than leaving the turn to burn its full 8s timeout.
    const started = Date.now();
    lastOnTranscript?.({ text: "hello", isFinal: true, speechFinal: true });
    await settle();

    expect(Date.now() - started).toBeLessThan(2000);
    expect(ttsCalls.length).toBeGreaterThanOrEqual(afterGreeting);

    handlers.onClose();
  });
});
