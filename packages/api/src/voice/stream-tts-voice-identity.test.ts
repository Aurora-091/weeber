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

type TtsCall = {
  provider: string | undefined;
  voiceId: string | undefined;
  language: string | undefined;
};
let ttsCalls: TtsCall[] = [];
/** Providers whose connection reports a failure before emitting any audio. */
let failingTtsProviders = new Set<string>();

let lastOnTranscript:
  | ((params: { text: string; isFinal: boolean; speechFinal: boolean }) => void)
  | null = null;

let agentFlags: Record<string, boolean> = {};
let literalGreetingTemplate: string | undefined;
/** Stage 5 (2026-09-05): opt-in per-provider voice mapping — see
 * tts-voice-identity.ts. Undefined in every test above, so this file's
 * existing coverage of the fail-open default is unaffected. */
let voiceIdsByProvider: Partial<Record<string, string>> | undefined;

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
  connectTts: (
    onAudioChunk: (base64Audio: string) => void,
    onDone?: () => void,
    onError?: (err: unknown) => void,
    providerOverride?: string | null,
    voiceId?: string,
    language?: string,
  ) => {
    const provider = providerOverride ?? undefined;
    ttsCalls.push({ provider: provider ?? undefined, voiceId, language });
    const failing = failingTtsProviders.has(String(provider));
    if (failing) {
      // Real providers fail asynchronously; a microtask keeps the ordering
      // deterministic while still landing after stream.ts has assigned the
      // connection it just created.
      queueMicrotask(() => onError?.(new Error(`simulated ${provider} failure`)));
    }
    return {
      sendText: () => {
        // A failing provider is failing *before any audio played* — that is the
        // only condition stream.ts fails over on.
        if (!failing) onAudioChunk(Buffer.from(`audio-from-${provider}`).toString("base64"));
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
    // The pair that matters: a Cartesia voice ID belonging to Cartesia.
    ttsProvider: "cartesia",
    voiceId: "cartesia-voice-uuid",
    voiceIdsByProvider,
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
  ttsCalls = [];
  failingTtsProviders = new Set();
  lastOnTranscript = null;
  agentFlags = {};
  literalGreetingTemplate = undefined;
  voiceIdsByProvider = undefined;
  clearTtsCacheForTests();
});

describe("TTS failover keeps one voice identity per call", () => {
  it("never hands the configured voice ID to the provider it failed over to", async () => {
    failingTtsProviders.add("cartesia");
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();

    await handlers.onMessage(START_EVENT, ws);
    await settle();

    expect(ttsCalls.length).toBeGreaterThanOrEqual(2);
    // The primary gets the voice it was configured with...
    expect(ttsCalls[0]).toMatchObject({ provider: "cartesia", voiceId: "cartesia-voice-uuid" });
    // ...and the fallback gets NO voice ID, so it uses its own default voice
    // instead of a Cartesia UUID it cannot resolve.
    expect(ttsCalls[1]?.provider).toBe("elevenlabs");
    expect(ttsCalls[1]?.voiceId).toBeUndefined();

    handlers.onClose();
  });

  it("keeps the failed-over provider for the rest of the call instead of flipping back", async () => {
    failingTtsProviders.add("cartesia");
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();

    await handlers.onMessage(START_EVENT, ws);
    await settle();
    const turnsAfterGreeting = ttsCalls.length;
    expect(ttsCalls[turnsAfterGreeting - 1]?.provider).toBe("elevenlabs");

    // Caller speaks -> a new turn. It must stay on the provider the caller is
    // already hearing, not restart from the (still configured) primary.
    lastOnTranscript?.({ text: "yes that is correct", isFinal: true, speechFinal: true });
    await settle();

    const newCalls = ttsCalls.slice(turnsAfterGreeting);
    expect(newCalls.length).toBeGreaterThanOrEqual(1);
    for (const call of newCalls) {
      expect(call.provider).toBe("elevenlabs");
      expect(call.voiceId).toBeUndefined();
    }
    // The primary is never re-dialled after the failover.
    expect(newCalls.some((c) => c.provider === "cartesia")).toBe(false);

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

    expect(ttsCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of ttsCalls) {
      expect(call).toMatchObject({ provider: "cartesia", voiceId: "cartesia-voice-uuid", language: "en" });
    }

    handlers.onClose();
  });
});

/**
 * Voice-pipeline hardening plan, Stage 5 (2026-09-05) — an agent that opts
 * into `voiceIdsByProvider` keeps a real, consistent voice across a failover
 * instead of the fail-open default above (no ID => the fallback provider's
 * platform-default voice, a different person to the caller).
 */
describe("TTS failover uses the Stage 5 per-provider voice map when an agent has configured one", () => {
  it("hands the fallback provider its mapped voice ID instead of none at all", async () => {
    voiceIdsByProvider = { cartesia: "cartesia-voice-uuid", elevenlabs: "el-mapped-voice" };
    failingTtsProviders.add("cartesia");

    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();
    await handlers.onMessage(START_EVENT, ws);
    await settle();

    expect(ttsCalls.length).toBeGreaterThanOrEqual(2);
    expect(ttsCalls[0]).toMatchObject({ provider: "cartesia", voiceId: "cartesia-voice-uuid" });
    // Previously undefined (this file's first test) — now the agent's own
    // configured ElevenLabs voice, not ElevenLabs' platform default.
    expect(ttsCalls[1]).toMatchObject({ provider: "elevenlabs", voiceId: "el-mapped-voice" });

    handlers.onClose();
  });

  it("falls back to no voice ID for a provider missing from the map, same as an agent with no map at all", async () => {
    voiceIdsByProvider = { cartesia: "cartesia-voice-uuid" }; // no elevenlabs entry
    failingTtsProviders.add("cartesia");

    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();
    await handlers.onMessage(START_EVENT, ws);
    await settle();

    expect(ttsCalls[1]?.provider).toBe("elevenlabs");
    expect(ttsCalls[1]?.voiceId).toBeUndefined();

    handlers.onClose();
  });
});
