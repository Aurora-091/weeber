import { mock, describe, it, expect, beforeEach } from "bun:test";

/**
 * Defect (ADR-107): "TTS is 93% of our turn latency" — it was not. The
 * dashboard said so because `ttsFirstByteMs` was measured from the top of
 * speak(), which happens BEFORE generate() has produced a single token. The
 * whole LLM stage was therefore billed to TTS, and `llmTtftMs` +
 * `ttsFirstByteMs` double-counted it instead of decomposing the turn.
 *
 * The production tell, on every real row: `voiceToVoiceMs - ttsFirstByteMs`
 * sat at a near-constant ~127ms while `llmTtftMs` swung between 1.6s and
 * 3.6s. A genuine TTS measurement cannot be that rigidly coupled to LLM time.
 *
 * This test reproduces the shape that exposed it: an LLM that stalls before
 * emitting its first delta, in front of a TTS that answers instantly. Under
 * the old anchor, ttsFirstByteMs would swallow the stall. The guarantees:
 *
 *   1. ttsFirstByteMs measures only the TTS stage — it excludes LLM time.
 *   2. voiceToVoiceMs is unchanged in meaning and value: caller stopped
 *      talking -> first audio byte out. It still covers the LLM stall.
 *   3. The two component metrics no longer overlap: they are additive within
 *      the voice-to-voice budget rather than each containing the LLM.
 */

/** How long the mocked LLM stalls before its first text delta. Chosen well
 * above the mocked TTS's ~0ms response so the two stages are unambiguously
 * separable in the assertions below. */
const LLM_STALL_MS = 120;

type TurnLatencyRow = {
  callId?: number;
  turnIndex?: number;
  llmTtftMs?: number;
  ttsFirstByteMs?: number;
  voiceToVoiceMs?: number;
};

let turnLatencyRows: TurnLatencyRow[] = [];

const callRow = { id: 1, orgId: "org-1", direction: "inbound", status: "in-progress" };

/** Same drizzle-chain stub shape as stream-tts-lazy-connect.test.ts: built on
 * a real Promise rather than a hand-rolled thenable, so `await`ing a query
 * behaves and lint's no-thenable rule stays satisfied. */
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
  // Capture only turn_latency inserts; everything else behaves as before.
  insert: (table: unknown) => {
    const c = chain([]);
    if (getTableName(table) === "turn_latency") {
      c.values = (row: TurnLatencyRow) => {
        turnLatencyRows.push(row);
        return chain([]);
      };
    }
    return c;
  },
  update: () => chain([]),
  execute: async () => [],
};

// ADR-116 addendum: org-queries.ts (getEffectiveFlags, called from stream.ts)
// imports both `db` and `dbBackground` — both must resolve here.
mock.module("../database", () => ({ db: dbLike, dbBackground: dbLike }));

let lastOnTranscript:
  | ((params: { text: string; isFinal: boolean; speechFinal: boolean }) => void)
  | null = null;

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

// TTS answers immediately: first audio byte lands in the same tick the first
// character reaches it. Any meaningful ttsFirstByteMs is therefore time the
// measurement wrongly absorbed from somewhere else.
mock.module("./tts", () => ({
  connectTts: (onAudioChunk: (base64Audio: string) => void, onDone?: () => void) => ({
    sendText: () => onAudioChunk(Buffer.from("audio").toString("base64")),
    endTurn: () => onDone?.(),
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
  // The defect's shape: dead time before the first token, then instant text.
  runVoiceAgentTurn: async ({
    onTextDelta,
    onLatency,
  }: {
    onTextDelta?: (d: string) => void;
    onLatency?: (ms: number) => void;
  }) => {
    await new Promise((resolve) => setTimeout(resolve, LLM_STALL_MS));
    onLatency?.(LLM_STALL_MS);
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

mock.module("./org-queries", () => ({ getEffectiveFlags: async () => ({}) }));
mock.module("./leads/leads", () => ({
  promoteLeadFromCall: async () => undefined,
  getLeadGreetingContext: async () => ({}),
}));

const { createVoiceStreamHandlers } = await import("./stream");

const START_EVENT = JSON.stringify({
  event: "start",
  start: {
    streamSid: "MZ-test",
    callSid: "CA-test",
    customParameters: { from: "+919999999999", to: "+911111111111" },
  },
});

function fakeWs() {
  const sent: string[] = [];
  return { sent, send: (data: string) => sent.push(data), close: () => {} };
}

const settle = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  turnLatencyRows = [];
  lastOnTranscript = null;
});

/** Drive one caller turn end-to-end and return its persisted latency row. */
async function captureCallerTurn(): Promise<TurnLatencyRow> {
  const handlers = createVoiceStreamHandlers("twilio");
  const ws = fakeWs();
  await handlers.onMessage(START_EVENT, ws);
  await settle();

  const beforeTurn = turnLatencyRows.length;
  lastOnTranscript?.({ text: "what is my order status", isFinal: true, speechFinal: true });
  await settle(LLM_STALL_MS + 80);

  const row = turnLatencyRows[beforeTurn];
  handlers.onClose();
  expect(row).toBeDefined();
  return row as TurnLatencyRow;
}

describe("turn latency is attributed to the stage that actually spent it (ADR-107)", () => {
  it("excludes LLM time from ttsFirstByteMs", async () => {
    const row = await captureCallerTurn();

    expect(row.ttsFirstByteMs).toBeDefined();
    // The mocked TTS replies in the same tick it is handed text, so its real
    // cost is ~0. Under the old top-of-speak() anchor this would have been
    // >= LLM_STALL_MS. Half the stall is a generous ceiling that still fails
    // loudly if the anchor ever regresses, without being flaky on a slow box.
    expect(row.ttsFirstByteMs).toBeLessThan(LLM_STALL_MS / 2);
  });

  it("keeps voiceToVoiceMs measuring the caller's full wait, LLM stall included", async () => {
    const row = await captureCallerTurn();

    // Unchanged contract: this is the number the caller actually experiences,
    // and it must still contain the LLM stage even though ttsFirstByteMs no
    // longer does.
    expect(row.voiceToVoiceMs).toBeDefined();
    expect(row.voiceToVoiceMs).toBeGreaterThanOrEqual(LLM_STALL_MS);
  });

  it("stops the LLM and TTS components from double-counting the same milliseconds", async () => {
    const row = await captureCallerTurn();

    const llm = row.llmTtftMs ?? 0;
    const tts = row.ttsFirstByteMs ?? 0;
    const v2v = row.voiceToVoiceMs ?? 0;

    // The components are now additive within the caller-perceived budget.
    // Previously each separately contained the LLM stage, so their sum ran to
    // roughly twice the turn — which is how a 1878ms p50 turn was reported as
    // 1381ms LLM plus 1748ms TTS.
    expect(llm + tts).toBeLessThanOrEqual(v2v + 20);
  });
});
