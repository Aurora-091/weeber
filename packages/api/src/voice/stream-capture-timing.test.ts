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
 * A3 (phase-a-integrity.md) — the behavioural half of "persist captured
 * state per turn, not at hangup". `capture-timing.test.ts` covers the pure
 * counter; this covers the actual failure mode findings 3/4 describe: a call
 * that captures a fact early and then drops must still have that fact in
 * `calls.capturedState`, because `mergeCapturedField` persists on every
 * merge (not just at hangup) — the defect A3 closes was the *model* batching
 * its captures at the end, not this persistence path, and this test is what
 * would have caught the model-side regression from either direction.
 *
 * Mocking pattern lifted from stream-silence-timeout.test.ts — same
 * mocked db/stt/tts/twilio-client/org-queries/leads modules, real
 * `createVoiceStreamHandlers` state machine.
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

/** Set per-test: what the mocked agent turn does besides speak. `undefined`
 * means "just speak" (used for the greeting turn). */
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

async function flush(ticks = 50) {
  for (let i = 0; i < ticks; i++) await Promise.resolve();
}

/** The most recent `calls.capturedState` this test's mocked db saw written —
 * `mergeCapturedField` is the only thing that sets this column. */
function lastCapturedState(): Record<string, { value: unknown }> | undefined {
  const updates = dbUpdates.filter((u) => u.table === "calls" && "capturedState" in u.values);
  return updates.at(-1)?.values.capturedState as Record<string, { value: unknown }> | undefined;
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

describe("A3 — captured state survives a call that drops right after an early capture", () => {
  it("persists a fact captured on an early turn even when the call ends with no further turns", async () => {
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();

    await handlers.onMessage(START_EVENT, ws);
    await flush();

    // The caller states the fact on the very first real turn (turn 1 of what
    // could have been a much longer call) — this is the "early" half of
    // finding 3/4: production calls batched everything into their LAST turn
    // instead.
    onAgentTurn = (onToolCall) => {
      onToolCall(
        "captureField",
        { field: "email", value: "a@b.com", heard: "my email is a@b.com" },
        { captured: true, field: "email", value: "a@b.com" },
      );
    };
    stt.getLastOnTranscript()?.({ text: "my email is a@b.com", isFinal: true, speechFinal: true });
    await flush();

    // No further turns — simulate the call dropping right here (a dead PSTN
    // leg, the caller hanging up mid-conversation): the underlying transport
    // closes without a clean "stop" event. onClose is fire-and-forget (it
    // does not return the finalizeCall promise), so give its async chain
    // room to run.
    handlers.onClose();
    await flush(200);

    expect(lastCapturedState()?.email?.value).toBe("a@b.com");
  });
});
