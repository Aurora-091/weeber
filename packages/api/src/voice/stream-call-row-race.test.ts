import { mock, describe, it, expect, beforeEach } from "bun:test";
import {
  chain,
  getTableName,
  createSttHarness,
  createTtsHarness,
  twilioClientHarnessModule,
  createOrgQueriesHarness,
  leadsHarnessModule,
  fakeWs,
  settle,
} from "./test-helpers/stream-harness";

/**
 * Production defect (found via live Supabase data, 2026-08-25, calls 9/11 on
 * org "good insurance"): both calls show a live health verdict recording
 * real turns ("agent took 3-4 turns"), yet zero rows in `transcripts`,
 * `tool_calls`, `turn_latency`, or `guardrail_events` — every write this
 * codebase gates on `dbCallId` silently no-opped for the entire call, while
 * the final status update still landed because it matches on `callSid`
 * instead.
 *
 * Root cause: routes.ts's `/incoming` webhook inserts the `calls` row
 * fire-and-forget (a 2026-07-17 latency fix), relying on stream.ts's own
 * SELECT-then-fallback-INSERT in the "start" handler to recover the row if
 * the media stream connects first. Both use `onConflictDoNothing()`. When
 * stream.ts's own SELECT runs before EITHER insert has landed (finds
 * nothing) and its own fallback INSERT then loses the conflict against the
 * concurrent /incoming insert, `onConflictDoNothing().returning()` comes
 * back EMPTY for the losing statement — and the old code did
 * `row = inserted ?? row`, which stayed `undefined` (row was already
 * `undefined` from the SELECT). `dbCallId` resolved to `null` for the rest
 * of the call even though a row now genuinely exists, created by the insert
 * that won.
 *
 * Fix: re-SELECT by `twilioCallSid` when the fallback insert comes back
 * empty, to pick up whichever insert actually won. This test drives that
 * exact race through the real "start" handler and asserts a `dbCallId`-gated
 * write (the `call_latency` upsert) still lands with the winning row's id.
 */

const WINNING_CALL_ROW = {
  id: 42,
  orgId: "org-1",
  direction: "outbound",
  fromNumber: "+14155551234",
  toNumber: "+919999999999",
  webhookUrl: null,
  agentPersona: null,
  capturedState: {},
};

let callsSelectCount = 0;
let callLatencyRows: { callId?: number; pickupToFirstAudioMs?: number }[] = [];

const dbLike = {
  select: () => ({
    from: (table: unknown) => {
      if (getTableName(table) !== "calls") return chain([]);
      callsSelectCount++;
      // First SELECT (before either insert has landed): genuinely nothing
      // yet — this is the race. Every SELECT after stream.ts's own insert
      // has been attempted models the concurrent /incoming insert having
      // won and landed by then.
      return chain(callsSelectCount === 1 ? [] : [WINNING_CALL_ROW]);
    },
  }),
  insert: (table: unknown) => {
    const name = getTableName(table);
    if (name === "calls") {
      return {
        values: () => ({
          onConflictDoNothing: () => ({
            // The losing side of the race: this statement's own row was
            // never created, so RETURNING is empty — even though a row now
            // exists in the table (inserted by the side that won).
            returning: async () => [],
          }),
        }),
      };
    }
    if (name === "call_latency") {
      const c = chain([]);
      c.values = (row: { callId?: number; pickupToFirstAudioMs?: number }) => {
        callLatencyRows.push(row);
        return chain([]);
      };
      return c;
    }
    return chain([]);
  },
  update: () => chain([]),
  execute: async () => [],
};

mock.module("../database", () => ({ db: dbLike, dbBackground: dbLike }));

mock.module("./stt", createSttHarness().module);
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
  }),
  runVoiceAgentGreeting: async ({ onTextDelta }: { onTextDelta?: (d: string) => void }) => {
    onTextDelta?.("Hello, this is the agent.");
    return "Hello, this is the agent.";
  },
  runVoiceAgentTurn: async ({ onTextDelta }: { onTextDelta?: (d: string) => void }) => {
    onTextDelta?.("Got it, thank you.");
    return "Got it, thank you.";
  },
}));

mock.module("./twilio-client", twilioClientHarnessModule);
mock.module("./org-queries", createOrgQueriesHarness().module);
mock.module("./leads/leads", leadsHarnessModule);

const { createVoiceStreamHandlers } = await import("./stream");

// customParameters carries from/to, same as routes.ts's <Parameter> fix —
// required for stream.ts's fallback-insert branch to even attempt an insert.
const START_EVENT = JSON.stringify({
  event: "start",
  start: {
    streamSid: "MZ-test",
    callSid: "CA-race-test",
    customParameters: { from: "+14155551234", to: "+919999999999" },
  },
});

beforeEach(() => {
  callsSelectCount = 0;
  callLatencyRows = [];
});

describe("dbCallId recovers the winning row when the fallback insert loses its conflict (2026-08-25)", () => {
  it("still writes call_latency with the row created by the concurrent /incoming insert", async () => {
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();

    await handlers.onMessage(START_EVENT, ws);
    await settle();

    // Proves the race actually happened: one SELECT found nothing, the
    // insert lost its conflict, and a second SELECT (this fix) ran.
    expect(callsSelectCount).toBeGreaterThanOrEqual(2);

    // dbCallId-gated write reached the DB with the WINNING row's id — the
    // old code left this permanently unreachable for the rest of the call.
    expect(callLatencyRows.length).toBeGreaterThan(0);
    expect(callLatencyRows[0]!.callId).toBe(WINNING_CALL_ROW.id);

    handlers.onClose();
  });
});
