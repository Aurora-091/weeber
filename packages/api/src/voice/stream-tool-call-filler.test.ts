import { mock, describe, it, expect, beforeEach } from "bun:test";
import { getCachedTtsAudio, clearTtsCacheForTests } from "./tts-cache";
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
 * maybePlayToolCallFiller() (stream.ts) used to call getEffectiveFlags()
 * fresh on every slow-tool-call filler trigger, even though the "start"
 * handler's Promise.all batch had already fetched this call's effective
 * flags a moment earlier — a duplicate DB round-trip on a path that fires
 * mid-turn, not once per call. Fixed by caching the startup batch's result
 * as resolvedFlags/resolvedFlagsReady and having the filler path read that
 * instead, falling back to a direct call only if triggered before setup
 * completes (see stream.ts's doc comment on resolvedFlags).
 *
 * This proves the fix from the outside: drive a real call through
 * createVoiceStreamHandlers, trigger a slow-tool-call filler mid-turn (via
 * the mocked ./agent module invoking onSlowToolCall, the same seam
 * buildVoiceTools' withFillerTimer uses in production), and assert
 * getEffectiveFlags was called exactly once for the whole call — from
 * "start" — not once more per filler trigger.
 *
 * Migrated (2026-08-25) to the shared `test-helpers/stream-harness.ts`. The
 * call-count instrumentation below decorates `orgQueries.module()` locally —
 * that's specific to this one file's own assertion, not shared harness
 * behavior.
 */

let getEffectiveFlagsCallCount = 0;

const db = createDbHarness();
const stt = createSttHarness();
const orgQueries = createOrgQueriesHarness();

// ADR-116 addendum: org-queries.ts (getEffectiveFlags, called from stream.ts)
// imports both `db` and `dbBackground` — both must resolve here.
mock.module("../database", db.module);
mock.module("./stt", stt.module);

mock.module("./tts", () => ({
  // One-shot shape — still used by warmFillerCache, which this test exercises
  // directly (the whole point of maybePlayToolCallFiller's cache warming).
  ...createTtsHarness().module(),
}));

/** How many slow-tool-call fillers each turn simulates — proves the fix
 * holds even when the filler fires more than once. */
let slowToolCallsThisTurn = 1;

mock.module("./agent", () => ({
  // ADR-115: stream.ts composes the call-control layer again when a call
  // turns out to be unable to hand off, so the mocked module has to expose
  // this export too. These configs carry no `promptInputs`, so the
  // recomposition is skipped and only the override block is appended.
  composeSystemPrompt: (opts: { jobDescription: string }) => ({ text: opts.jobDescription, segments: [] }),
    hasExhaustedField: () => false,
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
  // Simulates buildVoiceTools' withFillerTimer firing partway through a slow
  // tool call — the real trigger for maybePlayToolCallFiller in production.
  runVoiceAgentTurn: async ({
    onTextDelta,
    onSlowToolCall,
  }: {
    onTextDelta?: (d: string) => void;
    onSlowToolCall?: (toolName: string) => void;
  }) => {
    for (let i = 0; i < slowToolCallsThisTurn; i++) onSlowToolCall?.("lookupInfo");
    onTextDelta?.("Sure, I can help with that.");
    return "Sure, I can help with that.";
  },
}));

mock.module("./twilio-client", twilioClientHarnessModule);
mock.module("./org-queries", () => ({
  getEffectiveFlags: async () => {
    getEffectiveFlagsCallCount += 1;
    // D4 (2026-08-25): an absent hybrid-audio-cache row now reads as ON
    // (was off before that flip), so maybePlayToolCallFiller proceeds into
    // the cache lookup instead of returning immediately — harmless here
    // since this test only asserts getEffectiveFlags call-count dedup, not
    // filler content, and the mocked ./tts's connectTts covers
    // warmFillerCache's one-shot warm path either way.
    return orgQueries.module().getEffectiveFlags();
  },
}));
mock.module("./leads/leads", leadsHarnessModule);

const { createVoiceStreamHandlers } = await import("./stream");

const START_EVENT = buildStartEvent();

beforeEach(() => {
  getEffectiveFlagsCallCount = 0;
  slowToolCallsThisTurn = 1;
  orgQueries.reset();
  clearTtsCacheForTests();
});

describe("maybePlayToolCallFiller reuses the call-start effective flags (2026-08-20)", () => {
  it("does not issue a new getEffectiveFlags query when a slow-tool-call filler fires", async () => {
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();
    await handlers.onMessage(START_EVENT, ws);
    await settle();

    // The "start" handler's own startup batch is the only expected call.
    expect(getEffectiveFlagsCallCount).toBe(1);

    stt.getLastOnTranscript()?.({ text: "what is my order status", isFinal: true, speechFinal: true });
    await settle();
    handlers.onClose();

    // The slow-tool-call filler fired (mocked runVoiceAgentTurn always
    // calls onSlowToolCall once) and must not have added a second query.
    expect(getEffectiveFlagsCallCount).toBe(1);
  });

  it("still issues only one query even when the filler fires more than once in a turn", async () => {
    slowToolCallsThisTurn = 3;
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();
    await handlers.onMessage(START_EVENT, ws);
    await settle();

    stt.getLastOnTranscript()?.({ text: "what is my order status", isFinal: true, speechFinal: true });
    await settle();
    handlers.onClose();

    expect(getEffectiveFlagsCallCount).toBe(1);
  });
});

/**
 * D4 (phase-d-conversation.md, 2026-08-25) — hybrid-audio-cache flipped from
 * opt-in to opt-out: an absent `feature_flags` row (production's actual
 * state — the table is empty) now means the filler is ON, not off. An
 * explicit `enabled: false` row is still the kill switch.
 *
 * Perf audit follow-up (2026-08-25, docs/audits/2026-08-25-code-perf-
 * simplification-audit.md finding 1): the filler lines are now pre-warmed at
 * "start" (mirroring the backchannel warm added later the same session), so
 * the FIRST slow-tool-call trigger of a fresh call now also gets a cache hit
 * and forwards audio immediately — it no longer takes a second trigger to
 * benefit, unlike before this fix.
 */
const FILLER_TEXTS = ["One moment.", "Just a second."];
function anyFillerCached(): boolean {
  return FILLER_TEXTS.some((text) => getCachedTtsAudio("cartesia", "cartesia-voice-uuid", "en", text) !== undefined);
}

describe("hybrid-audio-cache default flip (D4, 2026-08-25)", () => {
  it("with no flags row at all, the filler cache is already warm by the time 'start' finishes — before any turn runs", async () => {
    orgQueries.setFlags({}); // the real production shape
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();
    await handlers.onMessage(START_EVENT, ws);
    await settle();

    expect(anyFillerCached()).toBe(true);
    handlers.onClose();
  });

  it("the very first slow-tool-call trigger of a fresh call forwards filler audio, not just warms it", async () => {
    orgQueries.setFlags({});
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();
    await handlers.onMessage(START_EVENT, ws);
    await settle();

    const sentBeforeFirstTurn = ws.sent.length;
    stt.getLastOnTranscript()?.({ text: "what is my order status", isFinal: true, speechFinal: true });
    await settle();
    handlers.onClose();

    expect(ws.sent.length).toBeGreaterThan(sentBeforeFirstTurn);
  });

  it("an explicit enabled: false still suppresses the filler — the kill switch survives the default flip", async () => {
    orgQueries.setFlags({ "hybrid-audio-cache": false });
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();
    await handlers.onMessage(START_EVENT, ws);
    await settle();

    stt.getLastOnTranscript()?.({ text: "what is my order status", isFinal: true, speechFinal: true });
    await settle();
    stt.getLastOnTranscript()?.({ text: "and what about the refund", isFinal: true, speechFinal: true });
    await settle();
    handlers.onClose();

    // Never even warmed, let alone sent — maybePlayToolCallFiller returns
    // before touching the cache at all when the flag is explicitly off.
    expect(anyFillerCached()).toBe(false);
  });
});
