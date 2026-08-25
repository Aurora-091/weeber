import { mock, describe, it, expect, beforeEach } from "bun:test";

/**
 * D8 (phase-d-conversation.md) — "a synthetic scenario where the caller
 * corrects a misheard letter during spell-back ends with the corrected
 * value captured, not the original mis-hearing."
 *
 * D8 itself ships no new runtime mechanism — see
 * `critical-field-classification.ts`'s doc comment and this plan item's own
 * "not a new provenance mechanism" scope. The persona is instructed
 * (agent.ts's `buildCallControlBlock`) to spell a critical field back and
 * re-call `captureField` with the corrected value if the caller says the
 * spell-back was wrong. What makes that safe is pre-existing: `stream.ts`'s
 * `mergeCapturedField` always overwrites `capturedState[field]` with the
 * latest write (see its own doc comment) — a later, corrected capture for
 * the same key already wins over an earlier mis-heard one with no new code.
 * This test drives the real `createVoiceStreamHandlers` state machine
 * through exactly that two-turn sequence and proves it, the same way
 * `stream-question-ledger.test.ts` proves D2's askCount against the real
 * state machine rather than hand-built fixtures.
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
  hasExhaustedField: () => false,
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
  // Turn 1: the caller states their name, the model mishears it and captures
  // "Jon" (a real ADR-120-provenance-passing quote — "Jon" genuinely appears
  // in what the caller said this turn, exactly the mis-hearing D8 is about:
  // STT mishearing a real word, not the model inventing one). Turn 2: the
  // caller corrects it during spell-back and the model re-calls captureField
  // for the SAME key with the corrected value/heard.
  runVoiceAgentTurn: async ({ onTextDelta, onToolCall }: { onTextDelta?: (d: string) => void; onToolCall?: OnToolCall }) => {
    turnCallCount += 1;
    if (turnCallCount === 1) {
      onToolCall?.(
        "captureField",
        { field: "caller_name", value: "Jon", heard: "Jon" },
        { captured: true, field: "caller_name", value: "Jon" },
      );
      onTextDelta?.("Got it — J, O, N, is that right?");
    } else {
      onToolCall?.(
        "captureField",
        { field: "caller_name", value: "John", heard: "John" },
        { captured: true, field: "caller_name", value: "John" },
      );
      onTextDelta?.("Thanks for the correction, John — noted.");
    }
    return "ok";
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

describe("D8 — a spell-back correction overwrites an earlier mis-heard capture, not the reverse", () => {
  it("the first, misheard capture is recorded as stated", async () => {
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();
    await handlers.onMessage(START_EVENT, ws);

    void lastOnTranscript?.({ text: "My name is Jon", isFinal: true, speechFinal: true });
    await settle(30);

    expect(turnCallCount).toBe(1);
    const last = persistedCapturedStates.at(-1);
    expect(last?.caller_name).toMatchObject({ value: "Jon" });

    handlers.onClose();
  });

  it("a spell-back correction on the next turn overwrites it — the corrected value wins, the mis-hearing does not survive", async () => {
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();
    await handlers.onMessage(START_EVENT, ws);

    void lastOnTranscript?.({ text: "My name is Jon", isFinal: true, speechFinal: true });
    await settle(30);
    // Ends on a full word, deliberately not a lone spelled-out letter — D6's
    // DictationSequenceDetector correctly treats "...J O H N" as still-spelling
    // and withholds the turn, which would make this test about D6, not D8.
    void lastOnTranscript?.({ text: "No, it's John, spelled J O H N, that's correct", isFinal: true, speechFinal: true });
    await settle(30);

    expect(turnCallCount).toBe(2);
    const last = persistedCapturedStates.at(-1);
    expect(last?.caller_name).toMatchObject({ value: "John" });
    expect(last?.caller_name.value).not.toBe("Jon");

    handlers.onClose();
  });
});
