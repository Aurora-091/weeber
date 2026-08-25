import { mock, describe, it, expect, beforeEach } from "bun:test";
import {
  createDbHarness,
  createSttHarness,
  createTtsHarness,
  twilioClientHarnessModule,
  createOrgQueriesHarness,
  buildStartEvent,
} from "./test-helpers/stream-harness";

/**
 * Phase C4 (2026-08-24, docs/plans/phase-c-latency.md) step 3 — "whatever
 * must still happen at hangup (final disposition, crmSync, caller_memory
 * upsert) happens after the audio path is closed, never in the turn the
 * caller is waiting on."
 *
 * Verification, not a new change: `performHangUp` already calls
 * `ws.close()` before `await finalizeCall(...)`, and `finalizeCall` is what
 * does the disposition DB write and `upsertCallerMemory` — so this ordering
 * already holds. This test locks it in as a permanent regression guard, the
 * same "found it, prove it, guard it" shape as
 * stream-stt-connect-concurrency.test.ts's C3 tests: a future refactor that
 * moves the caller-memory/disposition writes ahead of `ws.close()` (e.g. to
 * "simplify" performHangUp into one straight-line async function) would
 * reintroduce exactly the caller-perceived delay this phase exists to
 * remove, without any test currently catching it.
 *
 * `crmSync` itself is a model-invoked tool, not something `finalizeCall`
 * performs — it necessarily runs mid-turn, before hangUp, because it
 * summarizes the whole call and the model has to have decided to call it.
 * That's not a defect this test (or C4) addresses; see the plan doc's
 * "still open" note on the tool-call-cap half of C4, which needs real
 * post-A3 production data this repo does not yet have.
 */

type CallRow = {
  id: number;
  orgId: string;
  direction: string;
  fromNumber: string;
  toNumber: string;
  webhookUrl: string | null;
  agentPersona: string | null;
  capturedState: Record<string, unknown>;
};

let scriptedToolCalls: { name: string; input: unknown }[] = [];
let dbUpdates: { table: string | undefined; values: Record<string, unknown> }[] = [];
let events: string[] = [];

const callRow: CallRow = {
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
  onUpdate: (table, values) => dbUpdates.push({ table, values }),
});
const stt = createSttHarness();

mock.module("../database", db.module);
mock.module("./stt", stt.module);
mock.module("./tts", createTtsHarness().module);

mock.module("./agent", () => {
  const run = async ({
    onTextDelta,
    onToolCall,
  }: {
    onTextDelta?: (d: string) => void;
    onToolCall?: (name: string, input: unknown, output: unknown) => void;
  }) => {
    for (const call of scriptedToolCalls) onToolCall?.(call.name, call.input, {});
    onTextDelta?.("Thanks for calling, goodbye.");
    return "Thanks for calling, goodbye.";
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
mock.module("./leads/leads", () => ({
  promoteLeadFromCall: async () => {
    events.push("promoteLeadFromCall");
  },
  getLeadGreetingContext: async () => ({}),
}));

// The order-of-operations under test: does the recorded caller-memory write
// happen before or after the WebSocket close it must follow.
mock.module("./caller-memory", () => ({
  getCallerMemory: async () => ({}),
  upsertCallerMemory: async () => {
    events.push("upsertCallerMemory");
  },
  resolveHumanNumber: (_direction: string, fromNumber: string, _toNumber: string) => fromNumber,
}));

const { createVoiceStreamHandlers } = await import("./stream");

const START_EVENT = buildStartEvent();

function fakeWs() {
  return {
    send: () => {},
    close: () => {
      events.push("ws.close");
    },
  };
}

async function callerSpeaks() {
  stt.getLastOnTranscript()?.({ text: "that is everything, thanks", isFinal: true, speechFinal: true });
  await new Promise((resolve) => setTimeout(resolve, 2600));
}

beforeEach(() => {
  scriptedToolCalls = [];
  dbUpdates = [];
  events = [];
});

describe("finalize writes happen after the WebSocket closes (Phase C4 step 3, 2026-08-24)", () => {
  it("closes the socket before upserting caller memory on an agent-requested hangup", async () => {
    scriptedToolCalls = [{ name: "hangUp", input: { reason: "caller said goodbye" } }];
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();

    await handlers.onMessage(START_EVENT, ws);
    await callerSpeaks();

    expect(events).toContain("ws.close");
    expect(events).toContain("upsertCallerMemory");
    expect(events.indexOf("ws.close")).toBeLessThan(events.indexOf("upsertCallerMemory"));
  });
});
