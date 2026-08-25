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

describe("D8 — a spell-back correction overwrites an earlier mis-heard capture, not the reverse", () => {
  it("the first, misheard capture is recorded as stated", async () => {
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();
    await handlers.onMessage(START_EVENT, ws);

    stt.getLastOnTranscript()?.({ text: "My name is Jon", isFinal: true, speechFinal: true });
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

    stt.getLastOnTranscript()?.({ text: "My name is Jon", isFinal: true, speechFinal: true });
    await settle(30);
    // Ends on a full word, deliberately not a lone spelled-out letter — D6's
    // DictationSequenceDetector correctly treats "...J O H N" as still-spelling
    // and withholds the turn, which would make this test about D6, not D8.
    stt.getLastOnTranscript()?.({ text: "No, it's John, spelled J O H N, that's correct", isFinal: true, speechFinal: true });
    await settle(30);

    expect(turnCallCount).toBe(2);
    const last = persistedCapturedStates.at(-1);
    expect(last?.caller_name).toMatchObject({ value: "John" });
    expect(last?.caller_name.value).not.toBe("Jon");

    handlers.onClose();
  });
});
