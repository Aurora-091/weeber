import { mock, describe, it, expect, beforeEach } from "bun:test";

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
  connectTts: (onAudioChunk: (base64Audio: string) => void, onDone?: () => void) => ({
    sendText: () => onAudioChunk(Buffer.from("audio").toString("base64")),
    endTurn: () => onDone?.(),
    close: () => {},
  }),
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
    // Flag off — maybePlayToolCallFiller returns immediately after reading
    // it, before touching any TTS-cache code this test doesn't mock.
    return {};
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
  return { send: () => {}, close: () => {} };
}

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  getEffectiveFlagsCallCount = 0;
  lastOnTranscript = null;
  slowToolCallsThisTurn = 1;
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
