import { mock, describe, it, expect, beforeEach, afterEach, jest } from "bun:test";

/**
 * A5 (phase-a-integrity.md) — stream.ts's wiring of the unsourced-claim
 * detector (unsourced-claim-guard.test.ts covers the pure detector itself).
 * This confirms `speak()` actually runs it against a turn's assembled text
 * and writes the guardrail_events row — using the greeting turn, since
 * `detectUnsourcedPriceClaims` only needs the spoken text, not a tool call.
 *
 * Mocking pattern lifted from stream-capture-timing.test.ts.
 */

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
  update: () => chain([]),
  execute: async () => [],
};

mock.module("../database", () => ({ db: dbLike, dbBackground: dbLike }));

mock.module("./stt", () => ({
  connectStt: () => ({
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
  resolveTtsProvider: (override?: string | null) => override ?? "cartesia",
}));

/** What the mocked greeting says — set per test. */
let greetingText = "Sure, happy to help.";

mock.module("./agent", () => {
  const run = async ({ onTextDelta }: { onTextDelta?: (d: string) => void }) => {
    onTextDelta?.(greetingText);
    return greetingText;
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

async function flush(ticks = 100) {
  for (let i = 0; i < ticks; i++) await Promise.resolve();
}

function unsourcedClaimInserts() {
  return dbInserts.filter((i) => i.table === "guardrail_events" && i.values.category === "unsourced-claim");
}

beforeEach(() => {
  jest.useFakeTimers();
  dbInserts = [];
});

afterEach(() => {
  jest.useRealTimers();
});

describe("A5 — stream.ts logs an unsourced-claim guardrail event for a spoken turn", () => {
  it("writes the row when the agent's greeting states an unsourced cost figure", async () => {
    greetingText = "Cremation services typically run between five thousand and eight thousand dollars.";
    const handlers = createVoiceStreamHandlers("twilio");
    await handlers.onMessage(START_EVENT, fakeWs());
    await flush();

    const rows = unsourcedClaimInserts();
    expect(rows).toHaveLength(1);
    expect(rows[0].values).toMatchObject({
      callId: 1,
      orgId: "org_test",
      category: "unsourced-claim",
      source: "unsourced-claim-detector",
    });
    expect(String(rows[0].values.detail)).toContain("five thousand and eight thousand dollars");
  });

  it("writes nothing for an ordinary greeting", async () => {
    greetingText = "Hi there, thanks for calling — how can I help today?";
    const handlers = createVoiceStreamHandlers("twilio");
    await handlers.onMessage(START_EVENT, fakeWs());
    await flush();

    expect(unsourcedClaimInserts()).toHaveLength(0);
  });
});
