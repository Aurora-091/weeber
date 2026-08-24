import { mock, describe, it, expect, beforeEach } from "bun:test";

/**
 * Tool execution latency telemetry (observability-only, 2026-08-20).
 * `maybePlayToolCallFiller`'s DB-avoidance fix and this are unrelated —
 * this proves the *new* `tool_call_latency` write path: one row per tool
 * invocation, sourced from the AI SDK's `onToolExecutionEnd` hook
 * (agent.ts's runVoiceAgentTurn), persisted fire-and-forget by stream.ts's
 * persistToolCallLatency.
 *
 * Drives a real call through createVoiceStreamHandlers (only ./agent,
 * ./stt, ./tts, ./org-queries, ./twilio-client, ./leads/leads, and
 * ../database are mocked — the real stream.ts wiring runs). The mocked
 * runVoiceAgentTurn invokes onToolTelemetry directly with a synthetic
 * ToolExecutionTelemetry event per test, the same shape agent.ts's real
 * onToolExecutionEnd handler produces.
 */

type ToolCallLatencyRow = {
  callId?: number;
  toolName?: string;
  toolCallId?: string;
  startedAt?: Date;
  completedAt?: Date;
  durationMs?: number;
  success?: boolean;
  timedOut?: boolean;
};

let toolCallLatencyRows: ToolCallLatencyRow[] = [];

/**
 * Simulates the real unique index on toolCallId: onConflictDoNothing skips a
 * row whose toolCallId already exists, exactly like Postgres would. Built on
 * a genuine `Promise.resolve()` (like this repo's own `chain()` helper) with
 * side effects happening synchronously inside the overridden methods, not
 * deferred into a `.then()` — that keeps this lint-clean (no hand-rolled
 * thenable) and, more importantly, means the commit only ever happens via
 * whichever single path the real code actually calls, not both.
 */
function toolCallLatencyInsert(row: ToolCallLatencyRow) {
  function commitOnce() {
    const isDuplicate = !!row.toolCallId && toolCallLatencyRows.some((r) => r.toolCallId === row.toolCallId);
    if (!isDuplicate) toolCallLatencyRows.push(row);
  }
  const result = Promise.resolve([] as unknown[]) as Promise<unknown[]> & {
    onConflictDoNothing: () => Promise<unknown[]>;
  };
  result.onConflictDoNothing = () => {
    commitOnce();
    return Promise.resolve([]);
  };
  result.catch = (() => {
    // Only reached when the real code never called onConflictDoNothing
    // (no toolCallId to dedup against) — a plain insert commits directly.
    commitOnce();
    return Promise.resolve([]);
  }) as typeof result.catch;
  return result;
}

const callRow = { id: 1, orgId: "org_test", direction: "inbound", status: "in-progress" };

/** Same drizzle-chain stub shape as the other stream-*.test.ts files. */
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
  insert: (table: unknown) => {
    if (getTableName(table) === "tool_call_latency") {
      return { values: (row: ToolCallLatencyRow) => toolCallLatencyInsert(row) };
    }
    return chain([]);
  },
  update: () => chain([]),
  execute: async () => [],
};

// ADR-116 addendum: org-queries.ts (getEffectiveFlags, called from stream.ts)
// imports both `db` and `dbBackground` — both must resolve here.
mock.module("../database", () => ({ db: dbLike, dbBackground: dbLike }));

let lastOnTranscript: ((params: { text: string; isFinal: boolean; speechFinal: boolean }) => void) | null = null;

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
  connectTts: (onAudioChunk: (base64Audio: string) => void, onDone?: () => void) => ({
    sendText: () => onAudioChunk(Buffer.from("audio").toString("base64")),
    endTurn: () => onDone?.(),
    close: () => {},
  }),
  resolveTtsProvider: (override?: string | null) => override ?? "cartesia",
}));

type MockTelemetryEvent = {
  toolName: string;
  toolCallId?: string;
  startedAt: number;
  completedAt: number;
  durationMs: number;
  success: boolean;
  timedOut: boolean;
};

/** Set by a test before driving a turn — the events the mocked
 * runVoiceAgentTurn feeds to onToolTelemetry, in order. */
let mockTelemetryEvents: MockTelemetryEvent[] = [];

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
    onTextDelta,
    onToolTelemetry,
  }: {
    onTextDelta?: (d: string) => void;
    onToolTelemetry?: (event: MockTelemetryEvent) => void;
  }) => {
    for (const event of mockTelemetryEvents) onToolTelemetry?.(event);
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
  start: { streamSid: "MZ-test", callSid: "CA-test", customParameters: { from: "+919999999999", to: "+911111111111" } },
});

function fakeWs() {
  const sent: string[] = [];
  return { sent, send: (data: string) => sent.push(data), close: () => {} };
}

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  toolCallLatencyRows = [];
  lastOnTranscript = null;
  mockTelemetryEvents = [];
});

/** Drive one caller turn end-to-end. */
async function driveCallerTurn() {
  const handlers = createVoiceStreamHandlers("twilio");
  const ws = fakeWs();
  await handlers.onMessage(START_EVENT, ws);
  await settle();
  lastOnTranscript?.({ text: "what is my order status", isFinal: true, speechFinal: true });
  await settle();
  handlers.onClose();
  return ws;
}

