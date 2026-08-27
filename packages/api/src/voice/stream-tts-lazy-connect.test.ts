import { mock, describe, it, expect, beforeEach } from "bun:test";
import {
  createDbHarness,
  createSttHarness,
  twilioClientHarnessModule,
  createOrgQueriesHarness,
  leadsHarnessModule,
  fakeWs,
  buildStartEvent,
} from "./test-helpers/stream-harness";
import { clearTtsCacheForTests } from "./tts-cache";

/**
 * Defect (ADR-083): "the agent's voice changed partway through the call, and
 * the provider was healthy the whole time."
 *
 * stream.ts used to open the per-turn TTS websocket at the *top* of the turn,
 * before generate() had run the LLM and any tool round-trips. On a turn with a
 * tool call that gap is seconds long, and both live providers hang up on a
 * socket nobody has spoken on:
 *
 *   Cartesia: close code 1000 "connection idle timeout"
 *   Sarvam:   close code 408 "Websocket was left open without any messages for too long."
 *
 * That close arrived at stream.ts's `onError`, which could not distinguish
 * "this provider is broken" from "we connected too early". So it burned a link
 * off the per-call failover chain, recorded a provider failover, and — because
 * failover is deliberately sticky for the rest of the call (see
 * stream-tts-voice-identity.test.ts) — permanently moved the caller onto a
 * different provider's default voice.
 *
 * Phase C1 (2026-08-24, docs/plans/phase-c-latency.md): stream.ts now holds
 * one TTS *session* per call instead of reconnecting every turn — see
 * getOrOpenTtsSession/closeTtsSession in stream.ts. The mock below models a
 * session, not a one-shot connection: `sessionOpens` records one entry per
 * actual new socket (connectTtsSession call), separate from how many turns
 * ran on it. Three guarantees are asserted here:
 *   1. Exactly one socket opens for the whole call under healthy conditions
 *      (the pre-warm at call start) — turns after it reuse the same session.
 *   2. A session that dies without ever being handed a turn's text is not
 *      treated as a provider failure: the next turn reconnects transparently
 *      on the same provider, same voice, chain intact.
 *   3. A turn that produces no text at all still releases the ttsDone waiter
 *      instead of stalling.
 */

type SessionRecord = {
  provider: string | undefined;
  voiceId: string | undefined;
  dead: boolean;
};
let sessionOpens: SessionRecord[] = [];
/** Providers whose session reports failure before any turn is ever started on
 * it — models an immediate connect rejection / idle close between turns. */
let failOnConnectProviders = new Set<string>();
/** Providers that fail only once a turn has sent text: a genuine synthesis
 * fault, which must still fail over. */
let failAfterTextProviders = new Set<string>();
/** Providers that deliver one real audio chunk and THEN die — models a
 * genuine mid-speech provider failure (bug fix, 2026-08-27): unlike
 * failAfterTextProviders (dies before any audio ever reached the caller),
 * here turnTtsFirstByteMs is already set by the time onError fires, which is
 * the branch that must NOT fail over and must instead recover with a short
 * spoken line. */
let failMidSpeechProviders = new Set<string>();
/** Every string handed to a session's sendText, across all providers/turns —
 * lets a test assert the recovery line actually got spoken. */
let sentTexts: string[] = [];

/** Resolved by the test to release a turn that is "waiting on a tool call",
 * reproducing the dead air the socket used to idle through. */
let releaseTurn: (() => void) | null = null;

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

let transcriptInserts: Record<string, unknown>[] = [];

const db = createDbHarness({
  tables: { calls: [callRow] },
  onInsert: (table, values) => {
    if (table === "transcripts") transcriptInserts.push(values);
  },
});
const stt = createSttHarness();

mock.module("../database", db.module);
mock.module("./stt", stt.module);

