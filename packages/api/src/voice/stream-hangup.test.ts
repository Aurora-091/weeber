import { mock, describe, it, expect, beforeEach } from "bun:test";
import {
  chain,
  getTableName,
  createSttHarness,
  createTtsHarness,
  createOrgQueriesHarness,
  leadsHarnessModule,
  buildStartEvent,
} from "./test-helpers/stream-harness";

/**
 * Defect: "the call is not ending."
 *
 * Drives the real stream state machine (`createVoiceStreamHandlers`) through the
 * three ways an agent-requested hangup could be lost:
 *
 * 1. `logToolCall` gated the intent on the tool input containing a `reason` key,
 *    so a `hangUp` called with `{}` was silently discarded.
 * 2. `performHangUp` built its Twilio client *inside* the expression whose
 *    `.catch()` only covered `update()`. A throw from `getTwilioClientForOrg`
 *    (DB/vault read, then `Twilio(sid, token)` — which throws on a malformed
 *    SID, exactly the half-provisioned sub-account state twilio-provisioning.ts
 *    documents) rejected the whole function, so `ws.close()` and
 *    `finalizeCall()` never ran and the caller stayed on a live, silent call.
 * 3. `performTransfer` fell through to `finalizeCall("transferred")` even when
 *    the redirect failed — closing STT/TTS and the silence timer while
 *    deliberately leaving the WebSocket open, i.e. a zombie leg with no agent
 *    and nothing left to end it.
 *
 * Closing the WebSocket is what actually ends the call — Twilio: "Twilio
 * executes the remaining TwiML instructions only after your server closes the
 * WebSocket connection", and `/incoming`'s answer TwiML has no verb after
 * `<Connect>`. So every assertion below is "the socket got closed and the call
 * row got finalized", not "the REST call succeeded".
 */

type ToolCall = { name: string; input: unknown };
/** Tool calls the fake model makes during the next turn/greeting. */
let scriptedToolCalls: ToolCall[] = [];
let dbUpdates: { table: string | undefined; values: Record<string, unknown> }[] = [];
let orgRows: Record<string, unknown>[] = [];
/** How the Twilio client behaves: resolve, reject the update, or throw on construction. */
let twilioMode: "ok" | "update-rejects" | "client-throws" = "ok";
let twilioUpdates: Record<string, unknown>[] = [];
/** How many times the mocked runVoiceAgentTurn/Greeting actually ran —
 * `hangupLatched`'s regression test needs to prove a SECOND turn never
 * started, not just that its tool calls didn't matter. */
let turnCallCount = 0;

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

const dbLike = {
  select: () => ({
    from: (table: unknown) => {
      const name = getTableName(table);
      return chain(name === "calls" ? [callRow] : name === "orgs" ? orgRows : []);
    },
  }),
  insert: () => chain([]),
  update: (table: unknown) => {
    const name = getTableName(table);
    return chain([], { onSet: (values) => dbUpdates.push({ table: name, values }) });
  },
  execute: async () => [],
};

// ADR-116 addendum: org-queries.ts (getEffectiveFlags, called from stream.ts)
// imports both `db` and `dbBackground` — both must resolve here.
mock.module("../database", () => ({ db: dbLike, dbBackground: dbLike }));

