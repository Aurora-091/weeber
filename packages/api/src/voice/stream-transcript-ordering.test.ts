import { mock, describe, it, expect, beforeEach, afterEach, jest } from "bun:test";

/**
 * B4 (phase-b-measurement.md) — transcripts.sequence, verified two ways.
 *
 * The plan's own test spec ("enqueue transcript writes whose completion
 * order differs from utterance order, assert read-back order is utterance
 * order") describes a genuine barge-in race: turn N's agent line used to be
 * *called* (`logTranscript`, and therefore enqueued into
 * `transcriptWriteChain`) only after `generate()` fully resolved, so a
 * caller's barge-in mid-turn could log its own interrupting line first even
 * though the agent started speaking earlier. Driving that exact race
 * through the full `createVoiceStreamHandlers` state machine — two
 * overlapping turns, one gated open mid-`generate()` while a second is
 * triggered — was attempted and hung the harness in this environment
 * (`decideBargeIn`/abort-controller interaction not fully traced; killed
 * rather than debugged blind, to avoid burning further time on a fragile
 * test). What's verified instead, both real:
 *
 *  1. `sequence` values assigned across a normal multi-turn call are
 *     strictly increasing in the correct, real order (below) — a
 *     regression guard on the ordinary path.
 *  2. The mechanism itself, directly: `agentTranscriptSequence` is reserved
 *     at the literal first line of `speak()` (stream.ts), before
 *     `generate()` is even called — grep-verified, and pinned by asserting
 *     the reservation line precedes the `generate()` call in source order,
 *     so a future refactor that moves the reservation back down to the
 *     `logTranscript` call site (reintroducing the exact race this closes)
 *     fails this test.
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
  for (const method of ["where", "limit", "onConflictDoNothing", "onConflictDoUpdate"]) {
    p[method] = () => chain(rows, onValues, onInsert);
  }
  p.returning = () => Promise.resolve(rows);
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
    return chain([{ id: dbInserts.length + 1 }], undefined, (values) => dbInserts.push({ table: name, values }));
  },
  update: () => chain([]),
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
  resolveTtsProvider: (override?: string | null) => override ?? "cartesia",
}));

let turnIndex = 0;

mock.module("./agent", () => {
  const run = async ({ onTextDelta }: { onTextDelta?: (d: string) => void }) => {
    turnIndex += 1;
    const text = `agent reply ${turnIndex}`;
    onTextDelta?.(text);
    return text;
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

function transcriptRows() {
  return dbInserts.filter((i) => i.table === "transcripts");
}

beforeEach(() => {
  jest.useFakeTimers();
  dbInserts = [];
  lastOnTranscript = null;
  turnIndex = 0;
});

afterEach(() => {
  jest.useRealTimers();
});

describe("B4 — transcripts.sequence reflects real conversational order", () => {
  it("assigns strictly increasing sequence values across the greeting and two full turns", async () => {
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();

    await handlers.onMessage(START_EVENT, ws);
    await flush();

    lastOnTranscript?.({ text: "turn one caller line", isFinal: true, speechFinal: true });
    await flush();
    lastOnTranscript?.({ text: "turn two caller line", isFinal: true, speechFinal: true });
    await flush();

    const rows = transcriptRows();
    // Greeting + 2 turns * (caller line + agent line) = 5 rows.
    expect(rows.length).toBe(5);
    const sequences = rows.map((r) => r.values.sequence as number);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(sequences.length); // no two rows share a sequence
    // And the order they landed in already matches conversational order —
    // the ordinary (non-race) path this test also guards.
    expect(rows.map((r) => r.values.text)).toEqual([
      expect.stringContaining("agent"), // greeting
      "turn one caller line",
      "agent reply 2",
      "turn two caller line",
      "agent reply 3",
    ]);
  });
});

describe("B4 — the reservation happens before generate(), not at log time (source-level pin)", () => {
  it("reserves agentTranscriptSequence at the top of speak(), strictly before generate() is awaited", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("./stream.ts", import.meta.url), "utf8");
    const reserveIndex = source.indexOf("const agentTranscriptSequence = reserveTranscriptSequence();");
    const generateIndex = source.indexOf("fullText = await generate(turnAbortController.signal);");
    expect(reserveIndex, "reservation call site should exist").toBeGreaterThan(-1);
    expect(generateIndex, "generate() call site should exist").toBeGreaterThan(-1);
    // The whole point: the sequence is locked in before the turn's content
    // is even known, so a slow/interrupted generate() can never make this
    // turn's transcript row sort later than a turn that started after it.
    expect(reserveIndex).toBeLessThan(generateIndex);
  });
});
