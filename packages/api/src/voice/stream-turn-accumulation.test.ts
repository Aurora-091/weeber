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
 * D9 (phase-d-conversation.md, 2026-08-26) — call 16's confirmed live
 * defect: a slow caller's one continuous answer ("I'm going with... final...
 * expense... coverage.") arrived as 4 separate `speech_final` events, each
 * firing its own genuine, independent, context-blind agent turn. Drives the
 * real `createVoiceStreamHandlers` state machine through the same shape —
 * several short caller fragments arriving well inside `turnAccumulationMs`
 * of each other, no agent turn in between — and proves:
 *
 *   1. With the accumulation window enabled (this test's mocked
 *      resolveAgentConfig returns turnAccumulationMs, the same shape
 *      agent.ts's resolveTurnAccumulation produces for
 *      "insurance-final-expense-qualifier"), all fragments land in ONE real
 *      turn, with the caller's own pre-existing history-merge concatenating
 *      them into a single message — not N separate, context-blind turns.
 *   2. Without it (turnAccumulationMs undefined, every other template),
 *      each fragment still fires its own turn immediately, byte-identical
 *      to before this feature existed — the regression control.
 *   3. A pending accumulated turn never fires after the call has already
 *      ended (finalizeCall's new pendingTurnTimer cleanup).
 */

type ModelMessage = { role: string; content: unknown };

let turnCallCount = 0;
let capturedHistories: ModelMessage[][] = [];
/** Set per describe block — the mocked resolveAgentConfig's turnAccumulationMs. */
let mockTurnAccumulationMs: number | undefined;

const db = createDbHarness({ tables: { calls: [{ id: 1, orgId: "org-1", direction: "inbound", status: "in-progress" }] } });
const stt = createSttHarness();

mock.module("../database", db.module);
mock.module("./stt", stt.module);
mock.module("./tts", createTtsHarness().module);

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
    turnAccumulationMs: mockTurnAccumulationMs,
  }),
  runVoiceAgentGreeting: async ({ onTextDelta }: { onTextDelta?: (d: string) => void }) => {
    onTextDelta?.("Hello, this is the agent.");
    return "Hello, this is the agent.";
  },
  runVoiceAgentTurn: async ({
    history,
    onTextDelta,
  }: {
    history: ModelMessage[];
    onTextDelta?: (d: string) => void;
  }) => {
    turnCallCount += 1;
    capturedHistories.push(history.map((m) => ({ ...m })));
    onTextDelta?.("Got it, thanks.");
    return "Got it, thanks.";
  },
}));

mock.module("./twilio-client", twilioClientHarnessModule);
mock.module("./org-queries", createOrgQueriesHarness().module);
mock.module("./leads/leads", leadsHarnessModule);

const { createVoiceStreamHandlers } = await import("./stream");

const START_EVENT = buildStartEvent();

beforeEach(() => {
  turnCallCount = 0;
  capturedHistories = [];
  mockTurnAccumulationMs = undefined;
});

describe("D9 — turn accumulation window (enabled)", () => {
  it("merges 3 quick caller fragments into ONE real turn instead of 3 context-blind ones", async () => {
    mockTurnAccumulationMs = 1400;
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();
    await handlers.onMessage(START_EVENT, ws);
    await settle(30);
    const turnsAfterGreeting = turnCallCount;

    // Call 16's exact shape: "I'm going with" / "final" / "expense" /
    // "coverage." — each well inside the 1400ms window of the last.
    stt.getLastOnTranscript()?.({ text: "I'm going with", isFinal: true, speechFinal: true });
    await settle(300);
    stt.getLastOnTranscript()?.({ text: "final expense", isFinal: true, speechFinal: true });
    await settle(300);
    stt.getLastOnTranscript()?.({ text: "coverage.", isFinal: true, speechFinal: true });

    // No turn has fired yet — still inside the accumulation window.
    await settle(300);
    expect(turnCallCount).toBe(turnsAfterGreeting);

    // Past the window from the LAST fragment (armed at +600ms, fires at +2000ms).
    await settle(1600);

    expect(turnCallCount).toBe(turnsAfterGreeting + 1);
    const merged = capturedHistories.at(-1)?.filter((m) => m.role === "user").at(-1);
    expect(merged?.content).toBe("I'm going with final expense coverage.");

    handlers.onClose();
  });

  it("still fires a single fragment after the window elapses with nothing more said", async () => {
    mockTurnAccumulationMs = 1400;
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();
    await handlers.onMessage(START_EVENT, ws);
    await settle(30);
    const turnsAfterGreeting = turnCallCount;

    stt.getLastOnTranscript()?.({ text: "Traditional.", isFinal: true, speechFinal: true });
    await settle(300);
    expect(turnCallCount).toBe(turnsAfterGreeting); // still waiting

    await settle(1300);
    expect(turnCallCount).toBe(turnsAfterGreeting + 1);
    const last = capturedHistories.at(-1)?.filter((m) => m.role === "user").at(-1);
    expect(last?.content).toBe("Traditional.");

    handlers.onClose();
  });

  it("a pending accumulated turn never fires after the call has already ended", async () => {
    mockTurnAccumulationMs = 1400;
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();
    await handlers.onMessage(START_EVENT, ws);
    await settle(30);
    const turnsAfterGreeting = turnCallCount;

    stt.getLastOnTranscript()?.({ text: "final expense", isFinal: true, speechFinal: true });
    await settle(100); // well inside the window — the timer is still pending
    handlers.onClose(); // real hangup/disconnect races the accumulation window

    await settle(1600); // past when the pending timer would have fired
    expect(turnCallCount).toBe(turnsAfterGreeting); // never fired
  });
});

describe("D9 — turn accumulation window (disabled, the regression control)", () => {
  it("every fragment still fires its own immediate turn, unchanged from before this feature existed", async () => {
    mockTurnAccumulationMs = undefined; // every template except the one D9 opted in
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();
    await handlers.onMessage(START_EVENT, ws);
    await settle(30);
    const turnsAfterGreeting = turnCallCount;

    stt.getLastOnTranscript()?.({ text: "I'm going with", isFinal: true, speechFinal: true });
    await settle(30);
    expect(turnCallCount).toBe(turnsAfterGreeting + 1); // fired immediately, no wait

    stt.getLastOnTranscript()?.({ text: "final expense coverage.", isFinal: true, speechFinal: true });
    await settle(30);
    expect(turnCallCount).toBe(turnsAfterGreeting + 2); // fired immediately again

    handlers.onClose();
  });
});
