import { mock, describe, it, expect, beforeEach, afterEach, jest } from "bun:test";

/**
 * A4 (phase-a-integrity.md), exit-gate condition 3: "A callback-requested
 * disposition with no scheduled_calls row is impossible, asserted by the A4
 * test." `tools/setDisposition.test.ts` covers the tool's own scheduling
 * attempt; this covers stream.ts's side of the contract — that a call whose
 * disposition tool reported `callbackScheduled: false` (or omitted the field
 * entirely) is caught at finalize and recorded as a guardrail event, rather
 * than silently finalizing as if the promise had been kept.
 *
 * Mocking pattern lifted from stream-capture-timing.test.ts.
 */

let dbUpdates: { table: string | undefined; values: Record<string, unknown> }[] = [];
let dbInserts: { table: string | undefined; values: Record<string, unknown> }[] = [];

function getTableName(table: unknown): string | undefined {
  if (!table) return undefined;
  const sym = Object.getOwnPropertySymbols(table).find((s) => s.toString() === "Symbol(drizzle:Name)");
  return sym ? (table as Record<symbol, string>)[sym] : undefined;
}

function chain(
  rows: unknown[],
  onValues?: (values: Record<string, unknown>) => void,
  onInsert?: (values: Record<string, unknown>) => void,
): Promise<unknown[]> & Record<string, unknown> {
  const p = Promise.resolve(rows) as Promise<unknown[]> & Record<string, unknown>;
  for (const method of ["where", "limit", "returning", "onConflictDoNothing", "onConflictDoUpdate"]) {
    p[method] = () => chain(rows, onValues, onInsert);
  }
  p.values = (values: Record<string, unknown>) => {
    onInsert?.(values);
    return chain(rows, onValues, onInsert);
  };
  p.set = (values: Record<string, unknown>) => {
    onValues?.(values);
    return chain(rows, onValues, onInsert);
  };
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
  insert: (table: unknown) => {
    const name = getTableName(table);
    return chain([{ id: 1 }], undefined, (values) => dbInserts.push({ table: name, values }));
  },
  update: (table: unknown) => {
    const name = getTableName(table);
    return chain([], (values) => dbUpdates.push({ table: name, values }));
  },
  execute: async () => [],
};

mock.module("../database", () => ({ db: dbLike, dbBackground: dbLike }));

let lastOnTranscript: ((p: { text: string; isFinal: boolean; speechFinal: boolean }) => void) | null = null;

mock.module("./stt", () => ({
  connectStt: (onTranscript: NonNullable<typeof lastOnTranscript>) => ({
    __capture: (lastOnTranscript = onTranscript),
    sendAudio: () => {},
    getStats: () => ({ reconnectCount: 0, totalGapMs: 0 }),
    close: () => {},
  }),
  resolveSttProvider: (override?: string | null) => override ?? "deepgram",
}));