mock.module("./tts", () => ({
  // Session-based reuse (Phase C1) — one call per actual new socket, not per
  // turn. `startTurn` is what a per-turn `attemptTts` invokes.
  connectTtsSession: (
    providerOverride?: string | null,
    voiceId?: string,
    _language?: string,
    onConnected?: (ms: number) => void,
  ) => {
    const provider = providerOverride ?? "cartesia";
    const record: SessionRecord = { provider, voiceId, dead: false };
    sessionOpens.push(record);
    onConnected?.(0);
    const failsOnFirstUse = failOnConnectProviders.has(String(provider));
    const failsAfterText = failAfterTextProviders.has(String(provider));
    const failsMidSpeech = failMidSpeechProviders.has(String(provider));
    return {
      provider,
      session: {
        startTurn(
          onAudioChunk: (b: string) => void,
          onDone?: () => void,
          onError?: (e: unknown) => void,
          onWordTimestamp?: (word: string, startMs: number, endMs: number) => void,
        ) {
          if (failsOnFirstUse) {
            // Synchronously, before startTurn has even returned — the
            // hostile ordering the TDZ guard in stream.ts exists for (a real
            // provider is free to report an idle-timeout close the instant
            // it's asked to do anything, before any text was ever sent).
            onError?.(new Error(`simulated ${provider} idle close (code 1000)`));
          }
          return {
            sendText: (text: string) => {
              sentTexts.push(text);
              if (failsAfterText) {
                // A real timer tick, not queueMicrotask: a genuine provider
                // failure always arrives via real network I/O (a WebSocket
                // close event), which is never same-tick with the mocked
                // LLM's near-instant generate() — using a real macrotask
                // here keeps this mock's ordering honest instead of racing
                // against native promise-settling microtasks.
                setTimeout(() => onError?.(new Error(`simulated ${provider} synthesis failure`)), 0);
                return;
              }
              if (failsMidSpeech) {
                // One real chunk (and one real word, so spokenWords-based
                // history truncation has something to work with) reaches the
                // caller first — turnTtsFirstByteMs is set by the time the
                // connection dies, unlike failAfterTextProviders above.
                onAudioChunk(Buffer.from(`audio-from-${provider}`).toString("base64"));
                onWordTimestamp?.(text.split(" ")[0] ?? text, 0, 100);
                queueMicrotask(() => onError?.(new Error(`simulated ${provider} mid-speech death`)));
                return;
              }
              onAudioChunk(Buffer.from(`audio-from-${provider}`).toString("base64"));
            },
            endTurn: () => onDone?.(),
            close: () => {
              record.dead = true;
            },
          };
        },
        // Looks open right up until a turn actually tries it and discovers
        // the idle-timeout — matches isOpen() being a live readyState check
        // in the real providers, not something that predicts a future close.
        isOpen: () => !record.dead,
        close: () => {
          record.dead = true;
        },
      },
    };
  },
  // One-shot shape — still used by warmFillerCache (flag-gated off in this
  // test) and stream.ts statically imports it, so it must exist regardless.
  connectTts: () => ({
    sendText: () => {},
    endTurn: () => {},
    close: () => {},
  }),
  resolveTtsProvider: (override?: string | null) => override ?? "cartesia",
}));

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
    // A real LLM call always costs genuine wall-clock time before it
    // resolves — long enough that any TTS-side failure this same text
    // triggered (a real network event, never same-tick with generate())
    // has already been detected. Modeling that here, instead of resolving
    // instantly, is what makes the mid-speech/dead-air recovery tests below
    // exercise a realistic ordering rather than an artifact of this mock
    // being faster than anything in production.
    await new Promise((resolve) => setTimeout(resolve, 150));
    return "Hello, this is the agent.";
  },
  // Models the real shape of a tool-using turn: the LLM emits nothing until a
  // tool round-trip completes, THEN streams its text.
  runVoiceAgentTurn: async ({ onTextDelta }: { onTextDelta?: (d: string) => void }) => {
    if (releaseTurn) {
      await new Promise<void>((resolve) => {
        releaseTurn = resolve;
      });
    }
    onTextDelta?.("Sure, I can help with that.");
    return "Sure, I can help with that.";
  },
}));

mock.module("./twilio-client", twilioClientHarnessModule);
mock.module("./org-queries", createOrgQueriesHarness().module);
mock.module("./leads/leads", leadsHarnessModule);

const { createVoiceStreamHandlers } = await import("./stream");

const START_EVENT = buildStartEvent();

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

