import { mock, describe, it, expect, beforeEach } from "bun:test";

/**
 * Voice-pipeline hardening plan, Stage 2 (2026-09-05) — `history` grew every
 * turn with no cap (confirmed: no trimming existed anywhere before this).
 * On a long call that means an ever-larger prompt (TTFT and per-turn LLM
 * cost both creep upward with turn count) with nothing bounding it short of
 * TURN_TIMEOUT_MS/maxDurationSeconds ending the call first.
 *
 * This drives more turns than MAX_HISTORY_MESSAGES/2 (stream.ts) and asserts
 * the `history` array `runVoiceAgentTurn` actually receives stays bounded,
 * and that it no longer contains the earliest turns once the window has
 * slid past them — proving messages are actually dropped, not merely
 * capped-vacuously because the call never got long enough to matter.
 */

type TtsCall = { provider: string | undefined };
let ttsCalls: TtsCall[] = [];
let historyArgsByCall: unknown[][] = [];

let lastOnTranscript:
  | ((params: { text: string; isFinal: boolean; speechFinal: boolean }) => void)
  | null = null;

function getTableName(table: unknown): string | undefined {
  if (!table) return undefined;
  const sym = Object.getOwnPropertySymbols(table).find((s) => s.toString() === "Symbol(drizzle:Name)");
  return sym ? (table as Record<symbol, string>)[sym] : undefined;
}

function chain(rows: unknown[]): Promise<unknown[]> & Record<string, unknown> {
  const p = Promise.resolve(rows) as Promise<unknown[]> & Record<string, unknown>;
  for (const method of ["where", "limit", "returning", "onConflictDoNothing", "onConflictDoUpdate", "set", "values"]) {
    p[method] = () => chain(rows);
  }
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
  insert: () => chain([]),
  update: () => chain([]),
  execute: async () => [],
};

mock.module("../database", () => ({ db: dbLike, dbBackground: dbLike }));

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
  connectTts: (onAudioChunk: (base64Audio: string) => void, onDone?: () => void, _onError?: unknown, providerOverride?: string | null) => {
    ttsCalls.push({ provider: providerOverride ?? undefined });
    return {
      sendText: (text: string) => onAudioChunk(Buffer.from(`audio-for-${text}`).toString("base64")),
      endTurn: () => onDone?.(),
      close: () => {},
    };
  },
  resolveTtsProvider: (override?: string | null) => override ?? "cartesia",
}));

let turnIndex = 0;
mock.module("./agent", () => ({
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
  runVoiceAgentTurn: async ({
    history,
    onTextDelta,
  }: {
    history: unknown[];
    onTextDelta?: (d: string) => void;
  }) => {
    // Snapshot BEFORE this turn's own messages are pushed by stream.ts's
    // post-generate() history.push, so each entry reflects exactly what the
    // model actually saw for that turn.
    historyArgsByCall.push([...history]);
    turnIndex++;
    const reply = `agent reply ${turnIndex}`;
    onTextDelta?.(reply);
    return reply;
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
  const sent: string[] = [];
  return { sent, send: (data: string) => sent.push(data), close: () => {} };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

beforeEach(() => {
  ttsCalls = [];
  historyArgsByCall = [];
  lastOnTranscript = null;
  turnIndex = 0;
});

describe("history stays bounded on a long call", () => {
  it("caps the messages runVoiceAgentTurn sees and drops the earliest turns once the window slides past them", async () => {
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();
    await handlers.onMessage(START_EVENT, ws);
    await settle();

    // MAX_HISTORY_MESSAGES is 40 (20 user/assistant pairs). Drive 30 turns —
    // comfortably past that — each a plain caller line + agent reply pair.
    for (let i = 1; i <= 30; i++) {
      void lastOnTranscript?.({ text: `caller turn number ${i}`, isFinal: true, speechFinal: true });
      await settle();
    }

    const lastHistory = historyArgsByCall.at(-1) as { content: string }[];
    expect(lastHistory.length).toBeLessThanOrEqual(40);

    // The earliest turns must actually be gone, not just never having grown
    // that large — prove the window really slides.
    const flatText = lastHistory.map((m) => m.content).join(" | ");
    expect(flatText).not.toContain("caller turn number 1 ");
    expect(flatText).toContain("caller turn number 30");

    handlers.onClose();
  });
});