const stt = createSttHarness();

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
    turnCallCount += 1;
    for (const call of scriptedToolCalls) onToolCall?.(call.name, call.input, {});
    onTextDelta?.("Thanks for calling, goodbye.");
    return "Thanks for calling, goodbye.";
  };
  return {
    // ADR-115: stream.ts composes the call-control layer again when a call
    // turns out to be unable to hand off, so the mocked module has to expose
    // this export too. These configs carry no `promptInputs`, so the
    // recomposition is skipped and only the override block is appended.
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

mock.module("./twilio-client", () => ({
  twilioClient: {},
  getWsUrl: () => "wss://api.weeber.test",
  getPublicUrl: () => "https://api.weeber.test",
  getTwilioClientForOrg: async () => {
    if (twilioMode === "client-throws") {
      // What `Twilio(sid, token)` does on a malformed/unreadable sub-account SID.
      throw new Error("accountSid must start with AC");
    }
    return {
      calls: () => ({
        update: async (values: Record<string, unknown>) => {
          if (twilioMode === "update-rejects") throw new Error("HTTP 404: call not found on this account");
          twilioUpdates.push(values);
          return {};
        },
      }),
    };
  },
}));

mock.module("./org-queries", createOrgQueriesHarness().module);
mock.module("./leads/leads", leadsHarnessModule);

const { createVoiceStreamHandlers } = await import("./stream");

const START_EVENT = buildStartEvent();

function fakeWs() {
  let closeCount = 0;
  return {
    send: () => {},
    close: () => {
      closeCount++;
    },
    get closeCount() {
      return closeCount;
    },
  };
}

/** Runs one real caller turn — `runGreeting` deliberately passes no
 * `onToolCall` (the greeting cannot end a call it just started), so the tool
 * calls under test have to arrive on a normal turn. */
async function callerSpeaks() {
  stt.getLastOnTranscript()?.({ text: "that is everything, thanks", isFinal: true, speechFinal: true });
  // The pending-hangup path waits for ttsDone plus an estimated playback tail.
  await new Promise((resolve) => setTimeout(resolve, 2600));
}

const finalizedStatuses = () =>
  dbUpdates.filter((u) => u.table === "calls" && typeof u.values.status === "string").map((u) => u.values.status);

beforeEach(() => {
  scriptedToolCalls = [];
  dbUpdates = [];
  orgRows = [];
  twilioUpdates = [];
  twilioMode = "ok";
  turnCallCount = 0;
});

describe("an agent-requested hangup always ends the call", () => {
  it("ends the call when hangUp arrives with no reason at all", async () => {
    scriptedToolCalls = [{ name: "hangUp", input: {} }];
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();

    await handlers.onMessage(START_EVENT, ws);
    await callerSpeaks();

    expect(twilioUpdates).toEqual([{ status: "completed" }]);
    expect(ws.closeCount).toBeGreaterThanOrEqual(1);
    expect(finalizedStatuses()).toContain("completed");
  });

  it("still closes the socket and finalizes when the Twilio REST hangup rejects", async () => {
    twilioMode = "update-rejects";
    scriptedToolCalls = [{ name: "hangUp", input: { reason: "caller said goodbye" } }];
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();

    await handlers.onMessage(START_EVENT, ws);
    await callerSpeaks();

    expect(ws.closeCount).toBeGreaterThanOrEqual(1);
    expect(finalizedStatuses()).toContain("completed");
  });

  it("still closes the socket and finalizes when building the Twilio client throws", async () => {
    twilioMode = "client-throws";
    scriptedToolCalls = [{ name: "hangUp", input: { reason: "caller said goodbye" } }];
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();

    await handlers.onMessage(START_EVENT, ws);
    await callerSpeaks();

    expect(ws.closeCount).toBeGreaterThanOrEqual(1);
    expect(finalizedStatuses()).toContain("completed");
  });

  it("hangs up instead of leaving a zombie leg when a transfer redirect fails", async () => {
    orgRows = [{ name: "Test Org", humanTransferNumber: "+912222222222" }];
    twilioMode = "update-rejects";
    scriptedToolCalls = [{ name: "transferToHuman", input: { reason: "caller asked for a human" } }];
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();

    await handlers.onMessage(START_EVENT, ws);
    await callerSpeaks();

    // The redirect failed, so the call must not be reported as transferred and
    // left open — it hangs up.
    expect(finalizedStatuses()).toContain("completed");
    expect(finalizedStatuses()).not.toContain("transferred");
    expect(ws.closeCount).toBeGreaterThanOrEqual(1);
  });

  it("reports a successful transfer as transferred and leaves the leg up", async () => {
    orgRows = [{ name: "Test Org", humanTransferNumber: "+912222222222" }];
    scriptedToolCalls = [{ name: "transferToHuman", input: { reason: "caller asked for a human" } }];
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();

    await handlers.onMessage(START_EVENT, ws);
    await callerSpeaks();

    expect(finalizedStatuses()).toContain("transferred");
    expect(ws.closeCount).toBe(0);
  });
});

/**
 * Defect: the agent promised a warm handoff and then hung up on the caller.
 *
 * Reference case is production call 21 (2026-08-09), reconstructed from
 * transcripts + tool_calls: the agent said "Perfect. Let me connect you with a
 * licensed advisor right now", the caller answered "Okay", and the model
 * emitted transferToHuman AND hangUp on that same turn — its own hangUp reason
 * was "caller said goodbye", so it genuinely read the acknowledgement both
 * ways. speak() resolved the tie by honouring the hangup and *deleting*
 * pendingTransfer, so the caller was disconnected instead of bridged. The call
 * was still written as completed/booked: a lost lead that looks like a success
 * on the dashboard.
 *
 * See ADR-082. Both orderings are asserted because tool-call order within a
 * turn is the model's choice, not something we control.
 */
describe("a same-turn transfer + hangup resolves to the transfer", () => {
  it("transfers when hangUp was requested first", async () => {
    orgRows = [{ name: "Test Org", humanTransferNumber: "+912222222222" }];
    scriptedToolCalls = [
      { name: "hangUp", input: { reason: "caller said goodbye" } },
      { name: "transferToHuman", input: { reason: "final-expense qualified handoff" } },
    ];
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();

    await handlers.onMessage(START_EVENT, ws);
    await callerSpeaks();

    expect(finalizedStatuses()).toContain("transferred");
    expect(finalizedStatuses()).not.toContain("completed");
    expect(ws.closeCount).toBe(0);
  });

  it("transfers when transferToHuman was requested first", async () => {
    orgRows = [{ name: "Test Org", humanTransferNumber: "+912222222222" }];
    scriptedToolCalls = [
      { name: "transferToHuman", input: { reason: "final-expense qualified handoff" } },
      { name: "hangUp", input: { reason: "caller said goodbye" } },
    ];
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();

    await handlers.onMessage(START_EVENT, ws);
    await callerSpeaks();

    expect(finalizedStatuses()).toContain("transferred");
    expect(finalizedStatuses()).not.toContain("completed");
    expect(ws.closeCount).toBe(0);
  });

  it("still hangs up on a plain hangUp with no transfer in play", async () => {
    // Guards the inverted branch: honouring transfers must not make hangUp
    // unreachable on the ordinary "caller is done" path.
    scriptedToolCalls = [{ name: "hangUp", input: { reason: "caller said goodbye" } }];
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();

    await handlers.onMessage(START_EVENT, ws);
    await callerSpeaks();

    expect(finalizedStatuses()).toContain("completed");
    expect(finalizedStatuses()).not.toContain("transferred");
    expect(ws.closeCount).toBeGreaterThanOrEqual(1);
  });

  it("falls back to a hang-up when a same-turn transfer has no number configured", async () => {
    // No humanTransferNumber on the org: performTransfer's existing fallback
    // must still end the call rather than strand the caller in silence.
    orgRows = [{ name: "Test Org", humanTransferNumber: null }];
    scriptedToolCalls = [
      { name: "transferToHuman", input: { reason: "final-expense qualified handoff" } },
      { name: "hangUp", input: { reason: "caller said goodbye" } },
    ];
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();

    await handlers.onMessage(START_EVENT, ws);
    await callerSpeaks();

    expect(finalizedStatuses()).toContain("completed");
    expect(ws.closeCount).toBeGreaterThanOrEqual(1);
  });
});

/**
 * Post-deploy call review (2026-08-26, docs/audits/2026-08-26-post-deploy-
 * call-review.md) — call 19's live defect: the model called hangUp, and
 * before speak()'s closing-line wait actually tore the call down, a trailing
 * caller utterance ran a whole extra turn that called hangUp again with a
 * different reason and spoke a second, different goodbye
 * ("...This call is now closed.") on top of what the caller was still
 * saying. The exact same shape as production call 25 (ADR-082,
 * transferLatched, tested above) — just never covered for hangUp.
 */
describe("hangupLatched — a trailing caller utterance after hangUp is already latched runs no second turn", () => {
  it("ignores a caller utterance that arrives while the closing-line wait is still in flight", async () => {
    scriptedToolCalls = [{ name: "hangUp", input: { reason: "caller said goodbye" } }];
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();

    await handlers.onMessage(START_EVENT, ws);
    await new Promise((resolve) => setTimeout(resolve, 30)); // let the greeting settle
    const turnsBeforeCallerSpeaks = turnCallCount;

    // First utterance: the turn that actually calls hangUp.
    stt.getLastOnTranscript()?.({ text: "that is everything, thanks", isFinal: true, speechFinal: true });
    // A real gap, the same shape as production call 19's 487ms between its
    // two hangUp tool calls — long enough for the mocked turn to run and
    // hangupLatched to be set, short of the full closing-line wait.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(turnCallCount).toBe(turnsBeforeCallerSpeaks + 1);

    // A trailing utterance arrives while speak()'s closing-line wait
    // (Promise.race([ttsDone, sleep(8000)]) + the estimated playback tail)
    // is still in flight — call 19's exact shape.
    stt.getLastOnTranscript()?.({ text: "wait actually one more thing", isFinal: true, speechFinal: true });
    await new Promise((resolve) => setTimeout(resolve, 2600));

    // No second turn ran — hangupLatched refused it before runVoiceAgentTurn
    // was ever called again.
    expect(turnCallCount).toBe(turnsBeforeCallerSpeaks + 1);
    // Exactly one hangup landed at the provider, not two.
    expect(twilioUpdates).toEqual([{ status: "completed" }]);
    // The socket was closed exactly once.
    expect(ws.closeCount).toBe(1);

    handlers.onClose();
  });
});
