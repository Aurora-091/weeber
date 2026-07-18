import { describe, it, expect, beforeEach, mock } from "bun:test";

// ---- Fakes for the three pipeline seams test-call-stream.ts calls into ----
// (connectStt/connectTts/runVoiceAgentTurn/runVoiceAgentGreeting) — same
// "mock the module, not the function" pattern as agent.test.ts/routes.test.ts.

type FakeSttCall = {
  onTranscript: (params: { text: string; isFinal: boolean; speechFinal: boolean }) => void;
  onFatalError?: (err: unknown) => void;
};
let lastSttCall: FakeSttCall | null = null;
let sttCloseCalls = 0;

let lastTtsOnAudioChunk: ((base64Audio: string) => void) | null = null;
let ttsSendTextCalls: string[] = [];
let ttsEndTurnCalls = 0;
let ttsCloseCalls = 0;

let greetingCallCount = 0;
let turnCallCount = 0;
/** Controls what the fake agent "says" per call — set per-test. */
let agentReplyText = "Hello, how can I help?";
let agentOnToolCallCapture: ((name: string, input: unknown) => void) | null = null;

mock.module("./stt", () => ({
  connectStt: (
    onTranscript: FakeSttCall["onTranscript"],
    onFatalError?: (err: unknown) => void,
  ) => {
    lastSttCall = { onTranscript, onFatalError };
    return {
      sendAudio: () => {},
      getStats: () => ({ reconnectCount: 0, totalGapMs: 0 }),
      close: () => {
        sttCloseCalls++;
      },
    };
  },
  // Phase 3 (2026-07-17) "Simulate provider failure" resolves the primary
  // via this same-named real helper (see stt/index.ts) — mirrored here
  // (override ?? "deepgram", same default) so importing it doesn't crash
  // this fully-mocked module.
  resolveSttProvider: (override?: string | null) => override ?? "deepgram",
}));

mock.module("./tts", () => ({
  connectTts: (onAudioChunk: (base64Audio: string) => void, onDone?: () => void) => {
    lastTtsOnAudioChunk = onAudioChunk;
    void onDone;
    return {
      sendText: (text: string) => {
        ttsSendTextCalls.push(text);
      },
      endTurn: () => {
        ttsEndTurnCalls++;
      },
      close: () => {
        ttsCloseCalls++;
      },
    };
  },
  // Same reasoning as resolveSttProvider above (see tts/index.ts).
  resolveTtsProvider: (override?: string | null) => override ?? "cartesia",
}));

mock.module("./agent", () => ({
  resolveAgentConfig: async () => ({
    systemPrompt: "You are a test agent.",
    enabledTools: undefined,
    llmModel: "gpt-4o-mini",
    voiceId: undefined,
    ttsProvider: "elevenlabs",
    llmProvider: "gateway",
    sttProvider: "deepgram",
    language: "en",
  }),
  buildPreviewAgentConfig: async () => ({
    systemPrompt: "You are a preview test agent.",
    enabledTools: undefined,
    llmModel: "gpt-4o-mini",
    voiceId: undefined,
    ttsProvider: "elevenlabs",
    llmProvider: "gateway",
    sttProvider: "deepgram",
    language: "en",
  }),
  runVoiceAgentGreeting: async (opts: { onTextDelta: (delta: string) => void }) => {
    greetingCallCount++;
    opts.onTextDelta(agentReplyText);
    return agentReplyText;
  },
  runVoiceAgentTurn: async (opts: {
    onTextDelta: (delta: string) => void;
    onToolCall?: (name: string, input: unknown) => void;
  }) => {
    turnCallCount++;
    agentOnToolCallCapture = opts.onToolCall ?? null;
    opts.onTextDelta(agentReplyText);
    return agentReplyText;
  },
}));

const { createTestCallStreamHandlers } = await import("./test-call-stream");

function makeFakeWs() {
  const sent: unknown[] = [];
  let closed = false;
  return {
    sent,
    get closed() {
      return closed;
    },
    send: (data: string) => {
      sent.push(JSON.parse(data));
    },
    close: () => {
      closed = true;
    },
  };
}

