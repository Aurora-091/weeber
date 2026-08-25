import { mock, describe, it, expect, beforeEach } from "bun:test";
import {
  chain,
  getTableName,
  createTtsHarness,
  twilioClientHarnessModule,
  createOrgQueriesHarness,
  leadsHarnessModule,
  fakeWs,
  settle,
  buildStartEvent,
} from "./test-helpers/stream-harness";

/**
 * Phase C3 (2026-08-24, docs/plans/phase-c-latency.md) — "the connect must
 * not be serialized ahead of the greeting."
 *
 * `stream.ts`'s "start" handler already calls `connectSttForCall(ws)`
 * without awaiting it, immediately before `await runGreeting(ws)` — STT
 * connect and the greeting's LLM/TTS work run concurrently by construction,
 * not something this phase had to add. What C3 actually needed was proof:
 * the 2026-08-21 audit found `stt_connect_ms` (608-753ms) sitting inside
 * `pickup_to_first_audio_ms` and inferred it was serialized ahead of the
 * greeting, but never verified that against the code. This test is that
 * verification, kept as a permanent regression guard — this must stay true
 * or a future change (e.g. someone adding an `await` in front of
 * `connectSttForCall`, or making the greeting depend on STT readiness for
 * some new reason) will make the caller wait on a handshake the greeting
 * never needed.
 *
 * Two guarantees:
 *   1. The greeting's audio reaches the caller before a deliberately slow
 *      STT connect finishes — greeting is not gated on STT readiness.
 *   2. `sttConnectMs` is still recorded once the connect completes (C3 step
 *      3: "the metric must not become 0 because we hid it").
 */

/** Deliberately much larger than the mocked TTS/LLM's ~0ms response, so the
 * two are unambiguously separable in the assertions below — this models the
 * audit's observed 608-753ms real-world STT handshake time. */
const STT_CONNECT_DELAY_MS = 300;

type CallLatencyRow = {
  callId?: number;
  sttConnectMs?: number;
  llmTtftMs?: number;
  ttsFirstByteMs?: number;
  pickupToFirstAudioMs?: number;
};

let callLatencyRows: CallLatencyRow[] = [];

const callRow = { id: 1, orgId: "org-1", direction: "inbound", status: "in-progress" };

const dbLike = {
  select: () => ({
    from: (table: unknown) => chain(getTableName(table) === "calls" ? [callRow] : []),
  }),
  // Capture only call_latency inserts — the upsert this test is verifying.
  insert: (table: unknown) => {
    if (getTableName(table) === "call_latency") {
      let latest: CallLatencyRow = {};
      const c = chain([]) as Promise<unknown[]> & Record<string, unknown>;
      c.values = (row: CallLatencyRow) => {
        latest = row;
        callLatencyRows.push(latest);
        const withSet = chain([]);
        withSet.onConflictDoUpdate = (opts: { set: Partial<CallLatencyRow> }) => {
          Object.assign(latest, opts.set);
          return chain([]);
        };
        return withSet;
      };
      return c;
    }
    return chain([]);
  },
  update: () => chain([]),
  execute: async () => [],
};

// ADR-116 addendum: org-queries.ts (getEffectiveFlags, called from stream.ts)
// imports both `db` and `dbBackground` — both must resolve here.
mock.module("../database", () => ({ db: dbLike, dbBackground: dbLike }));

mock.module("./stt", () => ({
  // The connect itself is synchronous (returns a connection object
  // immediately, same as the real per-provider adapters) — only `onConnected`
  // is deliberately delayed, modelling a slow TCP+TLS+WebSocket handshake.
  connectStt: (
    _onTranscript: unknown,
    _onFatalError: unknown,
    _onStatsUpdate: unknown,
    onConnected?: (ms: number) => void,
  ) => {
    setTimeout(() => onConnected?.(STT_CONNECT_DELAY_MS), STT_CONNECT_DELAY_MS);
    return {
      sendAudio: () => {},
      getStats: () => ({ reconnectCount: 0, totalGapMs: 0 }),
      close: () => {},
    };
  },
  resolveSttProvider: (override?: string | null) => override ?? "deepgram",
}));

// TTS answers immediately, same as the other stream-*.test.ts fixtures — the
// greeting's audio should be gated on this, not on STT.
mock.module("./tts", createTtsHarness().module);

mock.module("./agent", () => ({
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
  runVoiceAgentTurn: async ({ onTextDelta }: { onTextDelta?: (d: string) => void }) => {
    onTextDelta?.("Sure, I can help with that.");
    return "Sure, I can help with that.";
  },
}));

mock.module("./twilio-client", twilioClientHarnessModule);
mock.module("./org-queries", createOrgQueriesHarness().module);
mock.module("./leads/leads", leadsHarnessModule);

const { createVoiceStreamHandlers } = await import("./stream");

const START_EVENT = buildStartEvent();

beforeEach(() => {
  callLatencyRows = [];
});

describe("STT connect does not gate the greeting (Phase C3, 2026-08-24)", () => {
  it("sends greeting audio before a slow STT connect finishes", async () => {
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();

    // `onMessage` for the "start" event awaits `runGreeting` internally but
    // never awaits STT readiness — if it returns with audio already sent
    // while the STT connect's STT_CONNECT_DELAY_MS timer has not yet fired,
    // the greeting cannot have been waiting on STT.
    await handlers.onMessage(START_EVENT, ws);

    expect(ws.sent.length).toBeGreaterThan(0);
    // No call_latency row should show sttConnectMs yet — the connect is
    // still in flight at this point (its setTimeout hasn't resolved).
    const soFar = callLatencyRows.at(-1);
    expect(soFar?.sttConnectMs).toBeUndefined();

    handlers.onClose();
  });

  it("still records sttConnectMs once the connect completes, even though it wasn't on the critical path", async () => {
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();

    await handlers.onMessage(START_EVENT, ws);
    // Let the mocked STT connect's delayed onConnected actually fire.
    await settle(STT_CONNECT_DELAY_MS + 50);

    const row = callLatencyRows.at(-1);
    expect(row?.sttConnectMs).toBe(STT_CONNECT_DELAY_MS);

    handlers.onClose();
  });
});
