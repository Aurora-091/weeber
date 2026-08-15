import { mock, describe, it, expect, beforeEach, afterEach, jest } from "bun:test";

/**
 * Defect: the agent hangs up on a caller who is actively answering.
 *
 * Observed in production on call 16 (2026-08-06). Two adjacent `transcripts`
 * rows, 38 milliseconds apart:
 *
 *   16:16:22.239  caller  "Yes."
 *   16:16:22.277  agent   "I haven't heard back, so I'll go ahead and end the
 *                          call here. Feel free to call back anytime. Goodbye."
 *
 * Cause: `handleSilenceTimeout` awaits `speakCannedLine` before hanging up. The
 * STT handler's `clearSilenceTimer()` is the only thing standing between a
 * talking caller and that hangup — and it is a no-op once the timer has already
 * fired and its callback is suspended inside that await. Clearing an
 * already-fired timer cancels nothing.
 *
 * The fix is a `callerSpeechEpoch` counter that the STT handler bumps and the
 * timeout re-checks after every await, so an in-flight timeout abandons itself
 * when the caller turns out to have been speaking.
 *
 * The tests drive the real state machine (`createVoiceStreamHandlers`) and use
 * fake timers to cross the 8s warning + 7s hangup stages. `speakCannedLine`
 * begins with `await getEffectiveFlags(orgId)`, which is the suspension point
 * this test gates on to place caller speech precisely inside the window the
 * production race lived in.
 */

let dbUpdates: { table: string | undefined; values: Record<string, unknown> }[] = [];
let dbInserts: { table: string | undefined; values: Record<string, unknown> }[] = [];

/** When set, `getEffectiveFlags` blocks until this is released — the seam that
 * puts caller speech inside `handleSilenceTimeout`'s await. */
let flagsGate: { promise: Promise<void>; release: () => void } | null = null;

function openGate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  flagsGate = { promise, release };
  return flagsGate;
}

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

mock.module("../database", () => ({
  db: {
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
  },
}));

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
  resolveTtsProvider: (override?: string | null) => override ?? "cartesia",
}));

mock.module("./agent", () => {
  const run = async ({ onTextDelta }: { onTextDelta?: (d: string) => void }) => {
    onTextDelta?.("Sure, happy to help.");
    return "Sure, happy to help.";
  };
  return {
    // ADR-115: stream.ts composes the call-control layer again when a call
    // turns out to be unable to hand off, so the mocked module has to expose
    // this export too. These configs carry no `promptInputs`, so the
    // recomposition is skipped and only the override block is appended.
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
  getEffectiveFlags: async () => {
    if (flagsGate) await flagsGate.promise;
    return {};
  },
}));
mock.module("./leads/leads", () => ({
  promoteLeadFromCall: async () => undefined,
  getLeadGreetingContext: async () => ({}),
}));

const { createVoiceStreamHandlers, estimateRemainingPlaybackMs } = await import("./stream");

const START_EVENT = JSON.stringify({
  event: "start",
  start: { streamSid: "MZ-test", callSid: "CA-test", customParameters: { from: "+919999999999", to: "+911111111111" } },
});

function fakeWs() {
  let closeCount = 0;
  return {
    send: () => {},
    close: () => {
      closeCount++;
    },
    get closeCount() {
      return closeCount;
    },
  };
}

/** Drains the microtask queue. Fake timers stop the clock, so every await in
 * the stream's async paths has to be flushed explicitly between advances. */
async function flush(ticks = 50) {
  for (let i = 0; i < ticks; i++) await Promise.resolve();
}

const agentLines = () =>
  dbInserts
    .filter((i) => i.table === "transcripts" && i.values.role === "agent")
    .map((i) => String(i.values.text ?? ""));

const finalizedStatuses = () =>
  dbUpdates.filter((u) => u.table === "calls" && typeof u.values.status === "string").map((u) => u.values.status);

const SILENCE_WARNING_MS = 8000;
const SILENCE_HANGUP_MS = 7000;

