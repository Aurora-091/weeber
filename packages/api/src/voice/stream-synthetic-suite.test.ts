import { mock, describe, it, expect, beforeEach } from "bun:test";
import {
  createDbHarness,
  createSttHarness,
  twilioClientHarnessModule,
  createOrgQueriesHarness,
  leadsHarnessModule,
  fakeWs,
  settle,
  buildStartEvent,
} from "./test-helpers/stream-harness";

/**
 * The assembled synthetic suite `phase-d-conversation.md`'s exit gate keeps
 * referencing (conditions 1, 8, 9, 10 all say "across the synthetic suite")
 * was never actually built as one thing — each D-item shipped its own
 * isolated `stream-*.test.ts` file instead (D1: stream-idle-prompt-bargein,
 * D6: turn-detection/dictation.test.ts, D7:
 * barge-in.test.ts/agent.test.ts's wiring tests, D8:
 * stream-critical-field-spellback). Isolated coverage is real coverage, but
 * it never proved these mechanisms hold up TOGETHER, in one call, the way a
 * real caller would actually exercise several of them back to back.
 *
 * `packages/api/src/voice/synthetic-test.ts` (Misc-9's AI-to-AI text suite)
 * is a different, text-only architecture — two LLMs exchanging full turns,
 * with no STT interim events, no audio timing, no barge-in — and by its own
 * doc comment cannot exercise D1/D6/D7 at all (all three live at the
 * STT-interim/audio-timing layer, strictly below where that framework
 * operates). D8 is the one D-item actually reachable from a text-turn
 * exchange; D1/D6/D7 can only be driven the way stream-*.test.ts already
 * does — through the real `createVoiceStreamHandlers` state machine with
 * simulated STT/TTS timing. This file is that: ONE simulated call exercising
 * D6, D7 (item 2, disclosure), and D8 in sequence, using the shared harness.
 *
 * D7 item 1 (non-interruptible TOOL CALLS) is deliberately NOT re-tested
 * here: it lives inside agent.ts's `buildVoiceTools`/`withNonInterruptible`,
 * which every stream-*.test.ts file (including this one) bypasses by mocking
 * `./agent` entirely — agent.test.ts's own wiring tests are the right layer
 * for that, not a duplicate here.
 */

type CapturedFieldRow = { value: string | null; heard: string; transcriptId: number | null; turn: number; askCount?: number };

let persistedCapturedStates: Record<string, CapturedFieldRow>[] = [];
let dbUpdates: { table: string | undefined; values: Record<string, unknown> }[] = [];
let turnCallCount = 0;
/** One entry per turn-level TTS `close()` call — the observable signature of
 * a barge-in actually cutting audio off, same technique
 * stream-idle-prompt-bargein.test.ts uses. */
let turnCancelCalls = 0;
/** Fires with the text handed to TTS, from inside the `await speak(...)` a
 * turn is suspended on — the only place a test can land inside the window
 * D7 item 2 protects. */
let onTtsSendText: ((text: string) => void) | null = null;

const callRow = { id: 1, orgId: "org-1", direction: "inbound", status: "in-progress" };

const db = createDbHarness({
  tables: { calls: [callRow] },
  onUpdate: (table, values) => {
    dbUpdates.push({ table, values });
    if (values.capturedState) {
      persistedCapturedStates.push(values.capturedState as Record<string, CapturedFieldRow>);
    }
  },
});
const stt = createSttHarness();

mock.module("../database", db.module);
mock.module("./stt", stt.module);

// Custom TTS mock (not the vanilla harness one): this file's whole point is
// interruption/turn-cancel timing, which the vanilla mock doesn't expose.
mock.module("./tts", () => ({
  connectTts: (onAudioChunk: (b: string) => void, onDone?: () => void) => ({
    sendText: (text: string) => {
      onTtsSendText?.(text);
      onAudioChunk(Buffer.from(text).toString("base64"));
    },
    endTurn: () => onDone?.(),
    close: () => {
      turnCancelCalls += 1;
    },
  }),
  connectTtsSession: (providerOverride?: string | null, _voiceId?: string, _language?: string, onConnected?: (ms: number) => void) => {
    onConnected?.(0);
    return {
      provider: providerOverride ?? "cartesia",
      session: {
        startTurn: (onAudioChunk: (b: string) => void, onDone?: () => void) => ({
          sendText: (text: string) => {
            onTtsSendText?.(text);
            onAudioChunk(Buffer.from(text).toString("base64"));
          },
          endTurn: () => onDone?.(),
          close: () => {
            turnCancelCalls += 1;
          },
        }),
        isOpen: () => true,
        close: () => {},
      },
    };
  },
  resolveTtsProvider: (override?: string | null) => override ?? "cartesia",
}));

type OnToolCall = (name: string, input: unknown, output: unknown) => void;

/** Toggled by the negative-control test below — proves D7 item 2's
 * protection is specific to a disclosure-configured call, not a blanket
 * "greetings are never interruptible" behavior. */
let disclosureEnabled = true;

