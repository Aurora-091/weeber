import { mock, describe, it, expect, beforeEach } from "bun:test";

/**
 * D2 (phase-d-conversation.md) — the mechanical fix for the tobacco loop.
 * Drives the real `createVoiceStreamHandlers` state machine through two
 * consecutive caller turns, each ending in a `markFieldUnanswered` tool call
 * for the SAME field (an evasive caller declining the same question twice),
 * and asserts `calls.capturedState`'s persisted `askCount` actually
 * increments — the data `buildKnownFactsBlock`'s cap rendering (see
 * agent.test.ts's D2 describe block) depends on being real, not asserted
 * only at the pure-function level with hand-built fixtures.
 */

type CapturedFieldRow = { value: string | null; heard: string; transcriptId: number | null; turn: number; askCount?: number };

let persistedCapturedStates: Record<string, CapturedFieldRow>[] = [];
let turnCallCount = 0;

const callRow = { id: 1, orgId: "org-1", direction: "inbound", status: "in-progress" };

function chain(rows: unknown[]): Promise<unknown[]> & Record<string, unknown> {
  const p = Promise.resolve(rows) as Promise<unknown[]> & Record<string, unknown>;
  for (const method of ["where", "limit", "orderBy", "returning", "onConflictDoNothing", "onConflictDoUpdate", "from", "values"]) {
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
  update: () => ({
    set: (values: { capturedState?: Record<string, CapturedFieldRow> }) => {
      if (values.capturedState) persistedCapturedStates.push(values.capturedState);
      return chain([]);
    },
  }),
  execute: async () => [],
};

mock.module("../database", () => ({ db: dbLike, dbBackground: dbLike }));

let lastOnTranscript:
  | ((params: { text: string; isFinal: boolean; speechFinal: boolean }) => void)
  | null = null;

mock.module("./stt", () => ({
  connectStt: (onTranscript: NonNullable<typeof lastOnTranscript>) => {
    lastOnTranscript = onTranscript;
    return { sendAudio: () => {}, getStats: () => ({ reconnectCount: 0, totalGapMs: 0 }), close: () => {} };
  },
  resolveSttProvider: (override?: string | null) => override ?? "deepgram",
}));

mock.module("./tts", () => ({
  connectTts: (onAudioChunk: (b: string) => void, onDone?: () => void) => ({
    sendText: () => onAudioChunk(Buffer.from("audio").toString("base64")),
    endTurn: () => onDone?.(),
    close: () => {},
  }),
  connectTtsSession: (providerOverride?: string | null, _voiceId?: string, _language?: string, onConnected?: (ms: number) => void) => {
    onConnected?.(0);
    return {
      provider: providerOverride ?? "cartesia",
      session: {
        startTurn: (onAudioChunk: (b: string) => void, onDone?: () => void) => ({
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

type OnToolCall = (name: string, input: unknown, output: unknown) => void;

mock.module("./agent", () => ({
  composeSystemPrompt: (opts: { jobDescription: string }) => ({ text: opts.jobDescription, segments: [] }),
  resolveAgentConfig: async () => ({
    systemPrompt: "You are a test agent.",
    ttsProvider: "cartesia",
    voiceId: undefined,
    llmProvider: "gateway",
    sttProvider: "deepgram",
    language: "en",
  }),
  runVoiceAgentGreeting: async ({ onTextDelta }: { onTextDelta?: (d: string) => void }) => {
    onTextDelta?.("Hello, this is the agent.");
    return "Hello, this is the agent.";
  },
  // Each turn immediately "calls" markFieldUnanswered for the same field,
  // quoting real words the caller just said (real ADR-120 provenance, not
  // bypassed) so logToolCall's heard-in-caller-speech check genuinely passes.
  runVoiceAgentTurn: async ({ onTextDelta, onToolCall }: { onTextDelta?: (d: string) => void; onToolCall?: OnToolCall }) => {
    turnCallCount += 1;
    onToolCall?.(
      "markFieldUnanswered",
      { field: "tobacco", heard: "rather not talk about that" },
      { field: "tobacco", recorded: true },
    );
    onTextDelta?.("No problem, let's move on.");
    return "No problem, let's move on.";
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
  return { send: () => {}, close: () => {} };
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  persistedCapturedStates = [];
  turnCallCount = 0;
  lastOnTranscript = null;
});

describe("D2 — askCount increments across repeated markFieldUnanswered calls for the same field", () => {
  it("the first evasion is recorded with askCount 1", async () => {
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();
    await handlers.onMessage(START_EVENT, ws);

    void lastOnTranscript?.({ text: "I'd rather not talk about that", isFinal: true, speechFinal: true });
    await settle(30);

    expect(turnCallCount).toBe(1);
    const last = persistedCapturedStates.at(-1);
    expect(last?.tobacco).toMatchObject({ value: null, askCount: 1 });

    handlers.onClose();
  });

  it("a second evasion of the same field increments askCount to 2, not resetting it", async () => {
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();
    await handlers.onMessage(START_EVENT, ws);

    void lastOnTranscript?.({ text: "I'd rather not talk about that", isFinal: true, speechFinal: true });
    await settle(30);
    void lastOnTranscript?.({ text: "I said I'd rather not talk about that", isFinal: true, speechFinal: true });
    await settle(30);

    expect(turnCallCount).toBe(2);
    const last = persistedCapturedStates.at(-1);
    expect(last?.tobacco).toMatchObject({ value: null, askCount: 2 });

    handlers.onClose();
  });
});