describe("tool call execution latency is persisted per invocation (2026-08-20)", () => {
  it("persists tool name, call id, invocation id, timing, success, and timeout for a successful tool call", async () => {
    mockTelemetryEvents = [
      { toolName: "lookupInfo", toolCallId: "call_abc123", startedAt: 1000, completedAt: 1350, durationMs: 350, success: true, timedOut: false },
    ];
    await driveCallerTurn();

    expect(toolCallLatencyRows).toHaveLength(1);
    const row = toolCallLatencyRows[0]!;
    expect(row.callId).toBe(1);
    expect(row.toolName).toBe("lookupInfo");
    expect(row.toolCallId).toBe("call_abc123");
    expect(row.durationMs).toBe(350);
    expect(row.success).toBe(true);
    expect(row.timedOut).toBe(false);
    expect(row.startedAt).toBeInstanceOf(Date);
    expect(row.completedAt).toBeInstanceOf(Date);
  });

  it("records success: false and timedOut: true for a graceful timeout, distinct from a thrown failure", async () => {
    mockTelemetryEvents = [
      { toolName: "bookAppointment", toolCallId: "call_timeout1", startedAt: 2000, completedAt: 6000, durationMs: 4000, success: false, timedOut: true },
      { toolName: "crmSync", toolCallId: "call_error1", startedAt: 7000, completedAt: 7050, durationMs: 50, success: false, timedOut: false },
    ];
    await driveCallerTurn();

    expect(toolCallLatencyRows).toHaveLength(2);
    const timedOutRow = toolCallLatencyRows.find((r) => r.toolCallId === "call_timeout1")!;
    const failedRow = toolCallLatencyRows.find((r) => r.toolCallId === "call_error1")!;

    expect(timedOutRow.success).toBe(false);
    expect(timedOutRow.timedOut).toBe(true);
    expect(failedRow.success).toBe(false);
    expect(failedRow.timedOut).toBe(false);
  });

  it("does not create a duplicate row for a repeated toolCallId (retry dedup)", async () => {
    mockTelemetryEvents = [
      { toolName: "lookupInfo", toolCallId: "call_same", startedAt: 1000, completedAt: 1100, durationMs: 100, success: true, timedOut: false },
      // Same toolCallId reported twice — a duplicate/retried telemetry event
      // for the same real invocation, not a second tool call.
      { toolName: "lookupInfo", toolCallId: "call_same", startedAt: 1000, completedAt: 1100, durationMs: 100, success: true, timedOut: false },
    ];
    await driveCallerTurn();

    expect(toolCallLatencyRows).toHaveLength(1);
  });

  it("still persists a row when no toolCallId is available, just without a dedup key", async () => {
    mockTelemetryEvents = [
      { toolName: "setDisposition", startedAt: 3000, completedAt: 3010, durationMs: 10, success: true, timedOut: false },
    ];
    await driveCallerTurn();

    expect(toolCallLatencyRows).toHaveLength(1);
    expect(toolCallLatencyRows[0]!.toolCallId).toBeUndefined();
  });

  it("does not block the realtime voice path — the agent's spoken reply lands regardless of telemetry writes", async () => {
    mockTelemetryEvents = [
      { toolName: "lookupInfo", toolCallId: "call_x", startedAt: 1000, completedAt: 1200, durationMs: 200, success: true, timedOut: false },
    ];
    const ws = await driveCallerTurn();
    expect(ws.sent.length).toBeGreaterThan(0);
  });

  /**
   * B2 (phase-b-measurement.md) regression test — this table had 0 rows in
   * production against 24 real tool calls, and this is why: `duration_ms` is
   * a Postgres `integer` column, but the AI SDK's `toolExecutionMs` (what
   * `event.durationMs` carries) is a sub-millisecond float. Every insert
   * failed with `22P02 invalid input syntax for type integer`. Verified
   * directly against the production deployment's Railway logs from call 2
   * (2026-08-20 17:39:32Z) — these are that call's literal duration values,
   * not invented ones. The earlier tests in this file all happen to use
   * whole-number durationMs, which is exactly how this shipped with unit
   * tests passing and production silently broken (ADR-088's shape): a mock
   * that never exercises the one input shape production actually produces.
   */
  it("rounds a fractional-millisecond duration to an integer before it reaches the DB", async () => {
    mockTelemetryEvents = [
      { toolName: "hangUp", toolCallId: "call_672116", startedAt: 1000, completedAt: 1000.4461219999939203, durationMs: 0.4461219999939203, success: true, timedOut: false },
      { toolName: "captureField", toolCallId: "call_672083", startedAt: 2000, completedAt: 2001.8839950002729893, durationMs: 1.8839950002729893, success: true, timedOut: false },
      { toolName: "crmSync", toolCallId: "call_672099", startedAt: 3000, completedAt: 3451.1029129996896, durationMs: 451.1029129996896, success: true, timedOut: false },
    ];
    await driveCallerTurn();

    expect(toolCallLatencyRows).toHaveLength(3);
    for (const row of toolCallLatencyRows) {
      expect(Number.isInteger(row.durationMs)).toBe(true);
    }
    expect(toolCallLatencyRows.find((r) => r.toolCallId === "call_672116")!.durationMs).toBe(0);
    expect(toolCallLatencyRows.find((r) => r.toolCallId === "call_672083")!.durationMs).toBe(2);
    expect(toolCallLatencyRows.find((r) => r.toolCallId === "call_672099")!.durationMs).toBe(451);
  });
});
