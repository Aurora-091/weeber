import { mock, describe, it, expect, beforeEach } from "bun:test";

/**
 * Production defect (found via live Supabase data, 2026-08-25, call 6 on org
 * "good insurance"): a caller who self-corrects mid-word produces two
 * separate `speech_final` events — "No. I'm looking for funeral ex" then,
 * moments later, "funeral expenses." The agent's response to the first
 * fragment got barge-in-aborted before it spoke a single word (the caller
 * kept talking almost immediately), so nothing was pushed to `history` for
 * that aborted turn (see `runTurn`'s `wasInterrupted && spokenWords.length >
 * 0` guard) — leaving two consecutive `{role: "user"}` messages with no
 * assistant turn between them.
 *
 * The model later quoted the caller's answer for `captureField`'s `heard`
 * argument and read the two adjacent messages as one continuous utterance,
 * gluing them with no space: "funeral exfuneral expenses." ADR-120's
 * `heardInCallerSpeech` (capture-provenance.ts) correctly refused that
 * malformed quote — the glued word never appeared in the caller's actual,
 * space-separated transcript — and a real, correctly-answered fact
 * (`coverage_purpose`) was lost as collateral damage, three times in the same
 * call (`guardrail_events` shows the same refusal fired on turns 4, and
 * again — the model kept retrying).
 *
 * The fix is at the boundary, not the guard: stream.ts's caller-turn handler
 * now merges into the previous `history` entry instead of pushing a second
 * one when the last entry is already `{role: "user"}` — i.e. when no
 * assistant turn separated this fragment from the last one. This test drives
 * the real `createVoiceStreamHandlers` state machine through exactly that
 * sequence and asserts the model-facing `history` ends up with ONE merged,
 * space-joined entry, not two.
 */

type ModelMessage = { role: string; content: unknown };

let capturedHistories: ModelMessage[][] = [];
let turnCallCount = 0;
let firstTurnAbortSignal: AbortSignal | null = null;

const callRow = { id: 1, orgId: "org-1", direction: "inbound", status: "in-progress" };

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
  insert: () => chain([]),
  update: () => chain([]),
  execute: async () => [],
};

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

mock.module("./agent", () => ({
  composeSystemPrompt: (opts: { jobDescription: string }) => ({ text: opts.jobDescription, segments: [] }),
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
  // The first invocation (the caller's first fragment) hangs until its
  // abort signal fires and NEVER calls onTextDelta — modelling a turn that
  // gets barge-in-aborted before speaking a single word. Every later
  // invocation resolves normally and immediately.
  runVoiceAgentTurn: ({
    history,
    onTextDelta,
    signal,
  }: {
    history: ModelMessage[];
    onTextDelta?: (d: string) => void;
    signal?: AbortSignal;
  }) => {
    capturedHistories.push(history.map((m) => ({ ...m })));
    const callIndex = turnCallCount++;
    if (callIndex === 0) {
      firstTurnAbortSignal = signal ?? null;
      return new Promise<string>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          const err = new Error("aborted by caller barge-in");
          err.name = "AbortError";
          reject(err);
        });
      });
    }
    onTextDelta?.("Got it, thank you.");
    return Promise.resolve("Got it, thank you.");
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
  capturedHistories = [];
  turnCallCount = 0;
  firstTurnAbortSignal = null;
  lastOnTranscript = null;
});

describe("a barge-in-aborted self-correction merges into one history entry (2026-08-25)", () => {
  it("merges two consecutive caller fragments with a space instead of leaving them as separate messages", async () => {
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();

    await handlers.onMessage(START_EVENT, ws);

    // Fragment 1 — a mid-word self-correction start. Fire-and-forget: its
    // turn hangs on the mocked runVoiceAgentTurn's pending promise until
    // fragment 2 barges in and aborts it.
    void lastOnTranscript?.({ text: "No. I'm looking for funeral ex", isFinal: true, speechFinal: true });
    await settle(20);

    // Turn 1 must actually be in flight (agentIsSpeaking, mock invoked,
    // nothing spoken yet) for this test to mean anything.
    expect(turnCallCount).toBe(1);
    expect(firstTurnAbortSignal?.aborted).toBe(false);

    // Fragment 2 — the caller continuing almost immediately. Long enough to
    // bypass the barge-in streak requirement (BARGE_IN_MIN_CHARS) and fire
    // on the first hit.
    void lastOnTranscript?.({ text: "funeral expenses.", isFinal: true, speechFinal: true });
    await settle(30);

    expect(firstTurnAbortSignal?.aborted).toBe(true);
    expect(turnCallCount).toBe(2);

    // Turn 2's own captured history is what the model actually saw when
    // responding to "funeral expenses." — this is the assertion that matters.
    const historyForTurn2 = capturedHistories[1]!;
    const userEntries = historyForTurn2.filter((m) => m.role === "user");
    expect(userEntries).toHaveLength(1);
    expect(userEntries[0]!.content).toBe("No. I'm looking for funeral ex funeral expenses.");

    handlers.onClose();
  });
});
