import { mock, describe, it, expect, beforeEach } from "bun:test";
import { getCachedTtsAudio, clearTtsCacheForTests, HYBRID_AUDIO_CACHE_FLAG } from "./tts-cache";

/**
 * Defect: "the agent's voice changes during the call."
 *
 * Two independent causes, both proven here by driving the real stream state
 * machine (`createVoiceStreamHandlers`) with a fake TTS provider that fails
 * before it emits any audio — the exact condition stream.ts's per-turn
 * cross-provider failover exists for:
 *
 * 1. The agent's configured `voiceId` was handed to whatever provider the
 *    failover landed on. Voice IDs are provider-scoped and every adapter falls
 *    back to its own env-default voice on a foreign one (see
 *    tts-voice-identity.ts), so the caller heard a different person.
 * 2. Failover was rebuilt from the primary provider on EVERY turn, so a single
 *    transient error made one turn speak in the fallback's voice and the very
 *    next turn flip straight back to the primary's.
 *
 * Plus the cache consequence: audio a fallback provider produced was stored in
 * the process-global tts-cache under the *primary* provider's key, so canned/
 * filler/backchannel lines later replayed in a voice that didn't match the
 * live turns — for this call and every later call in the process.
 */

// ---- Fakes for the seams stream.ts calls into --------------------------------

type SessionOpen = {
  provider: string | undefined;
  voiceId: string | undefined;
  language: string | undefined;
};
/** One entry per actual new socket (connectTtsSession call), not per turn —
 * Phase C1 reuses one session across turns, so a healthy multi-turn call now
 * opens exactly one. */
let sessionOpens: SessionOpen[] = [];
/** Providers whose session reports a failure before any turn on it ever
 * emits audio. */
let failingTtsProviders = new Set<string>();

let lastOnTranscript:
  | ((params: { text: string; isFinal: boolean; speechFinal: boolean }) => void)
  | null = null;

let agentFlags: Record<string, boolean> = {};
let literalGreetingTemplate: string | undefined;

function getTableName(table: unknown): string | undefined {
  if (!table) return undefined;
  const sym = Object.getOwnPropertySymbols(table).find((s) => s.toString() === "Symbol(drizzle:Name)");
  return sym ? (table as Record<symbol, string>)[sym] : undefined;
}

/** Minimal drizzle query-builder stand-in: a resolved promise carrying every
 * chainable method stream.ts uses, so any select/insert/update shape works. */
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
    language?: string,
    onConnected?: (ms: number) => void,
  ) => {
    const provider = providerOverride ?? "cartesia";
    sessionOpens.push({ provider, voiceId, language });
    onConnected?.(0);
    const failing = failingTtsProviders.has(String(provider));
    let closed = false;
    return {
      provider,
      session: {
        startTurn(onAudioChunk: (b: string) => void, onDone?: () => void, onError?: (e: unknown) => void) {
          if (failing) {
            // Real providers fail asynchronously; a microtask keeps the
            // ordering deterministic while still landing after stream.ts has
            // assigned the connection it just created.
            queueMicrotask(() => onError?.(new Error(`simulated ${provider} failure`)));
          }
          return {
            sendText: () => {
              // A failing provider fails *before any audio played* — that is
              // the only condition stream.ts fails over on.
              if (!failing) onAudioChunk(Buffer.from(`audio-from-${provider}`).toString("base64"));
            },
            endTurn: () => onDone?.(),
            close: () => {
              closed = true;
            },
          };
        },
        // Looks open right up until a turn actually tries it and discovers
        // the failure — matches isOpen() being a live readyState check in
        // the real providers, not something that predicts a future error.
        // A pre-warmed-but-never-used session must still look open; nothing
        // has happened to it yet.
        isOpen: () => !closed,
        close: () => {
          closed = true;
        },
      },
    };
  },
  // One-shot shape — stream.ts statically imports it (warmFillerCache), so it
  // must exist even though this test's flags keep that path off.
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
    // The pair that matters: a Cartesia voice ID belonging to Cartesia.
    ttsProvider: "cartesia",
    voiceId: "cartesia-voice-uuid",
    language: "en",
    literalGreetingTemplate,
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

