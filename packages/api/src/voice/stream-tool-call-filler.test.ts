import { mock, describe, it, expect, beforeEach } from "bun:test";
import { getCachedTtsAudio, clearTtsCacheForTests } from "./tts-cache";

/**
 * maybePlayToolCallFiller() (stream.ts) used to call getEffectiveFlags()
 * fresh on every slow-tool-call filler trigger, even though the "start"
 * handler's Promise.all batch had already fetched this call's effective
 * flags a moment earlier — a duplicate DB round-trip on a path that fires
 * mid-turn, not once per call. Fixed by caching the startup batch's result
 * as resolvedFlags/resolvedFlagsReady and having the filler path read that
 * instead, falling back to a direct call only if triggered before setup
 * completes (see stream.ts's doc comment on resolvedFlags).
 *
 * This proves the fix from the outside: drive a real call through
 * createVoiceStreamHandlers, trigger a slow-tool-call filler mid-turn (via
 * the mocked ./agent module invoking onSlowToolCall, the same seam
 * buildVoiceTools' withFillerTimer uses in production), and assert
 * getEffectiveFlags was called exactly once for the whole call — from
 * "start" — not once more per filler trigger.
 */

let getEffectiveFlagsCallCount = 0;

const callRow = { id: 1, orgId: "org_test", direction: "inbound", status: "in-progress" };

/** Same drizzle-chain stub shape as the other stream-*.test.ts files. */
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

let lastOnTranscript: ((params: { text: string; isFinal: boolean; speechFinal: boolean }) => void) | null = null;

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
  // One-shot shape — still used by warmFillerCache, which this test exercises
  // directly (the whole point of maybePlayToolCallFiller's cache warming).
  connectTts: (onAudioChunk: (base64Audio: string) => void, onDone?: () => void) => ({
    sendText: () => onAudioChunk(Buffer.from("audio").toString("base64")),
    endTurn: () => onDone?.(),
    close: () => {},
  }),
  // Session-based reuse (Phase C1) — stream.ts's main speak() path now goes
  // through this instead of connectTts above.
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

/** How many slow-tool-call fillers each turn simulates — proves the fix
 * holds even when the filler fires more than once. */
let slowToolCallsThisTurn = 1;

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
  // Simulates buildVoiceTools' withFillerTimer firing partway through a slow
  // tool call — the real trigger for maybePlayToolCallFiller in production.
  runVoiceAgentTurn: async ({
    onTextDelta,
    onSlowToolCall,
  }: {
    onTextDelta?: (d: string) => void;
    onSlowToolCall?: (toolName: string) => void;
  }) => {
    for (let i = 0; i < slowToolCallsThisTurn; i++) onSlowToolCall?.("lookupInfo");
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
  getEffectiveFlags: async () => {
    getEffectiveFlagsCallCount += 1;
    // D4 (2026-08-25): an absent hybrid-audio-cache row now reads as ON
    // (was off before that flip), so maybePlayToolCallFiller proceeds into
    // the cache lookup instead of returning immediately — harmless here
    // since this test only asserts getEffectiveFlags call-count dedup, not
    // filler content, and the mocked ./tts's connectTts covers
    // warmFillerCache's one-shot warm path either way.
    return agentFlagsOverride ?? {};
  },
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

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

let agentFlagsOverride: Record<string, boolean> | undefined;

beforeEach(() => {
  getEffectiveFlagsCallCount = 0;
  lastOnTranscript = null;
  slowToolCallsThisTurn = 1;
  agentFlagsOverride = undefined;
  clearTtsCacheForTests();
});

describe("maybePlayToolCallFiller reuses the call-start effective flags (2026-08-20)", () => {
  it("does not issue a new getEffectiveFlags query when a slow-tool-call filler fires", async () => {
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();
    await handlers.onMessage(START_EVENT, ws);
    await settle();

    // The "start" handler's own startup batch is the only expected call.
    expect(getEffectiveFlagsCallCount).toBe(1);

    lastOnTranscript?.({ text: "what is my order status", isFinal: true, speechFinal: true });
    await settle();
    handlers.onClose();

    // The slow-tool-call filler fired (mocked runVoiceAgentTurn always
    // calls onSlowToolCall once) and must not have added a second query.
    expect(getEffectiveFlagsCallCount).toBe(1);
  });

  it("still issues only one query even when the filler fires more than once in a turn", async () => {
    slowToolCallsThisTurn = 3;
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();
    await handlers.onMessage(START_EVENT, ws);
    await settle();

    lastOnTranscript?.({ text: "what is my order status", isFinal: true, speechFinal: true });
    await settle();
    handlers.onClose();

    expect(getEffectiveFlagsCallCount).toBe(1);
  });
});

/**
 * D4 (phase-d-conversation.md, 2026-08-25) — hybrid-audio-cache flipped from
 * opt-in to opt-out: an absent `feature_flags` row (production's actual
 * state — the table is empty) now means the filler is ON, not off. An
 * explicit `enabled: false` row is still the kill switch. The first
 * slow-tool-call trigger only warms the cache (nothing cached yet to send);
 * the second, one turn later, should find a hit and actually forward audio.
 */
const FILLER_TEXTS = ["One moment.", "Just a second."];
function anyFillerCached(): boolean {
  return FILLER_TEXTS.some((text) => getCachedTtsAudio("cartesia", "cartesia-voice-uuid", "en", text) !== undefined);
}

describe("hybrid-audio-cache default flip (D4, 2026-08-25)", () => {
  it("with no flags row at all, a slow tool call warms and then uses the filler cache", async () => {
    agentFlagsOverride = undefined; // {} from the mock above — the real production shape
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();
    await handlers.onMessage(START_EVENT, ws);
    await settle();

    // First trigger: nothing cached yet, so this only warms it.
    lastOnTranscript?.({ text: "what is my order status", isFinal: true, speechFinal: true });
    await settle();
    expect(anyFillerCached()).toBe(true);

    // Second trigger, one turn later: the warm from turn 1 is now a hit,
    // so the filler actually gets forwarded to the caller.
    const sentBeforeSecondTurn = ws.sent.length;
    lastOnTranscript?.({ text: "and what about the refund", isFinal: true, speechFinal: true });
    await settle();
    handlers.onClose();

    expect(ws.sent.length).toBeGreaterThan(sentBeforeSecondTurn);
  });

  it("an explicit enabled: false still suppresses the filler — the kill switch survives the default flip", async () => {
    agentFlagsOverride = { "hybrid-audio-cache": false };
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();
    await handlers.onMessage(START_EVENT, ws);
    await settle();

    lastOnTranscript?.({ text: "what is my order status", isFinal: true, speechFinal: true });
    await settle();
    lastOnTranscript?.({ text: "and what about the refund", isFinal: true, speechFinal: true });
    await settle();
    handlers.onClose();

    // Never even warmed, let alone sent — maybePlayToolCallFiller returns
    // before touching the cache at all when the flag is explicitly off.
    expect(anyFillerCached()).toBe(false);
  });
});
