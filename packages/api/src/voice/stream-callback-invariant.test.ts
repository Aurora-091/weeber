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
 * A4 (phase-a-integrity.md), exit-gate condition 3: "A callback-requested
 * disposition with no scheduled_calls row is impossible, asserted by the A4
 * test." `tools/setDisposition.test.ts` covers the tool's own scheduling
 * attempt; this covers stream.ts's side of the contract — that a call whose
 * disposition tool reported `callbackScheduled: false` (or omitted the field
 * entirely) is caught at finalize and recorded as a guardrail event, rather
 * than silently finalizing as if the promise had been kept.
 *
 * Mocking pattern lifted from stream-capture-timing.test.ts.
 */

let dbUpdates: { table: string | undefined; values: Record<string, unknown> }[] = [];
let dbInserts: { table: string | undefined; values: Record<string, unknown> }[] = [];

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

const db = createDbHarness({
  tables: { calls: [callRow] },
  onInsert: (table, values) => dbInserts.push({ table, values }),
  onUpdate: (table, values) => dbUpdates.push({ table, values }),
});
const stt = createSttHarness();

mock.module("../database", db.module);
mock.module("./stt", stt.module);
mock.module("./tts", createTtsHarness().module);

/** What the mocked turn does besides speak — set per test. Only the regular
 * (post-transcript) turn actually receives `onToolCall` from stream.ts;
 * the greeting turn does not wire it at all. */
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
    onTextDelta?.("Got it, thanks.");
    return "Got it, thanks.";
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

async function flush(ticks = 200) {
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

describe("A4 — a callback-requested disposition with no scheduled_calls row is a recorded defect", () => {
  it("logs an undelivered-outcome guardrail event when the disposition tool reports callbackScheduled: false", async () => {
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();

    await handlers.onMessage(START_EVENT, ws);
    await flush();

    onAgentTurn = (onToolCall) => {
      // Simulates createSetDispositionTool's own execute() having already
      // tried and failed to schedule the callback (e.g. a DB error) — the
      // same output shape stream.ts's logToolCall reads callbackScheduled off.
      onToolCall(
        "setDisposition",
        { disposition: "callback-requested" },
        { recorded: true, disposition: "callback-requested", sentiment: null, notes: null, callbackScheduled: false },
      );
    };
    stt.getLastOnTranscript()?.({ text: "please call me back tomorrow", isFinal: true, speechFinal: true });
    await flush();

    handlers.onClose();
    await flush();

    const rows = guardrailInserts();
    expect(rows).toHaveLength(1);
    expect(rows[0].values).toMatchObject({
      category: "undelivered-outcome",
      source: "setDisposition-invariant",
    });
  });

  it("logs nothing when the callback was actually scheduled", async () => {
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();

    await handlers.onMessage(START_EVENT, ws);
    await flush();

    onAgentTurn = (onToolCall) => {
      onToolCall(
        "setDisposition",
        { disposition: "callback-requested" },
        { recorded: true, disposition: "callback-requested", sentiment: null, notes: null, callbackScheduled: true },
      );
    };
    stt.getLastOnTranscript()?.({ text: "please call me back tomorrow", isFinal: true, speechFinal: true });
    await flush();

    handlers.onClose();
    await flush();

    expect(guardrailInserts()).toHaveLength(0);
  });

  it("logs nothing for a disposition that never promised a callback", async () => {
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();

    await handlers.onMessage(START_EVENT, ws);
    await flush();

    onAgentTurn = (onToolCall) => {
      onToolCall(
        "setDisposition",
        { disposition: "not-interested" },
        { recorded: true, disposition: "not-interested", sentiment: null, notes: null },
      );
    };
    stt.getLastOnTranscript()?.({ text: "not interested, thanks", isFinal: true, speechFinal: true });
    await flush();

    handlers.onClose();
    await flush();

    expect(guardrailInserts()).toHaveLength(0);
  });
});