mock.module("./org-queries", () => ({
  getEffectiveFlags: async () => agentFlags,
}));

// Not under test here, and its real implementation throws on the stubbed DB at
// call-finalize time — noise that would drown the assertions below.
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

/** Lets queued microtasks/timers settle between steps. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

beforeEach(() => {
  sessionOpens = [];
  failingTtsProviders = new Set();
  lastOnTranscript = null;
  agentFlags = {};
  literalGreetingTemplate = undefined;
  clearTtsCacheForTests();
});

describe("TTS failover keeps one voice identity per call", () => {
  it("never hands the configured voice ID to the provider it failed over to", async () => {
    failingTtsProviders.add("cartesia");
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();

    await handlers.onMessage(START_EVENT, ws);
    await settle();

    expect(sessionOpens.length).toBeGreaterThanOrEqual(2);
    // The primary gets the voice it was configured with...
    expect(sessionOpens[0]).toMatchObject({ provider: "cartesia", voiceId: "cartesia-voice-uuid" });
    // ...and the fallback gets NO voice ID, so it uses its own default voice
    // instead of a Cartesia UUID it cannot resolve.
    expect(sessionOpens[1]?.provider).toBe("elevenlabs");
    expect(sessionOpens[1]?.voiceId).toBeUndefined();

    handlers.onClose();
  });

  it("keeps the failed-over provider for the rest of the call instead of flipping back — a new turn reuses the SAME session rather than re-dialling", async () => {
    failingTtsProviders.add("cartesia");
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();

    await handlers.onMessage(START_EVENT, ws);
    await settle();
    const sessionsAfterGreeting = sessionOpens.length;
    expect(sessionOpens[sessionsAfterGreeting - 1]?.provider).toBe("elevenlabs");

    // Caller speaks -> a new turn. Under Phase C1's reuse, staying on the
    // provider the caller is already hearing means opening NO new session at
    // all — the old per-turn-reconnect version of this guarantee was "the
    // new connection is elevenlabs, not cartesia"; the reuse version is
    // "nothing reconnects, because the held elevenlabs session is still open".
    lastOnTranscript?.({ text: "yes that is correct", isFinal: true, speechFinal: true });
    await settle();

    expect(sessionOpens.length).toBe(sessionsAfterGreeting);
    // The primary is never re-dialled after the failover.
    expect(sessionOpens.some((s) => s.provider === "cartesia")).toBe(true); // only the original failed attempt
    expect(sessionOpens.filter((s) => s.provider === "cartesia").length).toBe(1);

    handlers.onClose();
  });

  it("caches audio under the provider that actually produced it", async () => {
    agentFlags = { [HYBRID_AUDIO_CACHE_FLAG]: true };
    literalGreetingTemplate = "Hello there.";
    failingTtsProviders.add("cartesia");

    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();
    await handlers.onMessage(START_EVENT, ws);
    await settle();

    // Stored under the fallback that synthesized it, with no voice ID...
    expect(getCachedTtsAudio("elevenlabs", undefined, "en", "Hello there.")).toBeDefined();
    // ...and NOT under the primary+voice the call was configured with, which is
    // what would later replay a mismatched voice mid-call.
    expect(getCachedTtsAudio("cartesia", "cartesia-voice-uuid", "en", "Hello there.")).toBeUndefined();

    handlers.onClose();
  });

  it("leaves a healthy call on its configured provider and voice", async () => {
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();

    await handlers.onMessage(START_EVENT, ws);
    await settle();
    lastOnTranscript?.({ text: "yes that is correct", isFinal: true, speechFinal: true });
    await settle();

    // A healthy call opens exactly one session (the pre-warm) and reuses it
    // for every turn — this is the point of Phase C1.
    expect(sessionOpens.length).toBe(1);
    expect(sessionOpens[0]).toMatchObject({ provider: "cartesia", voiceId: "cartesia-voice-uuid", language: "en" });

    handlers.onClose();
  });
});
