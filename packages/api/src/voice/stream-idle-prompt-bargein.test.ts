import { mock, describe, it, expect, beforeEach, afterEach, jest } from "bun:test";

/**
 * D1 (phase-d-conversation.md) — before building anything, verify by
 * construction whether the existing barge-in mechanism (decideBargeIn +
 * agentIsSpeaking, barge-in.ts) already interrupts a playing idle-prompt
 * line the same way it interrupts a normal turn's speech. `speakCannedLine`
 * routes through the same shared `speak()` every real turn uses, which sets
 * `agentIsSpeaking = true` regardless of caller — if the STT handler's
 * barge-in check is genuinely caller-agnostic, an interim transcript
 * arriving while the idle prompt is playing should already cut it off.
 *
 * `stream-silence-timeout.test.ts`'s existing race test only proves the
 * ESCALATION decision is correct (the call doesn't wrongly hang up) — it
 * injects caller speech via `onTtsSendText`, which fires the instant text is
 * *handed to* TTS, before any audio actually streams, so it says nothing
 * about whether the audio itself gets cut off mid-sentence. This test
 * targets that gap directly: an INTERIM (not final) transcript event while
 * a canned line's audio is in flight, checking whether the turn is aborted.
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
  select: () => ({ from: (table: unknown) => chain(getTableName(table) === "calls" ? [callRow] : []) }),
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

/** Fires while a canned line's text is being handed to TTS — the same seam
 * stream-silence-timeout.test.ts uses to land inside the suspended await. */
let onTtsSendText: ((text: string) => void) | null = null;
/** Counts how many times the CURRENT turn's TTS handle was closed — the
 * observable signature of a barge-in actually cutting audio off. */
let turnCloseCalls = 0;

mock.module("./tts", () => ({
  connectTts: (onAudioChunk: (b: string) => void, onDone?: () => void) => ({
    sendText: (text: string) => {
      onTtsSendText?.(text);
      onAudioChunk(Buffer.from("audio").toString("base64"));
    },
    endTurn: () => onDone?.(),
    close: () => {
      turnCloseCalls += 1;
    },
  }),
  connectTtsSession: (providerOverride?: string | null, _voiceId?: string, _language?: string, onConnected?: (ms: number) => void) => {
    onConnected?.(0);
    return {
      provider: providerOverride ?? "cartesia",
      session: {
        startTurn: (onAudioChunk: (b: string) => void, onDone?: () => void) => ({
          sendText: (text: string) => {
            onTtsSendText?.(text);
            onAudioChunk(Buffer.from("audio").toString("base64"));
          },
          endTurn: () => onDone?.(),
          close: () => {
            turnCloseCalls += 1;
          },
        }),
        isOpen: () => true,
        close: () => {},
      },
    };
  },
  resolveTtsProvider: (override?: string | null) => override ?? "cartesia",
}));

mock.module("./agent", () => {
  const run = async ({ onTextDelta }: { onTextDelta?: (d: string) => void }) => {
    onTextDelta?.("Sure, happy to help.");
    return "Sure, happy to help.";
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
  getTwilioClientForOrg: async () => ({ calls: () => ({ update: async () => ({}) }) }),
}));

mock.module("./org-queries", () => ({ getEffectiveFlags: async () => ({}) }));
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
  const sent: string[] = [];
  return { sent, send: (data: string) => sent.push(data), close: () => {} };
}

async function flush(ticks = 50) {
  for (let i = 0; i < ticks; i++) await Promise.resolve();
}

const agentLines = () =>
  dbInserts.filter((i) => i.table === "transcripts" && i.values.role === "agent").map((i) => String(i.values.text ?? ""));

const SILENCE_WARNING_MS = 8000;
const GREETING_TEXT = "Sure, happy to help.";
const GREETING_PLAYBACK_MS = estimateRemainingPlaybackMs(GREETING_TEXT);

beforeEach(() => {
  jest.useFakeTimers();
  dbUpdates = [];
  dbInserts = [];
  lastOnTranscript = null;
  onTtsSendText = null;
  turnCloseCalls = 0;
});

afterEach(() => {
  jest.useRealTimers();
  onTtsSendText = null;
});

describe("D1 — does barge-in already interrupt a playing idle-prompt line?", () => {
  it("an interim caller transcript while the warning line is being sent to TTS closes the turn (cuts the audio)", async () => {
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();

    await handlers.onMessage(START_EVENT, ws);
    await flush();

    const closesBeforeInterrupt = turnCloseCalls;

    // The caller starts talking WHILE the warning line's text is being
    // handed to TTS — an INTERIM result (isFinal/speechFinal both false),
    // deliberately >= BARGE_IN_MIN_CHARS so decideBargeIn fires on the
    // first hit, same as barge-in.ts documents for "deliberate speech".
    // Installed BEFORE crossing the threshold so it fires inside the same
    // suspended await handleSilenceTimeout is parked on.
    onTtsSendText = (spoken) => {
      if (!spoken.includes("Are you still there")) return;
      onTtsSendText = null;
      lastOnTranscript?.({ text: "wait I am here", isFinal: false, speechFinal: false });
    };

    jest.advanceTimersByTime(GREETING_PLAYBACK_MS + SILENCE_WARNING_MS);
    await flush(200);

    expect(agentLines().some((t) => t.includes("Are you still there?"))).toBe(true);
    expect(turnCloseCalls).toBeGreaterThan(closesBeforeInterrupt);
  });
});