mock.module("./tts", () => ({
  connectTts: (onAudioChunk: (b: string) => void, onDone?: () => void) => ({
    sendText: (text: string) => onAudioChunk(Buffer.from(text).toString("base64")),
    endTurn: () => onDone?.(),
    close: () => {},
  }),
  // Session-based reuse (Phase C1) — stream.ts's main speak() path now goes
  // through this instead of connectTts above. Not under test here, so it's
  // a minimal always-succeeds session.
  connectTtsSession: (providerOverride?: string | null, _voiceId?: string, _language?: string, onConnected?: (ms: number) => void) => {
    onConnected?.(0);
    return {
      provider: providerOverride ?? "cartesia",
      session: {
        startTurn: (onAudioChunk: (b: string) => void, onDone?: () => void) => ({
          sendText: (text: string) => onAudioChunk(Buffer.from(text).toString("base64")),
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

/** What the mocked turn does besides speak — set per test. Only the regular
 * (post-transcript) turn actually receives `onToolCall` from stream.ts;
 * the greeting turn does not wire it at all. */
let onAgentTurn: ((onToolCall: (name: string, input: unknown, output: unknown) => void) => void) | null = null;

mock.module("./agent", () => {
  const run = async ({
    onTextDelta,
    onToolCall,
  }: {
    onTextDelta?: (d: string) => void;
    onToolCall?: (name: string, input: unknown, output: unknown) => void;
  }) => {
    if (onToolCall && onAgentTurn) onAgentTurn(onToolCall);
    onTextDelta?.("Got it, thanks.");
    return "Got it, thanks.";
  };
  return {
    composeSystemPrompt: (opts: { jobDescription: string }) => ({ text: opts.jobDescription, segments: [] }),
    hasExhaustedField: () => false,
    resolveAgentConfig: async () => ({
      systemPrompt: "You are a test agent.",
      ttsProvider: "cartesia",
      voiceId: undefined,
      llmProvider: "gateway",
      sttProvider: "deepgram",
      language: "en",
    }),
    runVoiceAgentGreeting: run,
    runVoiceAgentTurn: run,
  };
});

mock.module("./twilio-client", () => ({
  twilioClient: {},
  getWsUrl: () => "wss://api.weeber.test",
  getPublicUrl: () => "https://api.weeber.test",
  getTwilioClientForOrg: async () => ({
    calls: () => ({ update: async () => ({}) }),
  }),
}));

mock.module("./org-queries", () => ({
  getEffectiveFlags: async () => ({}),
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

async function flush(ticks = 200) {
  for (let i = 0; i < ticks; i++) await Promise.resolve();
}

function guardrailInserts() {
  return dbInserts.filter((i) => i.table === "guardrail_events");
}

beforeEach(() => {
  jest.useFakeTimers();
  dbUpdates = [];
  dbInserts = [];
  onAgentTurn = null;
  lastOnTranscript = null;
});

afterEach(() => {
  jest.useRealTimers();
  onAgentTurn = null;
});

describe("A4 — a callback-requested disposition with no scheduled_calls row is a recorded defect", () => {
  it("logs an undelivered-outcome guardrail event when the disposition tool reports callbackScheduled: false", async () => {
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();

    await handlers.onMessage(START_EVENT, ws);
    await flush();

    onAgentTurn = (onToolCall) => {
      // Simulates createSetDispositionTool's own execute() having already
      // tried and failed to schedule the callback (e.g. a DB error) — the
      // same output shape stream.ts's logToolCall reads callbackScheduled off.
      onToolCall(
        "setDisposition",
        { disposition: "callback-requested" },
        { recorded: true, disposition: "callback-requested", sentiment: null, notes: null, callbackScheduled: false },
      );
    };
    lastOnTranscript?.({ text: "please call me back tomorrow", isFinal: true, speechFinal: true });
    await flush();

    handlers.onClose();
    await flush();

    const rows = guardrailInserts();
    expect(rows).toHaveLength(1);
    expect(rows[0].values).toMatchObject({
      category: "undelivered-outcome",
      source: "setDisposition-invariant",
    });
  });

  it("logs nothing when the callback was actually scheduled", async () => {
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();

    await handlers.onMessage(START_EVENT, ws);
    await flush();

    onAgentTurn = (onToolCall) => {
      onToolCall(
        "setDisposition",
        { disposition: "callback-requested" },
        { recorded: true, disposition: "callback-requested", sentiment: null, notes: null, callbackScheduled: true },
      );
    };
    lastOnTranscript?.({ text: "please call me back tomorrow", isFinal: true, speechFinal: true });
    await flush();

    handlers.onClose();
    await flush();

    expect(guardrailInserts()).toHaveLength(0);
  });

  it("logs nothing for a disposition that never promised a callback", async () => {
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();

    await handlers.onMessage(START_EVENT, ws);
    await flush();

    onAgentTurn = (onToolCall) => {
      onToolCall(
        "setDisposition",
        { disposition: "not-interested" },
        { recorded: true, disposition: "not-interested", sentiment: null, notes: null },
      );
    };
    lastOnTranscript?.({ text: "not interested, thanks", isFinal: true, speechFinal: true });
    await flush();

    handlers.onClose();
    await flush();

    expect(guardrailInserts()).toHaveLength(0);
  });
});