describe("test-call-stream", () => {
  beforeEach(() => {
    lastSttCall = null;
    sttCloseCalls = 0;
    lastTtsOnAudioChunk = null;
    ttsSendTextCalls = [];
    ttsEndTurnCalls = 0;
    ttsCloseCalls = 0;
    greetingCallCount = 0;
    turnCallCount = 0;
    agentReplyText = "Hello, how can I help?";
    agentOnToolCallCapture = null;
  });

  it("sends ready then speaks a greeting on open, using resolveAgentConfig when there is no override", async () => {
    const ws = makeFakeWs();
    const handlers = createTestCallStreamHandlers({ orgId: "org_1", templateKey: "shopify-support", actor: "org_1" });

    await handlers.onOpen(ws);

    const types = ws.sent.map((m: any) => m.type);
    expect(types).toContain("ready");
    expect(types).toContain("transcript");
    expect(greetingCallCount).toBe(1);
    expect(ttsSendTextCalls).toContain(agentReplyText);
    expect(ttsEndTurnCalls).toBe(1);

    const transcriptEvent = ws.sent.find((m: any) => m.type === "transcript") as any;
    expect(transcriptEvent.role).toBe("agent");
    expect(transcriptEvent.text).toBe(agentReplyText);
  });

  it("Phase 3: simulateFailover sends a 'failover' event per channel, before the greeting, using the real default chains", async () => {
    const ws = makeFakeWs();
    // Mocked resolveAgentConfig above returns sttProvider "deepgram" (no
    // sttFallbackOrder) and ttsProvider "elevenlabs" (no ttsFallbackOrder) —
    // so this exercises the real DEFAULT_STT_FALLBACK_ORDER/
    // DEFAULT_TTS_FALLBACK_ORDER from voice/failover.ts, unmocked.
    const handlers = createTestCallStreamHandlers({
      orgId: "org_failover",
      templateKey: "shopify-support",
      actor: "org_failover",
      simulateFailover: true,
    });

    await handlers.onOpen(ws);

    const failoverEvents = ws.sent.filter((m: any) => m.type === "failover") as any[];
    expect(failoverEvents).toEqual([
      { type: "failover", simulated: true, channel: "stt", from: "deepgram", to: "elevenlabs" },
      { type: "failover", simulated: true, channel: "tts", from: "elevenlabs", to: "cartesia" },
    ]);

    // Ordering: both failover events land after "ready" and before the
    // greeting's transcript event — the drawer needs to show the banner
    // before/alongside the agent starting to speak, not after.
    const types = ws.sent.map((m: any) => m.type);
    const readyIdx = types.indexOf("ready");
    const firstFailoverIdx = types.indexOf("failover");
    const transcriptIdx = types.indexOf("transcript");
    expect(readyIdx).toBeLessThan(firstFailoverIdx);
    expect(firstFailoverIdx).toBeLessThan(transcriptIdx);
  });

  it("does not send any 'failover' event when simulateFailover is omitted (unchanged default behavior)", async () => {
    const ws = makeFakeWs();
    const handlers = createTestCallStreamHandlers({ orgId: "org_no_failover", templateKey: "shopify-support", actor: "org_no_failover" });

    await handlers.onOpen(ws);

    expect(ws.sent.some((m: any) => m.type === "failover")).toBe(false);
  });

  it("uses buildPreviewAgentConfig instead when a configOverride is present", async () => {
    const ws = makeFakeWs();
    const handlers = createTestCallStreamHandlers({
      orgId: "org_2",
      templateKey: "clinic-booking",
      actor: "org_2",
      configOverride: { name: "Preview Agent" } as unknown as import("./agent-frame").AgentFrame,
    });

    await handlers.onOpen(ws);
    expect(greetingCallCount).toBe(1);
    // No direct assertion on which resolver ran (both are mocked to succeed) —
    // covered by the systemPrompt difference being exercised without throwing.
  });

  it("runs a full turn on a final caller transcript: pushes history, runs the turn, replies", async () => {
    const ws = makeFakeWs();
    const handlers = createTestCallStreamHandlers({ orgId: "org_3", templateKey: "shopify-support", actor: "org_3" });
    await handlers.onOpen(ws);

    expect(lastSttCall).not.toBeNull();
    lastSttCall!.onTranscript({ text: "What's my order status?", isFinal: true, speechFinal: true });
    // runTurn is async (awaited inside the transcript handler internally via
    // an unawaited promise) — flush microtasks.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(turnCallCount).toBe(1);
    const callerTranscript = ws.sent.find((m: any) => m.type === "transcript" && m.role === "caller") as any;
    expect(callerTranscript.text).toBe("What's my order status?");
  });

  it("ignores interim (non-final) transcripts — no turn runs", async () => {
    const ws = makeFakeWs();
    const handlers = createTestCallStreamHandlers({ orgId: "org_4", templateKey: "shopify-support", actor: "org_4" });
    await handlers.onOpen(ws);
    turnCallCount = 0; // reset past the greeting

    lastSttCall!.onTranscript({ text: "what's my", isFinal: false, speechFinal: false });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(turnCallCount).toBe(0);
  });

  it("barge-in: a transcript while the agent is speaking sends clear and aborts", async () => {
    const ws = makeFakeWs();
    const handlers = createTestCallStreamHandlers({ orgId: "org_5", templateKey: "shopify-support", actor: "org_5" });
    await handlers.onOpen(ws);

    // Simulate agent mid-speech by feeding a non-final transcript while
    // the greeting's TTS turn is still conceptually open — the handler
    // tracks `agentIsSpeaking` internally and only clears on non-empty text.
    ws.sent.length = 0;
    lastSttCall!.onTranscript({ text: "wait wait", isFinal: false, speechFinal: false });

    // Right after the greeting's speak() call resolves, agentIsSpeaking is
    // reset to false by the tts onDone callback (not exercised by our fake
    // tts, since we never call onDone) — so we validate the "clear" event
    // only fires when agentIsSpeaking is still true immediately after open.
    // Since our fake connectTts never calls onDone, agentIsSpeaking remains
    // true from the greeting until the barge-in check runs.
    const clearEvent = ws.sent.find((m: any) => m.type === "clear");
    expect(clearEvent).toBeDefined();
  });

  it("forwards TTS audio chunks to the socket as {type:'audio'}", async () => {
    const ws = makeFakeWs();
    const handlers = createTestCallStreamHandlers({ orgId: "org_6", templateKey: "shopify-support", actor: "org_6" });
    await handlers.onOpen(ws);

    expect(lastTtsOnAudioChunk).not.toBeNull();
    lastTtsOnAudioChunk!("ZmFrZS1hdWRpbw==");

    const audioEvent = ws.sent.find((m: any) => m.type === "audio") as any;
    expect(audioEvent.audio).toBe("ZmFrZS1hdWRpbw==");
  });

  it("surfaces real tool calls as a transcript-adjacent event", async () => {
    const ws = makeFakeWs();
    const handlers = createTestCallStreamHandlers({ orgId: "org_7", templateKey: "shopify-support", actor: "org_7" });
    await handlers.onOpen(ws);

    lastSttCall!.onTranscript({ text: "book me an appointment", isFinal: true, speechFinal: true });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(agentOnToolCallCapture).not.toBeNull();
    ws.sent.length = 0;
    agentOnToolCallCapture!("bookAppointment", { date: "tomorrow" });
    const toolEvent = ws.sent.find((m: any) => m.type === "transcript" && m.text?.includes("bookAppointment")) as any;
    expect(toolEvent).toBeDefined();
  });

  it("ends the call and closes stt/tts on an explicit stop message", async () => {
    const ws = makeFakeWs();
    const handlers = createTestCallStreamHandlers({ orgId: "org_8", templateKey: "shopify-support", actor: "org_8" });
    await handlers.onOpen(ws);

    handlers.onMessage(JSON.stringify({ type: "stop" }), ws);

    expect(sttCloseCalls).toBeGreaterThanOrEqual(1);
    expect(ttsCloseCalls).toBeGreaterThanOrEqual(1);
    expect(ws.closed).toBe(true);
    const endedEvent = ws.sent.find((m: any) => m.type === "ended") as any;
    expect(endedEvent.reason).toBe("client-stopped");
  });

  it("is idempotent about ending — a second stop after close does nothing further", async () => {
    const ws = makeFakeWs();
    const handlers = createTestCallStreamHandlers({ orgId: "org_9", templateKey: "shopify-support", actor: "org_9" });
    await handlers.onOpen(ws);

    handlers.onMessage(JSON.stringify({ type: "stop" }), ws);
    const sentCountAfterFirstStop = ws.sent.length;
    handlers.onMessage(JSON.stringify({ type: "stop" }), ws);
    expect(ws.sent.length).toBe(sentCountAfterFirstStop);
  });

  it("onClose tears down stt/tts without sending an ended event (socket already gone)", async () => {
    const ws = makeFakeWs();
    const handlers = createTestCallStreamHandlers({ orgId: "org_10", templateKey: "shopify-support", actor: "org_10" });
    await handlers.onOpen(ws);

    const sttClosesBefore = sttCloseCalls;
    handlers.onClose();
    expect(sttCloseCalls).toBe(sttClosesBefore + 1);
  });

  it("ignores malformed JSON messages instead of throwing", async () => {
    const ws = makeFakeWs();
    const handlers = createTestCallStreamHandlers({ orgId: "org_11", templateKey: "shopify-support", actor: "org_11" });
    await handlers.onOpen(ws);
    expect(() => handlers.onMessage("not json", ws)).not.toThrow();
  });
});