beforeEach(() => {
  sessionOpens = [];
  failOnConnectProviders = new Set();
  failAfterTextProviders = new Set();
  failMidSpeechProviders = new Set();
  sentTexts = [];
  transcriptInserts = [];
  releaseTurn = null;
  // The hybrid-audio-cache Map (tts-cache.ts) is process-module-global, not
  // per-call — without this, the mid-speech-recovery tests below would only
  // ever exercise a real TTS attempt on whichever test happens to run
  // first; every later test gets a cache hit for the recovery line's exact
  // text and skips the mock provider (and its simulated failure) entirely.
  clearTtsCacheForTests();
});

describe("TTS session reuse across turns (Phase C1) and the idle-close carve-out (ADR-083)", () => {
  it("opens exactly one socket for the whole call — later turns reuse it, including one that waits on a tool round-trip", async () => {
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();
    await handlers.onMessage(START_EVENT, ws);
    await settle();

    // The greeting is served by the pre-warmed session opened at call start.
    expect(sessionOpens.length).toBe(1);
    expect(sessionOpens[0]).toMatchObject({ provider: "cartesia", voiceId: "cartesia-voice-uuid" });

    // Arm the "waiting on a tool" turn, then let the caller speak.
    releaseTurn = () => {};
    stt.getLastOnTranscript()?.({ text: "what is my order status", isFinal: true, speechFinal: true });
    await settle();

    // Still mid-tool-call, no text produced yet — no new socket, same as
    // before this change (the reuse doesn't make this guarantee weaker: a
    // socket that opened too early still risks an idle-timeout kill).
    expect(sessionOpens.length).toBe(1);

    // Tool returns, text streams — served by the SAME session, not a new one.
    releaseTurn?.();
    await settle();
    expect(sessionOpens.length).toBe(1);

    handlers.onClose();
  });

  it("treats a session that died before this turn's text as an idle close, not a provider failure — reconnects on the same provider", async () => {
    // The pre-warmed session for cartesia is dead on arrival (models an idle
    // timeout that fired between the greeting and this turn).
    failOnConnectProviders.add("cartesia");

    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();
    await handlers.onMessage(START_EVENT, ws);
    await settle();

    // Every session opened (the dead pre-warm, and every reconnect after it)
    // stays on the configured provider and voice — the old code would have
    // shifted "elevenlabs" off the chain and stuck the rest of the call on
    // its default voice.
    expect(sessionOpens.length).toBeGreaterThanOrEqual(1);
    for (const s of sessionOpens) {
      expect(s.provider).toBe("cartesia");
      expect(s.voiceId).toBe("cartesia-voice-uuid");
    }
    expect(sessionOpens.some((s) => s.provider === "elevenlabs")).toBe(false);

    handlers.onClose();
  });

  it("still fails over when the provider breaks after text was sent", async () => {
    // Regression guard: the idle-close carve-out must not swallow real faults.
    failAfterTextProviders.add("cartesia");

    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();
    await handlers.onMessage(START_EVENT, ws);
    await settle();

    expect(sessionOpens.length).toBeGreaterThanOrEqual(2);
    expect(sessionOpens[0]).toMatchObject({ provider: "cartesia", voiceId: "cartesia-voice-uuid" });
    expect(sessionOpens[1]?.provider).toBe("elevenlabs");
    expect(sessionOpens[1]?.voiceId).toBeUndefined();

    handlers.onClose();
  });

  it("does not stall the turn when it ends without ever producing text", async () => {
    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();
    await handlers.onMessage(START_EVENT, ws);
    await settle();
    const afterGreeting = sessionOpens.length;

    // A turn that resolves with no deltas at all: endTurn() runs against a
    // connection that was never created. It must release the ttsDone waiter
    // rather than leaving the turn to burn its full 8s timeout.
    const started = Date.now();
    stt.getLastOnTranscript()?.({ text: "hello", isFinal: true, speechFinal: true });
    await settle();

    expect(Date.now() - started).toBeLessThan(2000);
    expect(sessionOpens.length).toBeGreaterThanOrEqual(afterGreeting);

    handlers.onClose();
  });
});

/**
 * Bug fix (2026-08-27): a TTS connection dying *after* it had already
 * produced audio this turn used to just end the turn in silence — no
 * failover (correct, avoiding a mid-sentence voice switch), but also no
 * recovery and no correction to what got recorded as "said". The caller sat
 * through the full silence-timeout window with zero acknowledgment, and the
 * transcript/history recorded the LLM's full intended reply as spoken even
 * though playback was cut off partway through.
 */
