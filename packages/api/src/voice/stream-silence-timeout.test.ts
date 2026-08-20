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
 * fake timers to cross the 8s warning + 7s hangup stages. The race window is
 * exercised by injecting caller speech in the same tick as the timer fires
 * (before any microtask flush), so both the timeout handler and the speech
 * handler are queued when flush runs — `callerSpeechEpoch` is bumped before
 * `handleSilenceTimeout`'s epoch re-check runs.
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

// ADR-116 addendum: org-queries.ts (getEffectiveFlags, called from stream.ts)
// imports both `db` and `dbBackground` — both must resolve here.
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

/**
 * Test seam for the race (2026-08-20): fires with the text handed to TTS,
 * from inside the `await speak(...)` that `speakCannedLine` is suspended on.
 * That is the only place a test can stand in for "the caller answered while
 * the goodbye line was being prepared" — see the race test below for why the
 * previous same-tick-injection technique could not reproduce it.
 */
let onTtsSendText: ((text: string) => void) | null = null;

mock.module("./tts", () => ({
  connectTts: (onAudioChunk: (b: string) => void, onDone?: () => void) => ({
    sendText: (text: string) => {
      onTtsSendText?.(text);
      onAudioChunk(Buffer.from("audio").toString("base64"));
    },
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
  getEffectiveFlags: async () => ({}),
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
  lastOnTranscript = null;
  onTtsSendText = null;
});

afterEach(() => {
  jest.useRealTimers();
  onTtsSendText = null;
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

    // Stage 2: still nothing for 7s -> the goodbye, then the hangup.
    //
    // The caller has to answer *while handleSilenceTimeout is suspended inside
    // `await speakCannedLine`* — that suspension is the whole defect, because
    // the STT handler's clearSilenceTimer() cannot cancel a timer that has
    // already fired. Injecting after `advanceTimersByTime` returns cannot
    // reproduce it: bun's fake timers drain the microtask queue while
    // advancing, so by the time control comes back the goodbye has already
    // been spoken and the hangup has already landed. (It used to work by
    // accident — speakCannedLine awaited a getEffectiveFlags() DB round-trip,
    // which parked the handler long enough for a same-tick injection to win
    // the race. a6d2b87 cached those flags at call start and the accidental
    // window closed with it.)
    //
    // So inject from inside the TTS layer instead: onTtsSendText fires while
    // speakCannedLine is still awaiting, which is exactly the production
    // ordering of call 16 — caller speech consumed after the timeout's initial
    // epoch guard passed, and before its post-await re-check runs. That
    // re-check is the assertion below.
    onTtsSendText = (spoken) => {
      if (!spoken.includes("I haven't heard back")) return;
      onTtsSendText = null; // fire once
      lastOnTranscript?.({ text: "yes I am still here", isFinal: true, speechFinal: true });
    };
    jest.advanceTimersByTime(WARNING_PLAYBACK_MS + SILENCE_HANGUP_MS);
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
