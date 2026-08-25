import { mock, describe, it, expect, beforeEach } from "bun:test";
import {
  createDbHarness,
  createSttHarness,
  createTtsHarness,
  twilioClientHarnessModule,
  createOrgQueriesHarness,
  leadsHarnessModule,
  fakeWs,
  settle,
  buildStartEvent,
} from "./test-helpers/stream-harness";

/**
 * D3 (phase-d-conversation.md), trigger 1/2 — "ledger exhaustion" and
 * "repeated non-comprehension" must produce a defined outcome, never a
 * silent continuation. Since the model still decides which tool (if any) to
 * call, this can't be forced the way A4 forces the scheduled_calls insert —
 * it's the audit-trail half of the same invariant-as-a-check pattern
 * `stream-callback-invariant.test.ts` covers for A4: a call that ends with a
 * field at MAX_FIELD_ASK_COUNT and neither a disposition nor a transfer is a
 * recorded defect, not a possibility.
 *
 * Mocking pattern lifted from stream-callback-invariant.test.ts.
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

/** Fires on every regular turn, letting each test decide what tool call (if
 * any) the mocked model makes for that turn. */
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
    // Real logic, not a stub — this file tests stream.ts's D3 check, which
    // calls this directly, so a fixed `() => false` (fine for every OTHER
    // stream-*.test.ts, which only needs the export to exist) would silently
    // defeat the very thing under test here. Mirrors agent.ts's real
    // hasExhaustedField/MAX_FIELD_ASK_COUNT (2) — kept in sync by hand since
    // this is a mock, not an import of the real implementation.
    hasExhaustedField: (capturedState?: Record<string, { value: string | null; askCount?: number }>) =>
      Object.values(capturedState ?? {}).some((entry) => entry.value === null && (entry.askCount ?? 1) >= 2),
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

function guardrailInserts() {
  return dbInserts.filter((i) => i.table === "guardrail_events");
}

beforeEach(() => {
  dbUpdates = [];
  dbInserts = [];
  onAgentTurn = null;
});

/** Marks "tobacco" unanswered, quoting real words the caller just said so
 * ADR-120's heard-in-caller-speech provenance check genuinely passes. */
function markTobaccoUnanswered(onToolCall: (name: string, input: unknown, output: unknown) => void) {
  onToolCall("markFieldUnanswered", { field: "tobacco", heard: "rather not say" }, { field: "tobacco", recorded: true });
}

describe("D3 — an exhausted field with no delivered outcome is a recorded defect", () => {
  it("logs an undelivered-outcome guardrail event when the call ends with an exhausted field and no disposition/transfer", async () => {
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();
    await handlers.onMessage(START_EVENT, ws);
    await settle(30);

    onAgentTurn = markTobaccoUnanswered;
    stt.getLastOnTranscript()?.({ text: "I'd rather not say", isFinal: true, speechFinal: true });
    await settle(30);
    stt.getLastOnTranscript()?.({ text: "I said I'd rather not say", isFinal: true, speechFinal: true });
    await settle(30);

    handlers.onClose();
    await settle(30);

    const rows = guardrailInserts();
    expect(rows).toHaveLength(1);
    expect(rows[0].values).toMatchObject({ category: "undelivered-outcome", source: "ledger-exhaustion" });
  });

  it("logs nothing when a disposition was recorded before the call ended", async () => {
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();
    await handlers.onMessage(START_EVENT, ws);
    await settle(30);

    onAgentTurn = markTobaccoUnanswered;
    stt.getLastOnTranscript()?.({ text: "I'd rather not say", isFinal: true, speechFinal: true });
    await settle(30);
    stt.getLastOnTranscript()?.({ text: "I said I'd rather not say", isFinal: true, speechFinal: true });
    await settle(30);

    onAgentTurn = (onToolCall) =>
      onToolCall(
        "setDisposition",
        { disposition: "not-interested" },
        { recorded: true, disposition: "not-interested", sentiment: null, notes: null },
      );
    stt.getLastOnTranscript()?.({ text: "not interested, thanks", isFinal: true, speechFinal: true });
    await settle(30);

    handlers.onClose();
    await settle(30);

    expect(guardrailInserts()).toHaveLength(0);
  });

  it("logs nothing for a field that was only asked once (below the cap)", async () => {
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();
    await handlers.onMessage(START_EVENT, ws);
    await settle(30);

    onAgentTurn = markTobaccoUnanswered;
    stt.getLastOnTranscript()?.({ text: "I'd rather not say", isFinal: true, speechFinal: true });
    await settle(30);

    handlers.onClose();
    await settle(30);

    expect(guardrailInserts()).toHaveLength(0);
  });
});
