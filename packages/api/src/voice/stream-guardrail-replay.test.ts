import { mock, describe, it, expect, beforeEach, afterEach, jest } from "bun:test";
import {
  createDbHarness,
  createSttHarness,
  createTtsHarness,
  twilioClientHarnessModule,
  createOrgQueriesHarness,
  leadsHarnessModule,
  fakeWs,
  buildStartEvent,
} from "./test-helpers/stream-harness";

/**
 * B3 (phase-b-measurement.md) — "prove guardrail_events is non-vacuous,"
 * the stream.ts-wiring half (production-replay.test.ts covers the pure
 * matcher functions against the same real incident). Replays production
 * call 2's actual tobacco-fabrication attempt (2026-08-20 17:38 UTC,
 * verified against the live database) through the real
 * `createVoiceStreamHandlers` state machine and asserts the
 * `guardrail_events` row that should have existed — and, per the audit,
 * didn't — actually lands.
 *
 * Mocking pattern lifted from stream-capture-timing.test.ts.
 */

let dbUpdates: { table: string | undefined; values: Record<string, unknown> }[] = [];
let dbInserts: { table: string | undefined; values: Record<string, unknown> }[] = [];

const callRow = {
  id: 2,
  orgId: "org_test",
  direction: "inbound",
  fromNumber: "+919999999999",
  toNumber: "+911111111111",
  webhookUrl: null,
  agentPersona: null,
  capturedState: {},
};

const db = createDbHarness({
  tables: { calls: [callRow] },
  onInsert: (table, values) => dbInserts.push({ table, values }),
  onUpdate: (table, values) => dbUpdates.push({ table, values }),
});
const stt = createSttHarness();

mock.module("../database", db.module);
mock.module("./stt", stt.module);
mock.module("./tts", createTtsHarness().module);

let onAgentTurn: ((onToolCall: (name: string, input: unknown, output: unknown) => void) => void) | null = null;

mock.module("./agent", () => {
  const run = async ({
    onTextDelta,
    onToolCall,
  }: {
    onTextDelta?: (d: string) => void;
    onToolCall?: (name: string, input: unknown, output: unknown) => void;
  }) => {
    if (onToolCall && onAgentTurn) onAgentTurn(onToolCall);
    onTextDelta?.("Noted, thanks.");
    return "Noted, thanks.";
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

mock.module("./twilio-client", twilioClientHarnessModule);
mock.module("./org-queries", createOrgQueriesHarness().module);
mock.module("./leads/leads", leadsHarnessModule);

const { createVoiceStreamHandlers } = await import("./stream");

const START_EVENT = buildStartEvent();

async function flush(ticks = 100) {
  for (let i = 0; i < ticks; i++) await Promise.resolve();
}

function guardrailInserts() {
  return dbInserts.filter((i) => i.table === "guardrail_events");
}

beforeEach(() => {
  jest.useFakeTimers();
  dbUpdates = [];
  dbInserts = [];
  onAgentTurn = null;
});

afterEach(() => {
  jest.useRealTimers();
  onAgentTurn = null;
});

describe("B3 — replaying production call 2's tobacco fabrication through the real stream.ts pipeline", () => {
  it("writes a fabricated-capture guardrail_events row when the model claims 'no' after the caller evaded", async () => {
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();

    await handlers.onMessage(START_EVENT, ws);
    await flush();

    // The literal caller line from production call 2, transcript row at
    // 2026-08-20T17:38:10.378Z.
    onAgentTurn = (onToolCall) => {
      onToolCall(
        "captureField",
        { field: "tobacco", value: "no", heard: "no" },
        { captured: true, field: "tobacco", value: "no" },
      );
    };
    stt.getLastOnTranscript()?.({ text: "just do some kind of drinks", isFinal: true, speechFinal: true });
    await flush();

    const rows = guardrailInserts();
    expect(rows).toHaveLength(1);
    expect(rows[0].values).toMatchObject({
      category: "fabricated-capture",
      source: "capture-guard",
    });
    // The field key and the unmatched "heard" claim survive as evidence —
    // this is the exact write A1 exists to make instead of a silent merge.
    expect(String(rows[0].values.detail)).toContain("tobacco");
  });
});
