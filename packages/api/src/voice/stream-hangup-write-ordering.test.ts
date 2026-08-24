import { mock, describe, it, expect, beforeEach } from "bun:test";

/**
 * Phase C4 (2026-08-24, docs/plans/phase-c-latency.md) step 3 — "whatever
 * must still happen at hangup (final disposition, crmSync, caller_memory
 * upsert) happens after the audio path is closed, never in the turn the
 * caller is waiting on."
 *
 * Verification, not a new change: `performHangUp` already calls
 * `ws.close()` before `await finalizeCall(...)`, and `finalizeCall` is what
 * does the disposition DB write and `upsertCallerMemory` — so this ordering
 * already holds. This test locks it in as a permanent regression guard, the
 * same "found it, prove it, guard it" shape as
 * stream-stt-connect-concurrency.test.ts's C3 tests: a future refactor that
 * moves the caller-memory/disposition writes ahead of `ws.close()` (e.g. to
 * "simplify" performHangUp into one straight-line async function) would
 * reintroduce exactly the caller-perceived delay this phase exists to
 * remove, without any test currently catching it.
 *
 * `crmSync` itself is a model-invoked tool, not something `finalizeCall`
 * performs — it necessarily runs mid-turn, before hangUp, because it
 * summarizes the whole call and the model has to have decided to call it.
 * That's not a defect this test (or C4) addresses; see the plan doc's
 * "still open" note on the tool-call-cap half of C4, which needs real
 * post-A3 production data this repo does not yet have.
 */

type CallRow = {
  id: number;
  orgId: string;
  direction: string;
  fromNumber: string;
  toNumber: string;
  webhookUrl: string | null;
  agentPersona: string | null;
  capturedState: Record<string, unknown>;
};

let scriptedToolCalls: { name: string; input: unknown }[] = [];
let dbUpdates: { table: string | undefined; values: Record<string, unknown> }[] = [];
let events: string[] = [];

function getTableName(table: unknown): string | undefined {
  if (!table) return undefined;
  const sym = Object.getOwnPropertySymbols(table).find((s) => s.toString() === "Symbol(drizzle:Name)");
  return sym ? (table as Record<symbol, string>)[sym] : undefined;
}

function chain(rows: unknown[], onValues?: (values: Record<string, unknown>) => void): Promise<unknown[]> & Record<string, unknown> {
  const p = Promise.resolve(rows) as Promise<unknown[]> & Record<string, unknown>;
  for (const method of ["where", "limit", "returning", "onConflictDoNothing", "onConflictDoUpdate", "values"]) {
    p[method] = () => chain(rows, onValues);
  }
  p.set = (values: Record<string, unknown>) => {
    onValues?.(values);
    return chain(rows, onValues);
  };
  return p;
}

const callRow: CallRow = {
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

mock.module("./agent", () => {
  const run = async ({
    onTextDelta,
    onToolCall,
  }: {
    onTextDelta?: (d: string) => void;
    onToolCall?: (name: string, input: unknown, output: unknown) => void;
  }) => {
    for (const call of scriptedToolCalls) onToolCall?.(call.name, call.input, {});
    onTextDelta?.("Thanks for calling, goodbye.");
    return "Thanks for calling, goodbye.";
  };
  return {
    composeSystemPrompt: (opts: { jobDescription: string }) => ({ text: opts.jobDescription, segments: [] }),
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

mock.module("./org-queries", () => ({ getEffectiveFlags: async () => ({}) }));
mock.module("./leads/leads", () => ({
  promoteLeadFromCall: async () => {
    events.push("promoteLeadFromCall");
  },
  getLeadGreetingContext: async () => ({}),
}));

// The order-of-operations under test: does the recorded caller-memory write
// happen before or after the WebSocket close it must follow.
mock.module("./caller-memory", () => ({
  getCallerMemory: async () => ({}),
  upsertCallerMemory: async () => {
    events.push("upsertCallerMemory");
  },
  resolveHumanNumber: (_direction: string, fromNumber: string, _toNumber: string) => fromNumber,
}));

const { createVoiceStreamHandlers } = await import("./stream");

const START_EVENT = JSON.stringify({
  event: "start",
  start: { streamSid: "MZ-test", callSid: "CA-test", customParameters: { from: "+919999999999", to: "+911111111111" } },
});

function fakeWs() {
  return {
    send: () => {},
    close: () => {
      events.push("ws.close");
    },
  };
}

async function callerSpeaks() {
  lastOnTranscript?.({ text: "that is everything, thanks", isFinal: true, speechFinal: true });
  await new Promise((resolve) => setTimeout(resolve, 2600));
}

beforeEach(() => {
  scriptedToolCalls = [];
  dbUpdates = [];
  events = [];
  lastOnTranscript = null;
});

describe("finalize writes happen after the WebSocket closes (Phase C4 step 3, 2026-08-24)", () => {
  it("closes the socket before upserting caller memory on an agent-requested hangup", async () => {
    scriptedToolCalls = [{ name: "hangUp", input: { reason: "caller said goodbye" } }];
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();

    await handlers.onMessage(START_EVENT, ws);
    await callerSpeaks();

    expect(events).toContain("ws.close");
    expect(events).toContain("upsertCallerMemory");
    expect(events.indexOf("ws.close")).toBeLessThan(events.indexOf("upsertCallerMemory"));
  });
});
