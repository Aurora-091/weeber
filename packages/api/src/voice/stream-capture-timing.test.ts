import { mock, describe, it, expect, beforeEach, afterEach, jest } from "bun:test";

/**
 * A3 (phase-a-integrity.md) — the behavioural half of "persist captured
 * state per turn, not at hangup". `capture-timing.test.ts` covers the pure
 * counter; this covers the actual failure mode findings 3/4 describe: a call
 * that captures a fact early and then drops must still have that fact in
 * `calls.capturedState`, because `mergeCapturedField` persists on every
 * merge (not just at hangup) — the defect A3 closes was the *model* batching
 * its captures at the end, not this persistence path, and this test is what
 * would have caught the model-side regression from either direction.
 *
 * Mocking pattern lifted from stream-silence-timeout.test.ts — same
 * mocked db/stt/tts/twilio-client/org-queries/leads modules, real
 * `createVoiceStreamHandlers` state machine.
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

/** Set per-test: what the mocked agent turn does besides speak. `undefined`
 * means "just speak" (used for the greeting turn). */
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

async function flush(ticks = 50) {
  for (let i = 0; i < ticks; i++) await Promise.resolve();
}

/** The most recent `calls.capturedState` this test's mocked db saw written —
 * `mergeCapturedField` is the only thing that sets this column. */
function lastCapturedState(): Record<string, { value: unknown }> | undefined {
  const updates = dbUpdates.filter((u) => u.table === "calls" && "capturedState" in u.values);
  return updates.at(-1)?.values.capturedState as Record<string, { value: unknown }> | undefined;
}

beforeEach(() => {
  jest.useFakeTimers();
  dbUpdates = [];
  dbInserts = [];
  lastOnTranscript = null;
  onAgentTurn = null;
});

afterEach(() => {
  jest.useRealTimers();
  onAgentTurn = null;
});

describe("A3 — captured state survives a call that drops right after an early capture", () => {
  it("persists a fact captured on an early turn even when the call ends with no further turns", async () => {
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();

    await handlers.onMessage(START_EVENT, ws);
    await flush();

    // The caller states the fact on the very first real turn (turn 1 of what
    // could have been a much longer call) — this is the "early" half of
    // finding 3/4: production calls batched everything into their LAST turn
    // instead.
    onAgentTurn = (onToolCall) => {
      onToolCall(
        "captureField",
        { field: "email", value: "a@b.com", heard: "my email is a@b.com" },
        { captured: true, field: "email", value: "a@b.com" },
      );
    };
    lastOnTranscript?.({ text: "my email is a@b.com", isFinal: true, speechFinal: true });
    await flush();

    // No further turns — simulate the call dropping right here (a dead PSTN
    // leg, the caller hanging up mid-conversation): the underlying transport
    // closes without a clean "stop" event. onClose is fire-and-forget (it
    // does not return the finalizeCall promise), so give its async chain
    // room to run.
    handlers.onClose();
    await flush(200);

    expect(lastCapturedState()?.email?.value).toBe("a@b.com");
  });
});