/**
 * Audit 10 (2026-08-09): the silence window no longer starts when we finish
 * *sending* a turn's audio, it starts when the caller has finished *hearing*
 * it. So crossing a stage means advancing the turn's estimated playback plus
 * the threshold — advancing the bare threshold must NOT trip the timer, which
 * is what the `does not fire early` test below pins.
 *
 * These two strings are the exact text the mocked agent (greeting) and
 * `handleSilenceTimeout` (re-prompt) produce.
 */
const GREETING_TEXT = "Sure, happy to help.";
const WARNING_TEXT = "Are you still there? Let me know if you need anything else.";
const GREETING_PLAYBACK_MS = estimateRemainingPlaybackMs(GREETING_TEXT);
const WARNING_PLAYBACK_MS = estimateRemainingPlaybackMs(WARNING_TEXT);

beforeEach(() => {
  jest.useFakeTimers();
  dbUpdates = [];
  dbInserts = [];
  flagsGate = null;
  lastOnTranscript = null;
});

afterEach(() => {
  jest.useRealTimers();
});

describe("caller silence timeout", () => {
  it("does not hang up on a caller who answers while the goodbye line is being prepared", async () => {
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();

    await handlers.onMessage(START_EVENT, ws);
    await flush();

    // Stage 1: caller says nothing for 8s *after the greeting finishes
    // playing* -> the re-prompt.
    jest.advanceTimersByTime(GREETING_PLAYBACK_MS + SILENCE_WARNING_MS);
    await flush();
    expect(agentLines().some((t) => t.includes("Are you still there?"))).toBe(true);

    // Stage 2: still nothing for 7s -> the goodbye, then the hangup. Gate the
    // canned line so the timeout is suspended mid-await, exactly where the
    // production race happened.
    const gate = openGate();
    jest.advanceTimersByTime(WARNING_PLAYBACK_MS + SILENCE_HANGUP_MS);
    await flush();

    // ...and the caller answers right then. This is the 38ms window from call 16.
    lastOnTranscript?.({ text: "yes I am still here", isFinal: true, speechFinal: true });
    await flush();

    gate.release();
    flagsGate = null;
    await flush(200);

    expect(finalizedStatuses()).not.toContain("completed");
    expect(ws.closeCount).toBe(0);
  });

  it("still warns and then hangs up on a caller who is genuinely silent", async () => {
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();

    await handlers.onMessage(START_EVENT, ws);
    await flush();

    jest.advanceTimersByTime(GREETING_PLAYBACK_MS + SILENCE_WARNING_MS);
    await flush();
    expect(agentLines().some((t) => t.includes("Are you still there?"))).toBe(true);

    jest.advanceTimersByTime(WARNING_PLAYBACK_MS + SILENCE_HANGUP_MS);
    await flush(200);

    expect(agentLines().some((t) => t.includes("I haven't heard back"))).toBe(true);
    expect(finalizedStatuses()).toContain("completed");
    expect(ws.closeCount).toBeGreaterThanOrEqual(1);
  });

  /**
   * The actual audit-10 regression test: 6/6 production calls died because the
   * silence timer was armed the instant TTS finished *sending*, so a greeting
   * that took ~12s to play was interrupted at 8s by "Are you still there?" and
   * at 15s by the goodbye + hangup. The caller was never silent — they had not
   * finished being talked at.
   */
  it("does not fire while the greeting is still playing out to the caller", async () => {
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();

    await handlers.onMessage(START_EVENT, ws);
    await flush();

    // One millisecond short of "greeting finished playing + full 8s of silence".
    jest.advanceTimersByTime(GREETING_PLAYBACK_MS + SILENCE_WARNING_MS - 1);
    await flush(200);

    expect(agentLines().some((t) => t.includes("Are you still there?"))).toBe(false);
    expect(finalizedStatuses()).not.toContain("completed");
    expect(ws.closeCount).toBe(0);
  });
});