mock.module("./agent", () => ({
  composeSystemPrompt: (opts: { jobDescription: string }) => ({ text: opts.jobDescription, segments: [] }),
  hasExhaustedField: () => false,
  // D7 item 2: disclosureConfigured (stream.ts) turns on whenever
  // resolveAgentConfig reports a disclosureText/Version — exactly what a
  // real org with recording-consent configured looks like.
  resolveAgentConfig: async () => ({
    systemPrompt: "You are a test agent.",
    ttsProvider: "cartesia",
    voiceId: undefined,
    llmProvider: "gateway",
    sttProvider: "deepgram",
    language: "en",
    disclosureText: disclosureEnabled ? "This call may be recorded for quality and training purposes." : undefined,
  }),
  // The greeting IS the disclosure-bearing turn (withDisclosure prepends it
  // in the real prompt) — this mock just needs to speak something long
  // enough to give the injected barge-in attempt a real window to land in.
  // Text mirrors `disclosureEnabled` for the negative-control test's clarity
  // (disclosureConfigured is a separate DB-config flag stream.ts reads off
  // resolveAgentConfig, not derived from what text is actually spoken — but
  // an ordinary non-disclosure greeting realistically wouldn't say this).
  runVoiceAgentGreeting: async ({ onTextDelta }: { onTextDelta?: (d: string) => void }) => {
    const text = disclosureEnabled
      ? "This call may be recorded for quality and training purposes. Hi, thanks for calling — how can I help?"
      : "Hi, thanks for calling — how can I help?";
    onTextDelta?.(text);
    return text;
  },
  // Turn 1: caller states their name, model mishears "Jon" (a real word that
  // genuinely appears in the caller's speech this turn — an STT mis-hearing,
  // not an invented value). Turn 2: caller corrects during spell-back; model
  // re-captures the corrected value for the same key.
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
mock.module("./org-queries", createOrgQueriesHarness().module);
mock.module("./leads/leads", leadsHarnessModule);

const { createVoiceStreamHandlers } = await import("./stream");

const START_EVENT = buildStartEvent();

beforeEach(() => {
  persistedCapturedStates = [];
  dbUpdates = [];
  turnCallCount = 0;
  turnCancelCalls = 0;
  onTtsSendText = null;
  disclosureEnabled = true;
});

describe("assembled synthetic suite — D6 + D7(item 2) + D8 compose correctly in one call", () => {
  it("a barge-in attempt during the disclosure-bearing greeting does not cut it off (D7)", async () => {
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();

    let bargeInAttempted = false;
    // Fires once the greeting's text is handed to TTS — lands inside the
    // exact suspended `await speak(...)` window D7 item 2 protects.
    onTtsSendText = (spoken) => {
      if (!spoken.includes("may be recorded")) return;
      onTtsSendText = null;
      bargeInAttempted = true;
      stt.getLastOnTranscript()?.({ text: "wait hold on stop", isFinal: false, speechFinal: false });
    };

    await handlers.onMessage(START_EVENT, ws);
    await settle(30);

    // Prove the injection actually fired — otherwise the assertions below
    // would pass vacuously if the tone-tag filter ever changed how it
    // chunks text handed to TTS.
    expect(bargeInAttempted).toBe(true);
    // The disclosure-bearing greeting was never cut off — nonInterruptibleCounter
    // kept decideBargeIn from ever firing turnAbortController.abort(), so the
    // turn-level TTS handle was never close()'d mid-flight.
    expect(turnCancelCalls).toBe(0);
    // And the DB shows the normal, uninterrupted completion signature: a
    // disclosureFiredAt stamp landed.
    expect(dbUpdates.some((u) => u.table === "calls" && "disclosureFiredAt" in u.values)).toBe(true);

    handlers.onClose();
  });

  it("negative control: with no disclosure configured, the same barge-in DOES cut the greeting off", async () => {
    disclosureEnabled = false;
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();

    let bargeInAttempted = false;
    onTtsSendText = (spoken) => {
      if (!spoken.includes("Hi, thanks for calling")) return;
      onTtsSendText = null;
      bargeInAttempted = true;
      stt.getLastOnTranscript()?.({ text: "wait hold on stop", isFinal: false, speechFinal: false });
    };

    await handlers.onMessage(START_EVENT, ws);
    await settle(30);

    expect(bargeInAttempted).toBe(true);
    // Proves D7 item 2's protection is specific to disclosureConfigured —
    // an ordinary greeting with nothing to protect is still interruptible,
    // exactly like every other turn.
    expect(turnCancelCalls).toBeGreaterThan(0);

    handlers.onClose();
  });

  it("a mid-spelling pause does not trigger a turn, and a corrected spell-back overwrites the mis-hearing (D6 + D8)", async () => {
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();

    await handlers.onMessage(START_EVENT, ws);
    await settle(30);
    const turnsAfterGreeting = turnCallCount;

    // D6: ends on a lone spelled-out letter — DictationSequenceDetector must
    // judge this still-spelling and withhold the turn entirely (no call to
    // the mocked runVoiceAgentTurn at all).
    stt.getLastOnTranscript()?.({ text: "My name is J", isFinal: true, speechFinal: true });
    await settle(30);
    expect(turnCallCount).toBe(turnsAfterGreeting);

    // Caller continues, now ending on a real word — a genuine turn fires,
    // and the mocked model mishears "Jon".
    stt.getLastOnTranscript()?.({ text: "My name is Jon actually", isFinal: true, speechFinal: true });
    await settle(30);
    expect(turnCallCount).toBe(turnsAfterGreeting + 1);
    expect(persistedCapturedStates.at(-1)?.caller_name).toMatchObject({ value: "Jon" });

    // D8: the caller corrects during spell-back — ends on a real word,
    // deliberately not a lone letter (same D6/D8 interaction this suite is
    // proving composes correctly, not two mechanisms that fight each other).
    stt.getLastOnTranscript()?.({
      text: "No, it's John, spelled J O H N, that's correct",
      isFinal: true,
      speechFinal: true,
    });
    await settle(30);
    expect(turnCallCount).toBe(turnsAfterGreeting + 2);

    const finalCapture = persistedCapturedStates.at(-1)?.caller_name;
    expect(finalCapture).toMatchObject({ value: "John" });
    expect(finalCapture?.value).not.toBe("Jon");

    handlers.onClose();
  });
});
