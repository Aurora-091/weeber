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
 * D2 (phase-d-conversation.md) — the mechanical fix for the tobacco loop.
 * Drives the real `createVoiceStreamHandlers` state machine through two
 * consecutive caller turns, each ending in a `markFieldUnanswered` tool call
 * for the SAME field (an evasive caller declining the same question twice),
 * and asserts `calls.capturedState`'s persisted `askCount` actually
 * increments — the data `buildKnownFactsBlock`'s cap rendering (see
 * agent.test.ts's D2 describe block) depends on being real, not asserted
 * only at the pure-function level with hand-built fixtures.
 *
 * Migrated (2026-08-25) to the shared `test-helpers/stream-harness.ts` — see
 * that file's doc comment for why. No behavior or assertion changed.
 */

type CapturedFieldRow = { value: string | null; heard: string; transcriptId: number | null; turn: number; askCount?: number };

let persistedCapturedStates: Record<string, CapturedFieldRow>[] = [];
let turnCallCount = 0;

const db = createDbHarness({
  tables: { calls: [{ id: 1, orgId: "org-1", direction: "inbound", status: "in-progress" }] },
  onUpdate: (_table, values) => {
    if (values.capturedState) {
      persistedCapturedStates.push(values.capturedState as Record<string, CapturedFieldRow>);
    }
  },
});
const stt = createSttHarness();
const orgQueries = createOrgQueriesHarness();

mock.module("../database", db.module);
mock.module("./stt", stt.module);
mock.module("./tts", createTtsHarness().module);

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
  // Each turn immediately "calls" markFieldUnanswered for the same field,
  // quoting real words the caller just said (real ADR-120 provenance, not
  // bypassed) so logToolCall's heard-in-caller-speech check genuinely passes.
  runVoiceAgentTurn: async ({ onTextDelta, onToolCall }: { onTextDelta?: (d: string) => void; onToolCall?: OnToolCall }) => {
    turnCallCount += 1;
    onToolCall?.(
      "markFieldUnanswered",
      { field: "tobacco", heard: "rather not talk about that" },
      { field: "tobacco", recorded: true },
    );
    onTextDelta?.("No problem, let's move on.");
    return "No problem, let's move on.";
  },
}));

mock.module("./twilio-client", twilioClientHarnessModule);
mock.module("./org-queries", orgQueries.module);
mock.module("./leads/leads", leadsHarnessModule);

const { createVoiceStreamHandlers } = await import("./stream");

const START_EVENT = buildStartEvent();

beforeEach(() => {
  persistedCapturedStates = [];
  turnCallCount = 0;
  orgQueries.reset();
});

describe("D2 — askCount increments across repeated markFieldUnanswered calls for the same field", () => {
  it("the first evasion is recorded with askCount 1", async () => {
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();
    await handlers.onMessage(START_EVENT, ws);

    void stt.getLastOnTranscript()?.({ text: "I'd rather not talk about that", isFinal: true, speechFinal: true });
    await settle(30);

    expect(turnCallCount).toBe(1);
    const last = persistedCapturedStates.at(-1);
    expect(last?.tobacco).toMatchObject({ value: null, askCount: 1 });

    handlers.onClose();
  });

  it("a second evasion of the same field increments askCount to 2, not resetting it", async () => {
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();
    await handlers.onMessage(START_EVENT, ws);

    void stt.getLastOnTranscript()?.({ text: "I'd rather not talk about that", isFinal: true, speechFinal: true });
    await settle(30);
    void stt.getLastOnTranscript()?.({ text: "I said I'd rather not talk about that", isFinal: true, speechFinal: true });
    await settle(30);

    expect(turnCallCount).toBe(2);
    const last = persistedCapturedStates.at(-1);
    expect(last?.tobacco).toMatchObject({ value: null, askCount: 2 });

    handlers.onClose();
  });
});
