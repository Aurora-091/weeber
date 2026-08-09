import { mock, describe, it, expect, beforeEach } from "bun:test";

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

function getTableName(table: unknown): string | undefined {
  if (!table) return undefined;
  const sym = Object.getOwnPropertySymbols(table).find((s) => s.toString() === "Symbol(drizzle:Name)");
  return sym ? (table as Record<symbol, string>)[sym] : undefined;
}

function chain(rows: unknown[], onValues?: (values: Record<string, unknown>) => void): Promise<unknown[]> & Record<string, unknown> {
  const p = Promise.resolve(rows) as Promise<unknown[]> & Record<string, unknown>;
  for (const method of ["where", "limit", "returning", "onConflictDoNothing", "onConflictDoUpdate", "values"]) {
    p[method] = () => chain(rows, onValues);
  }
  p.set = (values: Record<string, unknown>) => {
    onValues?.(values);
    return chain(rows, onValues);
  };
  return p;
}

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

mock.module("../database", () => ({
  db: {
    select: () => ({
      from: (table: unknown) => {
        const name = getTableName(table);
        return chain(name === "calls" ? [callRow] : name === "orgs" ? orgRows : []);
      },
    }),
    insert: () => chain([]),
    update: (table: unknown) => {
      const name = getTableName(table);
      return chain([], (values) => dbUpdates.push({ table: name, values }));
    },
    execute: async () => [],
  },
}));

let lastOnTranscript: ((p: { text: string; isFinal: boolean; speechFinal: boolean }) => void) | null = null;

mock.module("./stt", () => ({
  connectStt: (onTranscript: NonNullable<typeof lastOnTranscript>) => ({
    __capture: (lastOnTranscript = onTranscript),
    sendAudio: () => {},
    getStats: () => ({ reconnectCount: 0, totalGapMs: 0 }),
    close: () => {},
  }),
  resolveSttProvider: (override?: string | null) => override ?? "deepgram",
}));

mock.module("./tts", () => ({
  connectTts: (onAudioChunk: (b: string) => void, onDone?: () => void) => ({
    sendText: () => onAudioChunk(Buffer.from("audio").toString("base64")),
    endTurn: () => onDone?.(),
    close: () => {},
  }),
  resolveTtsProvider: (override?: string | null) => override ?? "cartesia",
}));

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

mock.module("./org-queries", () => ({ getEffectiveFlags: async () => ({}) }));
mock.module("./leads/leads", () => ({ promoteLeadFromCall: async () => undefined }));

const { createVoiceStreamHandlers } = await import("./stream");

const START_EVENT = JSON.stringify({
  event: "start",
  start: { streamSid: "MZ-test", callSid: "CA-test", customParameters: { from: "+919999999999", to: "+911111111111" } },
});

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
  lastOnTranscript?.({ text: "that is everything, thanks", isFinal: true, speechFinal: true });
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
  lastOnTranscript = null;
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