describe("mid-speech TTS failure recovery", () => {
  it("does not fail over (same provider, same voice) but speaks a short recovery line instead of leaving dead air", async () => {
    failMidSpeechProviders.add("cartesia");

    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();
    await handlers.onMessage(START_EVENT, ws);
    await settle();

    // No failover: every session opened this call is still cartesia. A
    // mid-speech death is deliberately not a chain-burning event.
    expect(sessionOpens.length).toBeGreaterThan(0);
    for (const s of sessionOpens) expect(s.provider).toBe("cartesia");

    // The recovery line was actually sent to TTS, not just logged.
    expect(sentTexts.some((t) => /cut off/i.test(t))).toBe(true);

    handlers.onClose();
  });

  it("truncates the transcript to what was actually spoken, for both the interrupted turn and the recovery line itself", async () => {
    failMidSpeechProviders.add("cartesia");

    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();
    await handlers.onMessage(START_EVENT, ws);
    await settle();

    const agentRows = transcriptInserts.filter((r) => r.role === "agent");
    expect(agentRows.length).toBeGreaterThanOrEqual(2);

    // The greeting's row is not the full untruncated text — it lost its TTS
    // connection mid-speech, and spokenWords (the mock delivers exactly one
    // word before dying) is what the caller genuinely heard.
    expect(agentRows[0]?.text).toBe("Hello,");

    // The recovery line dies mid-speech too in this scenario (same broken
    // provider, still failing) — its own transcript row is truncated the
    // same way, to its first spoken word, not the full "...cut off..." line.
    expect(agentRows[1]?.text).toBe("Sorry,");

    handlers.onClose();
  });

  it("does not loop when the recovery line itself dies mid-speech — recovers once, not recursively", async () => {
    failMidSpeechProviders.add("cartesia");

    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();
    await handlers.onMessage(START_EVENT, ws);
    await settle();

    // Exactly one recovery attempt: the greeting's turn plus one recovery
    // line, never a third or further "cut off" line chasing its own tail.
    const recoveryAttempts = sentTexts.filter((t) => /cut off/i.test(t));
    expect(recoveryAttempts.length).toBe(1);

    handlers.onClose();
  });
});

/**
 * Bug fix (2026-08-27, found investigating a live-call complaint about a
 * "[voice] DEAD AIR on turn N" log with no caller-facing consequence
 * attached to it): a turn where EVERY provider in the failover chain fails
 * before producing a single audio byte previously just logged that DEAD AIR
 * line (pure observability, ADR-101) and ended the turn — the caller heard
 * nothing at all, and there was no recovery of any kind. Gets the identical
 * recovery treatment as the mid-speech case above (turnTtsProducedNoAudio,
 * stream.ts).
 */
describe("zero-audio (DEAD AIR) TTS failure recovery", () => {
  it("speaks a recovery line when the entire failover chain fails before any audio plays", async () => {
    // Exhausts the whole default chain (cartesia primary, then elevenlabs,
    // then sarvam) with zero bytes ever produced. Each hop's failure is a
    // real setTimeout (not queueMicrotask — see the mock's own comment
    // above), so the three-hop chain takes real, if small, wall-clock time
    // to fully unwind — real enough that it needs runVoiceAgentGreeting's
    // own artificial 150ms delay (this file's mock, near the top) to
    // reliably win the race against the recovery-check code that runs
    // immediately once `generate()` resolves. In production this is a
    // non-issue: a genuine LLM call always costs far more than the ~40ms a
    // three-hop provider retry chain takes here, so the failure is always
    // long since detected by the time generate() returns.
    failAfterTextProviders.add("cartesia");
    failAfterTextProviders.add("elevenlabs");
    failAfterTextProviders.add("sarvam");

    const handlers = createVoiceStreamHandlers("twilio");
    const ws = fakeWs();
    await handlers.onMessage(START_EVENT, ws);
    await settle();

    expect(sentTexts.some((t) => /cut off/i.test(t))).toBe(true);

    handlers.onClose();
  });
});
