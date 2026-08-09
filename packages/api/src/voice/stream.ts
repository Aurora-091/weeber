import type { ModelMessage } from "ai";
import twilioPkg from "twilio";
const { VoiceResponse } = twilioPkg.twiml;
import { connectStt, resolveSttProvider } from "./stt";
import type { SttConnection } from "./stt";
import { connectTts, resolveTtsProvider } from "./tts";
import type { TtsConnection, TtsProvider } from "./tts";
import { voiceIdForProvider } from "./tts-voice-identity";
import { toolCallReason } from "./call-control";
import { resolveSttFailoverChain, resolveTtsFailoverChain } from "./failover";
import { runVoiceAgentTurn, runVoiceAgentGreeting, resolveAgentConfig } from "./agent";
import {
  resolveCartRecoveryContext,
  type CartRecoveryDiscountContext,
} from "./tools/offerCartRecoveryDiscount";
import { resolveCodOrderContext, type CodOrderContext } from "./tools/confirmCodOrder";
import { resolveCrmSyncContext, type CrmSyncContext } from "./tools/crmSync";
import { deriveGuardrailEventFields } from "./guardrail-events";
import type { AvailableToolName } from "./agent-frame";
import { sessionStore } from "./session-store";
import { getNumberConfig } from "./number-config";
import { runWorkflowForOutcome } from "./workflows/engine";
import { resumeWorkflowAfterCall } from "./workflows/graph-engine";
import type { WorkflowOutcome } from "./workflows/types";
import { dispatchWebhook, resolveWebhookUrl } from "./webhooks";
import { getCallerMemory, upsertCallerMemory, resolveHumanNumber } from "./caller-memory";
import { promoteLeadFromCall, getLeadGreetingContext } from "./leads/leads";
import { getTwilioClientForOrg, getPublicUrl } from "./twilio-client";
import { hangupPlivoCall, transferPlivoCall } from "./plivo-client";
import { sendSmsForOrg } from "./send-sms";
import { buildDtmfAudio, isValidDtmfSequence } from "./dtmf";
import { getCachedTtsAudio, setCachedTtsAudio, HYBRID_AUDIO_CACHE_FLAG } from "./tts-cache";
import { getEffectiveFlags } from "./org-queries";
import { resolveOrgIdForNumbers } from "./org-attribution";
import { renderTemplate } from "./workflows/variables";
import { createRollingNoiseFilter, applyNoiseFilterToMulaw, ADAPTIVE_NOISE_FILTER_FLAG } from "./audio-noise-filter";
import type { NoiseFilter } from "./audio-noise-filter";
import { createHighPassFilter, applyHighPassToMulaw, WIND_NOISE_FILTER_FLAG } from "./wind-noise-filter";
import type { HighPassFilter } from "./wind-noise-filter";
import { stripToneTag, CARTESIA_EMOTION_BY_TONE, TONE_TAG_MAX_BUFFER_CHARS, EXPRESSIVE_DELIVERY_FLAG } from "./tone-tags";
import { shouldBackchannel, BACKCHANNEL_FLAG, BACKCHANNEL_LINES } from "./backchannel";
import {
  createTurnDetector,
  HeuristicTurnDetector,
  SEMANTIC_TURN_DETECTION_FLAG,
  type TurnEndDetector,
} from "./turn-detection";
import { getTelephonyTransport, type TelephonyProvider } from "./telephony-transport";
import { estimateCallCostCents } from "./cost-estimate";
import { db } from "../database";
import { withRetry } from "../database/with-retry";
import { calls, transcripts, toolCalls, callLatency, turnLatency, orgs, optOutEvents, guardrailEvents } from "../database/schema";
import { classifyCallHealth } from "./call-health";
import { eq } from "drizzle-orm";

type Sendable = { send: (data: string) => void; close?: (code?: number, reason?: string) => void };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Heuristic-only estimate of remaining audio playback time after the TTS
 * provider has finished *sending* every chunk for this turn — sending isn't
 * the same as Twilio having finished *playing* it back to the caller.
 * ~18 characters/sec is a reasonably conservative average spoken pace.
 *
 * Audit 10 (2026-08-09): the old 4000 ms upper clamp made this actively
 * dangerous. A TTS provider streams a 12-second line in ~1-2s of wall clock,
 * so on any turn longer than ~73 characters this under-estimated by seconds —
 * and every consumer of this function treats it as "the caller has now heard
 * everything". That produced two live-call bugs: closing lines cut off
 * mid-sentence on the hangUp path, and (far worse) the caller-silence timer
 * being armed while ~10s of greeting audio was still in flight, so the agent
 * declared the caller silent and hung up on itself mid-greeting. 6/6
 * production calls died this way.
 *
 * The ceiling is gone: a long turn genuinely takes long to play, and pretending
 * otherwise is what broke calls. The floor stays (a one-word reply shouldn't
 * hinge on a sub-400ms estimate), and MAX_PLAYBACK_ESTIMATE_MS is a sanity
 * bound against a pathological multi-thousand-character turn wedging a call
 * open, not a model of speech.
 *
 * This is still an ESTIMATE and should be replaced by Twilio `mark` events
 * (ground truth for playback completion) — see audit 10's P0. The 55 ms/char
 * constant is uncalibrated against real Cartesia/Sarvam output and will be
 * wrong per-voice; it is deliberately conservative (slow) so the error costs
 * a slightly late timer rather than another self-terminated call.
 */
const MAX_PLAYBACK_ESTIMATE_MS = 60_000;

/**
 * How long we will wait for a closing/handoff line to play out before tearing
 * the call down anyway. Unlike the silence timer, this wait costs live PSTN
 * minutes, so it is capped much tighter than MAX_PLAYBACK_ESTIMATE_MS.
 */
const CLOSING_LINE_MAX_WAIT_MS = 15_000;

export function estimateRemainingPlaybackMs(text: string): number {
  return Math.min(Math.max(text.length * 55, 400), MAX_PLAYBACK_ESTIMATE_MS);
}

/**
 * Best-effort, defense-in-depth phrase detector for prompt-injection
 * attempts in raw caller speech — independent of whether the model itself
 * calls flagGuardrailEvent (see agent.ts's withCallControl persona
 * instructions). Not a filter/blocker — the model still decides how to
 * respond — this only guarantees the attempt is logged for dashboard
 * review even if the model doesn't self-report it.
 *
 * G1.5 (2026-08-01): moved to `./injection-detection` when it gained
 * Hinglish + Devanagari coverage — the same extract-and-re-export pattern
 * `endsMidThought` uses below, so existing importers keep working.
 */
export { looksLikePromptInjection } from "./injection-detection";
import { looksLikePromptInjection } from "./injection-detection";

/**
 * A1b (VAD/endpointing audit, 2026-07-14): the mid-thought regex check now
 * lives in `./turn-detection/heuristic` as the default `TurnEndDetector`
 * (Phase V, 2026-07-31). Re-exported here so existing importers (and
 * stream.test.ts) keep working unchanged.
 */
export { endsMidThought } from "./turn-detection/heuristic";

const SILENCE_WARNING_MS = 8000;
const SILENCE_HANGUP_MS = 7000;

/**
 * Bun WebSocket handler for a single Twilio Media Stream connection.
 * One instance of this state machine per live call.
 *
 * Flow: Twilio audio -> Deepgram STT -> LLM agent (streamed) -> ElevenLabs TTS
 * -> Twilio audio, with barge-in interrupting the agent/TTS the moment the
 * caller starts talking again. Every stage is wrapped defensively so one bad
 * event or a dropped upstream socket can't silently hang or crash the call —
 * worst case we log and end the call cleanly instead of leaving it stuck.
 */
export function createVoiceStreamHandlers(provider: TelephonyProvider = "twilio") {
  const transport = getTelephonyTransport(provider);
  let streamSid: string | null = null;
  let callSid: string | null = null;
  let dbCallId: number | null = null;
  let webhookUrl: string | null = null;
  let persona: string | undefined;
  let ttsProviderOverride: "elevenlabs" | "cartesia" | "sarvam" | undefined;
  let llmProviderOverride: "gateway" | "groq" | undefined;
  let sttProviderOverride: "deepgram" | "sarvam" | "elevenlabs" | undefined;
  let languageOverride: string | undefined;
  /** Cross-provider failover (2026-07-17) — per-agent override of the fallback
   * chain (voice/failover.ts), undefined = platform default chain. Read once
   * per call in the "start" handler alongside the other agentConfig overrides
   * above, then used by connectSttForCall/the TTS connect block below to
   * build the ordered list of providers to try if the primary one fails. */
  let sttFallbackOrderOverride: string[] | undefined;
  let ttsFallbackOrderOverride: string[] | undefined;
  let llmFallbackModelsOverride: string[] | undefined;
  // Tracks how many times THIS call has already failed over to a different
  // provider — persisted to calls.providerFailoverCount so it's visible on
  // the call record, same pattern as sttReconnectCount below.
  let providerFailoverCount = 0;
  // Mirror of the latest STT reconnect count for THIS call (the source of
  // truth is written to calls.sttReconnectCount from the reconnect callback);
  // kept in memory too so finalizeCall's health classification can read it
  // without a DB round-trip.
  let sttReconnectCount = 0;
  // Remaining STT providers to try if the current one hard-fails, for THIS
  // call — built lazily on the first fatal error (not upfront) since the
  // overwhelming majority of calls never need it. null = "not computed yet",
  // [] = "chain exhausted, next fatal error ends the call".
  let sttFailoverQueue: ("deepgram" | "sarvam" | "elevenlabs")[] | null = null;

  function recordProviderFailover() {
    providerFailoverCount++;
    if (!callSid) return;
    void withRetry(
      () => db.update(calls).set({ providerFailoverCount }).where(eq(calls.twilioCallSid, callSid!)),
      { label: "update-provider-failover-count" },
    );
  }
  /** Per-agent frame overrides (see agent-frame.ts, agent.ts's resolveAgentConfig) — all
   * undefined unless the call's org+template has a configured agent config row. */
  let ttsVoiceIdOverride: string | undefined;
  /**
   * Voice identity (see tts-voice-identity.ts). `ttsVoiceIdOverride` is only
   * legal for the provider it was picked from, so the provider is tracked
   * alongside it and the ID is dropped whenever a turn is synthesized by
   * anyone else.
   *
   * `activeTtsProvider` is the provider the caller is *currently* hearing —
   * the resolved primary at call start, then updated (for the rest of the
   * call, deliberately) the first time a cross-provider TTS failover fires.
   * Failover used to be rebuilt from the primary on every turn, so one
   * transient error made a single turn speak in the fallback provider's voice
   * and the next turn flip straight back: the agent audibly became a
   * different person and then changed back again. Sticky means the voice can
   * change at most once per call, which is the same voice-identity reasoning
   * ADR-060 used to reject mid-call language switching.
   */
  let ttsVoiceIdProvider: TtsProvider | undefined;
  let activeTtsProvider: TtsProvider | undefined;
  let llmModelOverride: string | undefined;
  let enabledToolsOverride: AvailableToolName[] | undefined;
  /**
   * G1.1 (2026-08-01): the merchant's authorized cart-recovery discount for
   * this specific call — shop, checkout ref, and percentage, all resolved
   * from the session's workflow metadata at "start" and then fixed for the
   * life of the call. Stays `undefined` for every call the merchant didn't
   * configure a discount on (which is most of them: any inbound call, any
   * non-cart-recovery workflow, and any cart-recovery attempt whose
   * configured percentage is 0), and `buildVoiceTools` responds by not
   * registering the discount tool at all. Deliberately NOT re-read per turn:
   * the discount a caller is offered must not change mid-conversation.
   */
  let cartRecoveryContext: CartRecoveryDiscountContext | undefined;
  /**
   * G1.3: the merchant workflow's pre-call context for this call
   * (`scheduledCalls.metadata`, carried onto the session by
   * `workflows/scheduler.ts`) — who we're calling, cart value, attempt number,
   * the authorized discount and code, the recovery link. Rendered into the
   * system prompt by `buildWorkflowContextBlock`. Until G1.3 this data reached
   * the session and was read by nothing, so an outbound cart-recovery agent
   * dialled a customer knowing nothing about the cart. Undefined on inbound and
   * on any call a workflow didn't place. Captured once for the same reason as
   * cartRecoveryContext — the facts of the order must not shift mid-call.
   */
  let workflowMetadata: Record<string, string | number> | undefined;
  /**
   * G1.3: the Shopify order this call is about, for `confirmCodOrder`. Bound
   * once from the same metadata for the same reason as cartRecoveryContext —
   * and more urgently, since the decline branch cancels and restocks a real
   * order. Undefined on any call with no order attached, which removes the
   * tool from the call entirely rather than letting the model name an order.
   */
  let codOrderContext: CodOrderContext | undefined;
  let toNumber: string | undefined;
  let capturedDisposition: string | undefined;
  let capturedSentiment: string | undefined;
  let capturedIntent: string | undefined;
  /**
   * ADR-062: whether a recording/AI disclosure was resolved+configured for
   * this call (set in the "start" handler where disclosureText/Version are
   * persisted). Gates the `disclosureFiredAt` stamp after the greeting turn —
   * we only claim disclosure "fired" for a call that actually had one to fire.
   */
  let disclosureConfigured = false;
  /** ADR-062: set once, so a greeting that runs more than once (rare re-prompt path) doesn't re-stamp disclosureFiredAt. */
  let disclosureFiredStamped = false;
  let history: ModelMessage[] = [];
  /**
   * §3b: adaptive noise filter — created once per call, only when the
   * ADAPTIVE_NOISE_FILTER_FLAG org/global flag is on (resolved in the
   * "start" handler alongside every other org-scoped setting). Left null
   * (no-op passthrough at the media handler) whenever the flag is off, so
   * existing calls/deployments see byte-for-byte unchanged behavior.
   */
  let noiseFilter: NoiseFilter | null = null;
  /**
   * Wind-noise high-pass filter (2026-07-17, see wind-noise-filter.ts) —
   * same "created once per call, only when its flag is on, null = no-op"
   * pattern as noiseFilter above, but independently toggleable: the two
   * filters solve different noise types (steady hum vs bursty wind), and
   * an org may want either, both, or neither. Applied *before* noiseFilter
   * in the media handler when both are on — see that handler for why the
   * order matters.
   */
  let windFilter: HighPassFilter | null = null;
  /** Expressive delivery, Tier 1 (2026-07-17, see tone-tags.ts) —
   * EXPRESSIVE_DELIVERY_FLAG, resolved once alongside noiseFilter/
   * windFilter above. Gates only the tts?.setTone?.() call in
   * sendTtsTextWithTone below; the tone tag itself is always stripped
   * before reaching TTS regardless of this flag. */
  let expressiveDeliveryEnabled = false;
  /** Phase IV backchannels (see backchannel.ts) — BACKCHANNEL_FLAG, resolved
   * once alongside the flags above. Plus the two pieces of per-call state the
   * pure `shouldBackchannel` decision needs: when the caller's current
   * utterance started (set on the first interim, cleared when a real turn is
   * consumed) and when we last played a backchannel (rate-limit anchor). */
  let backchannelsEnabled = false;
  let callerUtteranceStartedAt: number | null = null;
  let lastBackchannelAt: number | null = null;
  /**
   * Phase V (2026-07-31): the pluggable end-of-turn detector, built once per
   * call from SEMANTIC_TURN_DETECTION_FLAG. Default is the plain heuristic
   * (refiner = null, no vendor wired yet — see turn-detection/index.ts), so
   * this is byte-identical to the old inline `endsMidThought` call until a
   * real model is dropped in behind the flag.
   */
  let turnDetector: TurnEndDetector = new HeuristicTurnDetector();
  /**
   * Structured, deterministic call state (see tools/captureField.ts and
   * agent.ts's buildKnownFactsBlock) — the ground truth the agent reads back
   * every turn, separate from the raw transcript. Seeded from the DB row on
   * call start (so a workflow retry or pre-filled context survives), updated
   * whenever the model calls captureField, and persisted continuously so it
   * survives a crash mid-call and is visible on the dashboard immediately.
   */
  let capturedState: Record<string, string> = {};
  let ended = false;
  let maxDurationTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Per-call latency breakdown (see database/schema.ts's callLatency, ADR-022). Each is set at most
   * once per call — first STT connect, first LLM time-to-first-token, first TTS first-audio-byte.
   *
   * Persisted incrementally, the moment each metric is first captured (see persistLatency below) —
   * NOT batched to write only once at finalizeCall. It used to be finalize-only on the theory that
   * latency "isn't needed for crash recovery, just for the dashboard after the fact" — but that's
   * exactly backwards: a process restart or any call-ending path that skips finalizeCall (or runs
   * before these three ever get set) silently loses every metric captured so far, even though
   * STT/LLM/TTS all genuinely worked and the data existed in memory. capturedState already persists
   * continuously for this same reason; latency now does too.
   */
  let sttConnectMs: number | undefined;
  let llmTtftMs: number | undefined;
  let ttsFirstByteMs: number | undefined;
  /** Set the instant the media stream's "start" event arrives (see the
   * "start" handler below) — as close as this codebase gets to "the call
   * was answered". Paired with ttsFirstByteMs's own first-set instant
   * below to compute pickupToFirstAudioMs, the actual caller-perceived
   * "dead air before the agent speaks" number (schema.ts's callLatency
   * doc comment has the full reasoning). */
  let callAnsweredAt: number | undefined;
  let pickupToFirstAudioMs: number | undefined;

  /**
   * Upserts whichever of the three metrics are currently set. Safe to call multiple times per call
   * (once per metric as it's first captured, plus once more at finalizeCall as a final safety net) —
   * each call just re-upserts the current in-memory snapshot, which is always a superset of the last.
   */
  async function persistLatency() {
    if (!dbCallId) return;
    if (
      sttConnectMs === undefined &&
      llmTtftMs === undefined &&
      ttsFirstByteMs === undefined &&
      pickupToFirstAudioMs === undefined
    ) {
      return;
    }
    await db
      .insert(callLatency)
      .values({ callId: dbCallId, sttConnectMs, llmTtftMs, ttsFirstByteMs, pickupToFirstAudioMs })
      .onConflictDoUpdate({
        target: callLatency.callId,
        set: { sttConnectMs, llmTtftMs, ttsFirstByteMs, pickupToFirstAudioMs, capturedAt: new Date() },
      })
      .catch((err) => console.error("[voice] failed to persist call latency", err));
  }

  function recordLlmLatency(ms: number) {
    if (llmTtftMs === undefined) {
      llmTtftMs = ms;
      void persistLatency();
    }
  }

  /**
   * Per-TURN latency (see database/schema.ts's turnLatency doc comment for
   * why this exists alongside the call-level metrics above) — one row per
   * turn, appended (not upserted), so the dashboard can compute a real P50/
   * P90 distribution instead of only ever seeing each call's first turn.
   * `turnIndex` increments per speak() invocation for this call (greeting
   * counts as turn 0).
   *
   * `turnIndex` must be reserved synchronously, right as each turn's
   * generate() resolves (see reserveTurnIndex below) — the 2026-07-17 fix
   * that waits for `ttsDone` before actually persisting a turn's metrics
   * means the DB insert itself can now happen well after the *next* turn
   * has already started (a caller can start talking again the instant the
   * agent's response is fully generated, even if it's still being spoken).
   * If turnCounter were incremented inside this function instead, two
   * concurrent delayed persists could grab indexes out of order.
   */
  let turnCounter = -1;
  function reserveTurnIndex(): number {
    turnCounter += 1;
    return turnCounter;
  }
  async function persistTurnLatency(
    turnIndex: number,
    metrics: { llmTtftMs?: number; ttsFirstByteMs?: number; voiceToVoiceMs?: number },
  ) {
    if (!dbCallId) return;
    await db
      .insert(turnLatency)
      .values({
        callId: dbCallId,
        turnIndex,
        llmTtftMs: metrics.llmTtftMs,
        ttsFirstByteMs: metrics.ttsFirstByteMs,
        voiceToVoiceMs: metrics.voiceToVoiceMs,
      })
      .catch((err) => console.error("[voice] failed to persist per-turn latency", err));
  }

  /** Cross-call memory (ADR-023) — the human's number for this call, and their rolling facts, if any. */
  let humanNumber: string | undefined;
  let humanNumberOrgId: string | undefined;
  /**
   * G1.4 (ADR-069): whose CRM contact this call may write to — the org, plus
   * the human's number as the telephony provider reported it. Derived from
   * `humanNumber`/`humanNumberOrgId` once at "start" and then fixed for the
   * life of the call, for the same reason `cartRecoveryContext` is: the
   * identity of the record being written must not shift mid-conversation.
   * Stays `undefined` when caller ID was withheld or the call has no org, and
   * `buildVoiceTools` then omits `crmSync` entirely rather than letting the
   * model name a contact.
   */
  let crmSyncContext: CrmSyncContext | undefined;
  let callerMemoryFacts: Record<string, string> = {};
  /** Latency fix (2026-07-16): the fully-rendered, ready-to-speak literal
   * greeting text for this call (every {{merge_tag}} resolved), or
   * undefined if no literalGreetingTemplate applies / some tag couldn't be
   * resolved — see the "start" handler below for how this gets set, and
   * runGreeting() for how it's consumed (speaks this directly via
   * speakCannedLine, skipping the LLM entirely, when set). */
  let literalGreetingText: string | undefined;

  let stt: SttConnection | null = null;
  let tts: TtsConnection | null = null;
  let turnAbortController: AbortController | null = null;
  let agentIsSpeaking = false;
  /** Audio arriving after the Twilio "start" event but before the STT
   * provider/language is resolved (agentConfig lookup is async) — buffered
   * instead of dropped, then flushed the moment `stt` connects. Bounded so a
   * pathological delay can't leak memory. */
  const pendingAudioChunks: Buffer[] = [];
  const MAX_PENDING_AUDIO_CHUNKS = 200;

  /** Set by the hangUp/transferToHuman tools (via logToolCall below), consumed at
   * the end of speak() once the closing/handoff line has been spoken — see
   * that function for why this isn't acted on immediately. */
  let pendingHangUp: { reason: string } | undefined;
  let pendingTransfer: { reason: string } | undefined;

  /** ADR-082: latched the moment transferToHuman is requested, and never
   * cleared. Once a handoff is in flight, a hangUp request is always the wrong
   * action — the transfer is what ends this leg — so `hangUp` becomes a no-op
   * for the rest of the call rather than racing the bridge. The same-turn case
   * is resolved by precedence in speak(); this covers the ordering the
   * precedence check can't see, where the model emits transferToHuman on one
   * turn and then hangUp on a later one while performTransfer is still
   * bridging. */
  let transferLatched = false;

  /** Caller-silence handling (re-prompt once, then hang up) — see armSilenceTimer. */
  let silenceTimer: ReturnType<typeof setTimeout> | null = null;
  let silenceWarningIssued = false;

  /**
   * Monotonic counter bumped at the one place a caller utterance is actually
   * consumed as an end-of-turn (the STT handler, right where the silence state
   * is reset). `handleSilenceTimeout` captures the value that was current when
   * its timer was armed and re-checks it after every await: if the caller spoke
   * while the re-prompt/goodbye line was being synthesized, the counter has
   * moved and the timeout abandons itself.
   *
   * Why a *speech* epoch and not a timer epoch: `speak()` re-arms the silence
   * timer on its own tail (see the `else if (!ended)` branch there), so the
   * canned line spoken *by* handleSilenceTimeout bumps any timer-generation
   * counter itself — a post-await generation check would abort on every single
   * timeout, including the legitimate ones. Only caller speech may cancel.
   *
   * Why only that one call site and not the barge-in block too: aborting the
   * timeout leaves no silence timer armed, and this timer is the only backstop
   * against a call that stays open forever (there is no max-duration cap). The
   * end-of-turn site is safe because every path below it re-arms — the
   * mid-thought branch arms explicitly, everything else reaches speak(). The
   * barge-in block has no such guarantee (its interim text may never be
   * followed by a speechFinal), so it deliberately does not bump.
   */
  let callerSpeechEpoch = 0;

  function recordCallerSpeech() {
    callerSpeechEpoch += 1;
  }

  function clearSilenceTimer() {
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
  }

  // Cheap in-memory count of transcript rows written this call — a health
  // signal (see call-health.ts) so finalizeCall doesn't need an extra COUNT(*)
  // read just to know whether anything was ever said.
  let transcriptCount = 0;
  // ADR-084: counted separately because the TOTAL is not a health signal on its
  // own. An agent that monologued through a call the caller never got a word
  // into produces a healthy-looking transcriptCount. Only the caller's own rows
  // tell us the conversation was two-sided.
  let callerTranscriptCount = 0;

  async function logTranscript(role: "caller" | "agent", text: string) {
    if (!dbCallId) return;
    transcriptCount++;
    if (role === "caller") callerTranscriptCount++;
    await db.insert(transcripts).values({ callId: dbCallId, role, text }).catch(() => undefined as unknown);
    void dispatchWebhook(webhookUrl, "call.transcript", { callSid, callId: dbCallId, role, text });
  }

  /**
   * Merges a captureField result into the in-memory state and persists it
   * immediately (not just at call end) — so a crash mid-call, a dashboard
   * view during a live call, or the very next agent turn all see the fact
   * right away rather than only once the call finalizes.
   */
  async function mergeCapturedField(field: string, value: string) {
    capturedState = { ...capturedState, [field]: value };
    if (!dbCallId) return;
    await withRetry(
      () => db.update(calls).set({ capturedState }).where(eq(calls.id, dbCallId!)),
      { label: "persist-captured-state" },
    ).catch((err) => console.error("[voice] failed to persist captured state", err));
  }

  async function logToolCall(ws: Sendable, name: string, input: unknown, output: unknown) {
    if (name === "captureField" && input && typeof input === "object" && "field" in input && "value" in input) {
      const { field, value } = input as { field: string; value: string };
      void mergeCapturedField(field, value);
    }

    // hangUp/transferToHuman only *signal intent* (see their tool definitions) —
    // acted on in speak(), once the same-turn closing/handoff line is spoken.
    //
    // The intent is registered on the tool NAME alone. `reason` is a required
    // field on both schemas, but this used to gate on `"reason" in input`, so a
    // model that called `hangUp` with no arguments (or arguments the SDK could
    // not parse into an object) silently ended nothing: the caller heard the
    // goodbye line and then sat on a live call that never hung up. A missing
    // reason costs a log line, not the hangup.
    if (name === "hangUp") {
      // ADR-082: a handoff is already in flight — see transferLatched.
      if (transferLatched) {
        console.warn("[voice] ignoring hangUp: a transferToHuman is already latched for this call");
      } else {
        pendingHangUp = { reason: toolCallReason(input, "hangUp called without a reason") };
      }
    }
    if (name === "transferToHuman") {
      transferLatched = true;
      pendingTransfer = { reason: toolCallReason(input, "transferToHuman called without a reason") };
    }
    // sendDtmf (Misc-2): generate the tone audio and play it straight into
    // the live media stream, same channel/format as TTS speech — see
    // dtmf.ts's doc comment on why this needs no provider-specific API.
    if (name === "sendDtmf" && input && typeof input === "object" && "digits" in input) {
      const digits = String((input as { digits: unknown }).digits);
      if (streamSid && isValidDtmfSequence(digits)) {
        try {
          ws.send(transport.buildOutboundMedia(streamSid, buildDtmfAudio(digits)));
        } catch (err) {
          console.error("[voice] failed to send DTMF tone audio", err);
        }
      } else {
        console.error(`[voice] sendDtmf tool called with invalid/unusable digits "${digits}" — skipped`);
      }
    }
    // sendSms only *signals intent* too (see its tool definition) — the
    // actual send happens here via the provider-agnostic dispatcher
    // (Misc-4), fire-and-forget so it never blocks the live call.
    if (name === "sendSms" && input && typeof input === "object" && "body" in input) {
      const smsBody = String((input as { body: unknown }).body);
      if (humanNumber) {
        void sendSmsForOrg({ orgId: humanNumberOrgId, to: humanNumber, body: smsBody }).then((result) => {
          if (!result.ok) console.error(`[voice] mid-call sendSms failed: ${result.error}`);
        });
      } else {
        console.error("[voice] mid-call sendSms tool called with no resolved caller number — skipped");
      }
    }

    if (!dbCallId) return;
    await db
      .insert(toolCalls)
      .values({ callId: dbCallId, toolName: name, input, output })
      .catch(() => undefined as unknown);
    void dispatchWebhook(webhookUrl, "call.tool_call", {
      callSid,
      callId: dbCallId,
      toolName: name,
      input,
      output,
    });

    // Phase I (five-bets plan, 2026-07-31): promote guardrail moments to a
    // first-class row in guardrail_events, alongside the raw tool_calls
    // breadcrumb above. Both guardrail signals funnel through this single
    // logToolCall choke point — the agent's own `flagGuardrailEvent` self-report
    // (input `{ category, detail }`) and stream.ts's independent
    // `guardrail-heuristic-detector` (input `{ category, callerText }`) — so one
    // insert here covers both, keyed off `name`. Fire-and-forget: a failure here
    // never blocks the live call, same pattern as opt_out_events / product_events.
    const guardrailFields = deriveGuardrailEventFields(name, input);
    if (guardrailFields) {
      void db
        .insert(guardrailEvents)
        .values({ callId: dbCallId, orgId: humanNumberOrgId ?? null, ...guardrailFields })
        .catch((err) => console.error("[voice] failed to log guardrail event", err));
    }

    // Workflows (see ./workflows/) key off the call's disposition — capture
    // it here when the agent calls setDisposition, then persist + trigger the
    // matching workflow action once the call actually ends (finalizeCall).
    if (name === "setDisposition" && input && typeof input === "object" && "disposition" in input) {
      capturedDisposition = String((input as { disposition: unknown }).disposition);
      const sentimentInput = (input as { sentiment?: unknown }).sentiment;
      if (typeof sentimentInput === "string") capturedSentiment = sentimentInput;
    }

    // Intent detection — captured whenever the agent calls setIntent, independent of
    // disposition (a call can have an intent recorded well before its final outcome is known).
    if (name === "setIntent" && input && typeof input === "object" && "intent" in input) {
      capturedIntent = String((input as { intent: unknown }).intent);

      // ADR-062: a "cancellation_or_opt_out" intent IS a per-call opt-out
      // event — log it to canonical state (opt_out_events) so the audit trail
      // can answer "did they opt out on this call" without re-reading the
      // transcript. Distinct from the DNC list (current state); this is the
      // call-time fact. Fire-and-forget: a failure here never blocks the call.
      // dncPropagatedAt is left null here — DNC propagation is a separate step
      // (Phase II / an existing DNC-add path), and the audit trail shows the
      // request even before any follow-through.
      if (capturedIntent === "cancellation_or_opt_out" && dbCallId && humanNumber) {
        const notes = (input as { notes?: unknown }).notes;
        const triggerPhrase = typeof notes === "string" && notes.trim() ? notes.trim() : null;
        void db
          .insert(optOutEvents)
          .values({
            callId: dbCallId,
            orgId: humanNumberOrgId ?? null,
            phoneNumber: humanNumber,
            triggerPhrase,
          })
          .catch((err) => console.error("[voice] failed to log opt-out event", err));
      }
    }
  }

  async function finalizeCall(status: string) {
    if (ended) return;
    ended = true;
    stt?.close();
    tts?.close();
    turnAbortController?.abort();
    if (maxDurationTimer) clearTimeout(maxDurationTimer);
    clearSilenceTimer();
    if (callSid) {
      const priorSession = await sessionStore.get(callSid);
      const previousAttempt = priorSession?.workflowAttempt;
      const priorOrgId = priorSession?.orgId;
      const priorCheckoutToken = priorSession?.checkoutToken;
      const priorWorkflowMetadata = priorSession?.workflowMetadata;

      // Per-call cost estimate (2026-07-18) — needs the row's startedAt to
      // compute duration; a small extra read at call-end, not the hot path.
      // Best-effort: a lookup failure here shouldn't block the call from
      // finalizing, it just means this one call has no cost estimate.
      let estimatedCostUsdCents: number | null = null;
      try {
        const [row] = await db
          .select({ startedAt: calls.startedAt })
          .from(calls)
          .where(eq(calls.twilioCallSid, callSid))
          .limit(1);
        if (row?.startedAt) {
          const durationSeconds = (Date.now() - row.startedAt.getTime()) / 1000;
          estimatedCostUsdCents = estimateCallCostCents({
            telephonyProvider: provider,
            sttProvider: sttProviderOverride,
            // The provider that actually synthesized this call's audio, which
            // is not the same thing as the configured override: it reflects the
            // smart Indic default (ADR-060) and any mid-call failover, both of
            // which change what this call really cost.
            ttsProvider: activeTtsProvider ?? ttsProviderOverride,
            durationSeconds,
          });
        }
      } catch (err) {
        console.error("[voice] failed to compute per-call cost estimate", err);
      }

      // Call-health verdict (Five Bets Phase II) — classify from the signals
      // already gathered in memory this call. Pure/deterministic (see
      // call-health.ts); folded into the same finalize update so it's written
      // atomically with status and never adds an extra write on the hot path.
      // Best-effort by construction: classifyCallHealth can't throw on valid
      // inputs, and a null result would just leave the columns null.
      const health = classifyCallHealth({
        finalStatus: status,
        answered: callAnsweredAt !== undefined,
        turnCount: Math.max(0, turnCounter + 1),
        transcriptCount,
        callerTranscriptCount,
        hadDisposition: capturedDisposition !== undefined,
        sttConnectMs,
        llmTtftMs,
        ttsFirstByteMs,
        pickupToFirstAudioMs,
        sttReconnectCount,
        providerFailoverCount,
      });

      await withRetry(
        () =>
          db
            .update(calls)
            .set({
              status,
              endedAt: new Date(),
              ...(capturedDisposition ? { disposition: capturedDisposition } : {}),
              ...(capturedSentiment ? { sentiment: capturedSentiment } : {}),
              ...(capturedIntent ? { intent: capturedIntent } : {}),
              sttProviderUsed: sttProviderOverride ?? null,
              ttsProviderUsed: activeTtsProvider ?? ttsProviderOverride ?? null,
              llmProviderUsed: llmProviderOverride ?? null,
              estimatedCostUsdCents,
              healthStatus: health.status,
              healthReasons: health.reasons,
            })
            .where(eq(calls.twilioCallSid, callSid!)),
        { label: "finalize-call" },
      );

      // Per-call latency breakdown (ADR-022) — each metric already persisted itself the moment it
      // was first captured (see persistLatency); this is just a final safety-net upsert in case any
      // metric was captured in the same tick finalizeCall started running.
      await persistLatency();

      // Cross-call memory (ADR-023) — merge this call's captured facts into
      // the caller's rolling memory. No-op if nothing was captured.
      if (humanNumber && dbCallId) {
        await upsertCallerMemory(humanNumberOrgId, humanNumber, capturedState, dbCallId);
      }

      // Native Leads layer (2026-07-19) — promote this call's captured facts
      // into the deduped person-of-record (leads table) and link the call to
      // it. Best-effort and org-scoped: skips silently for no-org self-host
      // usage, and a failure here never blocks the call from finalizing (same
      // contract as upsertCallerMemory above).
      if (humanNumber && dbCallId && humanNumberOrgId) {
        await promoteLeadFromCall({
          orgId: humanNumberOrgId,
          phone: humanNumber,
          capturedState,
          callId: dbCallId,
          vertical: undefined,
        });
      }

      await sessionStore.delete(callSid);

      // Workflows (see ./workflows/) run automatically off the captured
      // disposition — no manual step required to trigger a retry/DNC-add/
      // webhook once the agent has recorded an outcome.
      if (capturedDisposition && toNumber) {
        const priorWorkflowRunId = priorSession?.workflowRunId;
        if (priorWorkflowRunId) {
          void resumeWorkflowAfterCall(
            priorWorkflowRunId,
            capturedDisposition,
            capturedState?.discount_code,
          ).catch((err) => console.error("[voice] graph workflow resume failed", err));
        } else {
          void runWorkflowForOutcome({
            toNumber,
            outcome: capturedDisposition as WorkflowOutcome,
            persona,
            webhookUrl,
            previousAttempt,
            orgId: priorOrgId,
            checkoutToken: priorCheckoutToken,
            metadata: priorWorkflowMetadata,
          }).catch((err) => console.error("[voice] workflow execution failed", err));
        }
      }
    }
  }

  function endCallOnFatalError(ws: Sendable) {
    try {
      if (streamSid) ws.send(transport.buildClear(streamSid));
    } catch {
      // socket may already be closed — ignore
    }
    void finalizeCall("failed");
  }

  /** `orgs.humanTransferNumber` for this call's org — per-org only, no global fallback (2026-07-17
   * decision: a shared HUMAN_TRANSFER_NUMBER env var meant any org without its own number configured
   * would silently transfer callers to a DIFFERENT org's human line, which is worse than just
   * hanging up — removed rather than left as a footgun). An org with nothing configured here simply
   * can't transfer; performTransfer falls back to a hang-up in that case, same as any other
   * "no transfer number configured" path. */
  async function resolveHumanTransferNumber(orgId: string): Promise<string | undefined> {
    const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId)).limit(1).catch(() => [] as never[]);
    return org?.humanTransferNumber ?? undefined;
  }

  /** Actually ends the call — terminates the real Twilio call leg (not just
   * our WebSocket), since the media stream closing on its own doesn't
   * guarantee the underlying PSTN call hangs up.
   *
   * Twilio-only for the REST hangup: Plivo/Exotel have their own
   * equivalent "end this live call" APIs but they haven't been wired up
   * yet (unverified without a live prototype call — see
   * docs/india-telephony.md's status note). For those providers this still
   * closes our WebSocket, which in practice ends the caller's audio and,
   * for most PSTN carriers, the call itself shortly after — but it's not
   * the same guaranteed hard-hangup Twilio's REST call gives us. */
  async function performHangUp(ws: Sendable, reason: string) {
    console.log(`[voice] hangUp requested: ${reason}`);
    clearSilenceTimer();
    // Never allowed to throw (see its doc comment) — closing the WebSocket
    // below is what actually ends a <Connect><Stream> call, so nothing in the
    // provider REST path may pre-empt it.
    await endProviderCallLeg();
    try {
      ws.close?.();
    } catch {
      // socket may already be closed — ignore
    }
    await finalizeCall("completed");
  }

  /**
   * Terminates the live call leg at the telephony provider. Best-effort by
   * design, and — critically — **it cannot throw**.
   *
   * It used to be inlined in performHangUp as
   * `await (await getTwilioClientForOrg(orgId)).calls(sid).update(...).catch(log)`,
   * where the `.catch` covered only the `update()` promise. Everything before
   * it did not: `getTwilioClientForOrg` does a DB + credential-vault read and
   * then constructs a client (`Twilio(sid, token)` throws on a malformed SID),
   * so an org in the half-provisioned state twilio-provisioning.ts's
   * `getSubClientEnsuring` explicitly documents — sub-account SID stored, auth
   * token unreadable — made the whole function throw. The rejection surfaced
   * as a generic "[voice] error handling transcript event" from the STT
   * handler's catch, and `ws.close()` / `finalizeCall()` never ran: the caller
   * was left on a live, silent call that never hung up, which is the reported
   * "call is not ending" defect.
   *
   * The Twilio REST call also gets one retry. It is the single API call that
   * ends the PSTN leg, and its most likely failure is not transient: when this
   * call has no org attributed to it, `getTwilioClientForOrg(undefined)` falls
   * back to the *parent* platform client, while a call on an org's dedicated
   * number belongs to that org's **sub-account** — the parent's
   * `calls(sid).update()` then 404s. That has to be loud, not swallowed, so
   * it's diagnosable from the logs; closing the WebSocket is the backstop that
   * still ends the call (Twilio: "Twilio executes the remaining TwiML
   * instructions only after your server closes the WebSocket connection" — and
   * our answer TwiML has no verb after `<Connect>`).
   */
  async function endProviderCallLeg(): Promise<void> {
    if (!callSid) return;
    try {
      if (provider === "twilio") {
        const attempts = 2;
        for (let attempt = 1; attempt <= attempts; attempt++) {
          try {
            const client = await getTwilioClientForOrg(humanNumberOrgId);
            await client.calls(callSid).update({ status: "completed" });
            return;
          } catch (err) {
            const isLast = attempt === attempts;
            console.error(
              `[voice] failed to end Twilio call ${callSid} via REST API (attempt ${attempt}/${attempts}, org ${humanNumberOrgId ?? "unattributed"})` +
                (isLast
                  ? " — falling back to closing the media stream, which ends a <Connect><Stream> call"
                  : " — retrying"),
              err,
            );
            if (!isLast) await sleep(250);
          }
        }
        return;
      }
      if (provider === "plivo" && humanNumberOrgId) {
        // Plivo hangup (2026-07-17, closing the gap flagged in docs/india-telephony.md) — see
        // plivo-client.ts's hangupPlivoCall doc comment for the API this calls.
        const result = await hangupPlivoCall(humanNumberOrgId, callSid);
        if (!result.ok) console.error(`[voice] failed to end Plivo call via REST API: ${result.error}`);
        return;
      }
      console.warn(`[voice] hangUp on ${provider} call ${callSid} — closing the WebSocket only, no REST hangup wired up for this provider yet`);
    } catch (err) {
      console.error(`[voice] unexpected error ending the ${provider} call leg for ${callSid}`, err);
    }
  }

  /** Redirects the live call out of the media stream into a real transfer to a human — the call
   * keeps going, just no longer through the agent. Falls back to hanging up (rather than
   * silently no-oping) if no transfer number is configured anywhere, since the agent already told
   * the caller it was transferring them.
   *
   * Twilio: redirects via a `<Dial>` TwiML update. Plivo (2026-07-17, closing the gap flagged in
   * docs/india-telephony.md): redirects the A-leg to fetch `<Dial>` XML from this server's own
   * `/transfer-xml/plivo` route (see plivo-client.ts's transferPlivoCall). Exotel has no
   * confirmed equivalent REST API for an already-connected call in its public docs (its "Call
   * Transfer" feature is dashboard/App-Bazaar-driven, not a documented mid-call REST action) —
   * still falls back to hang-up rather than guessing at an unconfirmed endpoint, same "don't
   * silently guess" discipline as the rest of this file's provider gaps. */
  async function performTransfer(ws: Sendable, reason: string) {
    console.log(`[voice] transferToHuman requested: ${reason}`);
    clearSilenceTimer();

    if (provider !== "twilio" && provider !== "plivo") {
      console.warn(`[voice] transferToHuman requested on ${provider} call — no transfer API wired up for this provider yet, hanging up instead`);
      await performHangUp(ws, `${reason} (transfer unsupported on ${provider})`);
      return;
    }

    // No global env-var fallback (2026-07-17) — see resolveHumanTransferNumber's doc comment. A
    // call with no resolved org can't transfer at all; falls through to the "no transfer number
    // configured" hang-up below, same as an org that simply hasn't set one.
    const transferNumber = humanNumberOrgId ? await resolveHumanTransferNumber(humanNumberOrgId) : undefined;

    if (!transferNumber) {
      console.error("[voice] transferToHuman requested but no transfer number is configured anywhere — hanging up instead");
      await performHangUp(ws, "transfer requested but no transfer number configured");
      return;
    }

    // A redirect that fails must NOT fall through to finalizeCall("transferred"):
    // finalize marks the call transferred, closes STT/TTS and stops the silence
    // timer, but performTransfer deliberately leaves the WebSocket open (the
    // call is supposed to continue on the <Dial>). So a failed redirect used to
    // leave the caller on a live call with no agent listening and no timer left
    // to end it — a zombie leg that only the caller hanging up could clear.
    // Hanging up is the honest outcome, same as the "no transfer number
    // configured" branch above.
    let redirected = false;
    let redirectError: string | undefined;
    if (callSid && provider === "twilio") {
      try {
        const twiml = new VoiceResponse();
        twiml.dial(transferNumber);
        const client = await getTwilioClientForOrg(humanNumberOrgId);
        await client.calls(callSid).update({ twiml: twiml.toString() });
        redirected = true;
      } catch (err) {
        redirectError = (err as Error).message;
        console.error("[voice] failed to redirect call for transfer", err);
      }
    } else if (callSid && provider === "plivo" && humanNumberOrgId) {
      const alegUrl = `${getPublicUrl()}/api/voice/transfer-xml/plivo?to=${encodeURIComponent(transferNumber)}`;
      const result = await transferPlivoCall(humanNumberOrgId, callSid, alegUrl);
      redirected = result.ok;
      if (!result.ok) {
        redirectError = result.error;
        console.error(`[voice] failed to redirect Plivo call for transfer: ${result.error}`);
      }
    }

    if (!redirected) {
      await performHangUp(ws, `transfer failed (${redirectError ?? "no redirect path for this provider"})`);
      return;
    }
    await finalizeCall("transferred");
  }

  /**
   * The (provider, voiceId) pair the caller is actually hearing right now.
   *
   * Every tts-cache read/write must be keyed on this rather than on the
   * *intended* provider: the cache is a process-global Map (see tts-cache.ts),
   * so storing audio a fallback provider produced under the primary provider's
   * key means later canned/filler/backchannel lines replay in a voice that
   * doesn't match the live turns — for the rest of that call and for every
   * later call in the same process.
   */
  function currentTtsVoice(): { provider: TtsProvider; voiceId: string | undefined } {
    const provider = activeTtsProvider ?? resolveTtsProvider(ttsProviderOverride, languageOverride);
    return { provider, voiceId: voiceIdForProvider(ttsVoiceIdOverride, ttsVoiceIdProvider, provider) };
  }

  /** Speaks a fixed line with no LLM call involved — used for the silence
   * re-prompt/goodbye so a flaky LLM turn can't compound an already-quiet
   * caller into an even longer wait.
   *
   * Misc-7: these two lines are the one genuinely verbatim, deterministic
   * spot in an otherwise LLM-paraphrased call (see tts-cache.ts's doc
   * comment on why greeting/closing aren't in scope) — behind the
   * "hybrid-audio-cache" flag, replay pre-synthesized audio instead of
   * paying live TTS latency/cost for text that's byte-identical every
   * time. Also fixes a pre-existing bug: this function never actually
   * called tts.sendText, so these lines were logged to the transcript but
   * never spoken out loud.
   */
  async function speakCannedLine(ws: Sendable, text: string) {
    const flagOrgId = humanNumberOrgId ?? undefined;
    const flags: Record<string, boolean> = flagOrgId
      ? await getEffectiveFlags(flagOrgId).catch(() => ({}))
      : {};
    const hybridCacheEnabled = flags[HYBRID_AUDIO_CACHE_FLAG] === true;

    if (!hybridCacheEnabled) {
      await speak(ws, async () => {
        tts?.sendText(text);
        return text;
      });
      return;
    }

    const lookup = currentTtsVoice();
    const cached = getCachedTtsAudio(lookup.provider, lookup.voiceId, languageOverride, text);
    if (cached) {
      await speak(ws, async () => text, { cachedAudioBase64: cached });
      return;
    }

    const chunks: string[] = [];
    await speak(
      ws,
      async () => {
        tts?.sendText(text);
        return text;
      },
      { onAudioChunk: (base64Audio) => chunks.push(base64Audio) },
    );
    // Re-read after speaking, not before: this very line may have failed over
    // to another provider, in which case `chunks` is that provider's voice and
    // must be stored under its key, never the primary's.
    const stored = currentTtsVoice();
    setCachedTtsAudio(stored.provider, stored.voiceId, languageOverride, text, chunks);
  }

  /**
   * §3a: tool-call filler audio — a short line ("One moment, let me check
   * that." / "Let me look into that for you.") played the instant a tool
   * call has been running past agent.ts's TOOL_CALL_FILLER_THRESHOLD_MS
   * (lookupInfo's knowledge-base search, bookAppointment/crmSync's outbound
   * HTTP calls), so the caller hears *something* instead of dead air while
   * a slow tool finishes.
   *
   * Reuses tts-cache.ts exactly as it already exists for Misc-7's canned
   * silence-timeout lines — same flag (HYBRID_AUDIO_CACHE_FLAG), same
   * cache, same (provider, voice, language, text) key. Deliberately never
   * synthesizes live here: if the line isn't cached yet, warming it now
   * would itself take as long as the tool call it's meant to cover,
   * defeating the entire point of a filler. Fire-and-forget warms it in
   * the background instead, so the *next* slow tool call (this call or
   * any other) gets an instant cache hit.
   */
  const TOOL_CALL_FILLER_LINES = ["One moment, let me check that.", "Let me look into that for you."];

  async function warmFillerCache(text: string) {
    // Warm against the voice the caller is hearing right now (post-failover if
    // one already happened), not the primary this call started on — otherwise
    // the warmed clip is a different voice than the live turns it interleaves
    // with.
    const { provider, voiceId } = currentTtsVoice();
    if (getCachedTtsAudio(provider, voiceId, languageOverride, text)) return;
    const chunks: string[] = [];
    await new Promise<void>((resolve) => {
      const warmupTts = connectTts(
        (base64Audio) => chunks.push(base64Audio),
        () => resolve(),
        (err) => {
          console.error("[voice] failed to warm filler-audio cache", err);
          resolve();
        },
        provider,
        voiceId,
        languageOverride,
      );
      warmupTts.sendText(text);
      warmupTts.endTurn();
    });
    setCachedTtsAudio(provider, voiceId, languageOverride, text, chunks);
  }

  async function maybePlayToolCallFiller(ws: Sendable) {
    const flagOrgId = humanNumberOrgId ?? undefined;
    const flags: Record<string, boolean> = flagOrgId
      ? await getEffectiveFlags(flagOrgId).catch(() => ({}))
      : {};
    if (flags[HYBRID_AUDIO_CACHE_FLAG] !== true) return;
    if (ended || !streamSid) return;

    const text = TOOL_CALL_FILLER_LINES[Math.floor(Math.random() * TOOL_CALL_FILLER_LINES.length)];
    const { provider: resolvedProvider, voiceId: resolvedVoiceId } = currentTtsVoice();
    const cached = getCachedTtsAudio(resolvedProvider, resolvedVoiceId, languageOverride, text);
    if (!cached) {
      void warmFillerCache(text);
      return;
    }
    try {
      ws.send(transport.buildOutboundMedia(streamSid, cached));
    } catch (err) {
      console.error(`[voice] failed to forward filler audio to ${provider}`, err);
    }
  }

  /**
   * Phase IV: play one short backchannel ("mm-hm"/"right"/"okay") while the
   * caller is mid-utterance. Cached-only, exactly like maybePlayToolCallFiller
   * — synthesizing live would add the latency a backchannel exists to avoid,
   * and would risk overlapping the caller's next words. The `shouldBackchannel`
   * gate (rate limit, threshold, not-during-agent, not-on-speech_final) is
   * checked by the caller before we ever get here; this just renders the clip.
   * Deliberately does NOT set agentIsSpeaking / touch history / clear audio:
   * a backchannel is not a turn.
   */
  function maybePlayBackchannel(ws: Sendable) {
    if (ended || !streamSid) return;
    const text = BACKCHANNEL_LINES[Math.floor(Math.random() * BACKCHANNEL_LINES.length)];
    const { provider: resolvedProvider, voiceId: resolvedVoiceId } = currentTtsVoice();
    const cached = getCachedTtsAudio(resolvedProvider, resolvedVoiceId, languageOverride, text);
    if (!cached) {
      // Not warmed yet — skip this one and warm it for next time rather than
      // stalling the caller with a live synth. Backchannels are best-effort.
      void warmFillerCache(text);
      return;
    }
    try {
      ws.send(transport.buildOutboundMedia(streamSid, cached));
    } catch (err) {
      console.error(`[voice] failed to forward backchannel audio to ${provider}`, err);
    }
  }

  /**
   * @param unplayedAudioMs Audit 10 (2026-08-09) — how much of the turn we just
   * finished *sending* the caller almost certainly hasn't *heard* yet. The
   * silence threshold is measured from the end of playback, not the end of
   * sending, so this is added on top of it.
   *
   * Why this parameter has to exist: `speak()` resolves when the TTS provider
   * reports it has sent its last chunk, which for a streaming provider is
   * seconds ahead of realtime playback over an 8kHz PSTN leg. Arming a bare 8s
   * timer at that instant meant a 12-second greeting had its "is the caller
   * still there?" clock expire ~4s BEFORE the caller finished hearing the
   * greeting — so the agent talked over itself, got no reply (the caller was
   * still listening, and had never been given a gap to speak into), and hung
   * up on itself 7s later. Every call in production died this way, inbound and
   * outbound, and all of them were recorded `health_status = healthy`.
   *
   * Passing 0 is correct and intended for call sites that are NOT following
   * agent speech (i.e. arming after caller audio), and only for those.
   *
   * Still an estimate — see estimateRemainingPlaybackMs. Twilio `mark` events
   * are the real fix and would let this parameter go away entirely.
   */
  function armSilenceTimer(ws: Sendable, unplayedAudioMs = 0) {
    if (ended) return;
    clearSilenceTimer();
    const armedAtEpoch = callerSpeechEpoch;
    const threshold = silenceWarningIssued ? SILENCE_HANGUP_MS : SILENCE_WARNING_MS;
    silenceTimer = setTimeout(() => {
      void handleSilenceTimeout(ws, armedAtEpoch);
    }, unplayedAudioMs + threshold);
  }

  /**
   * @param armedAtEpoch `callerSpeechEpoch` as it stood when this timeout was
   * armed. Clearing the timer is not enough on its own: once this function has
   * suspended inside `await speakCannedLine`, `clearSilenceTimer()` from the
   * STT handler is a no-op and the goodbye + hangup still land. Re-checking the
   * epoch after every await is what actually cancels an in-flight timeout when
   * the caller turns out to have been speaking all along.
   */
  async function handleSilenceTimeout(ws: Sendable, armedAtEpoch: number) {
    if (ended || callerSpeechEpoch !== armedAtEpoch) return;
    if (!silenceWarningIssued) {
      silenceWarningIssued = true;
      const warningLine = "Are you still there? Let me know if you need anything else.";
      await speakCannedLine(ws, warningLine);
      if (ended || callerSpeechEpoch !== armedAtEpoch) return;
      // Audit 10: this re-arm overwrites the one speak() already set on its own
      // tail, so it has to carry the same unplayed-audio allowance — otherwise
      // the hangup clock for the re-prompt starts before the caller has heard
      // the re-prompt, and they get ~3s to answer a question they're still
      // listening to.
      armSilenceTimer(ws, estimateRemainingPlaybackMs(warningLine));
    } else {
      await speakCannedLine(ws, "I haven't heard back, so I'll go ahead and end the call here. Feel free to call back anytime. Goodbye.");
      if (ended || callerSpeechEpoch !== armedAtEpoch) return;
      await performHangUp(ws, "caller silence timeout");
    }
  }

  /**
   * Expressive delivery, Tier 1 (2026-07-17, see tone-tags.ts) — per-turn
   * state for extracting the LLM's leading `[[tone:value]]` tag out of the
   * streamed text before any of it ever reaches TTS or the transcript.
   * Reset at the top of every `speak()` call (a fresh turn). Always runs
   * (the prompt instruction in agent.ts is unconditional) regardless of
   * `expressiveDeliveryEnabled` — that flag only gates whether the parsed
   * tone actually gets applied to Cartesia via `setTone`; the tag itself is
   * stripped either way, so a caller never hears it spoken.
   *
   * Bounded latency cost, by design: this holds back at most
   * TONE_TAG_MAX_BUFFER_CHARS (24) worth of streamed text before flushing —
   * in the normal case (the model actually emits the ~20-char tag as
   * instructed) this resolves almost immediately once the tag closes, not
   * at the 24-char cap; the cap only matters as a fallback if the model
   * ever omits the tag entirely, so a turn is never held back indefinitely
   * waiting for a tag that isn't coming.
   */
  let toneTagBuffer = "";
  let toneTagResolved = false;

  function sendTtsTextWithTone(text: string) {
    if (toneTagResolved) {
      tts?.sendText(text);
      return;
    }
    toneTagBuffer += text;
    const { tone, text: stripped } = stripToneTag(toneTagBuffer);
    const looksLikeClosedTag = /\]\]/.test(toneTagBuffer);
    if (tone !== null || looksLikeClosedTag || toneTagBuffer.length >= TONE_TAG_MAX_BUFFER_CHARS) {
      toneTagResolved = true;
      if (tone !== null && expressiveDeliveryEnabled) {
        const emotion = CARTESIA_EMOTION_BY_TONE[tone];
        if (emotion) tts?.setTone?.(emotion);
      }
      if (stripped) tts?.sendText(stripped);
      toneTagBuffer = "";
      return;
    }
    // Still might be a tag forming (no closing "]]" seen yet, under the
    // buffer cap) — hold this chunk back until the next delta resolves it.
  }

  /** Shared turn runner — used for both the opening greeting and normal replies. */
  async function speak(
    ws: Sendable,
    generate: (signal: AbortSignal) => Promise<string>,
    options?: {
      /** Misc-7: a cache hit — skip live TTS entirely and replay this
       * pre-synthesized audio as one outbound frame instead. */
      cachedAudioBase64?: string;
      /** Misc-7: a cache miss on a cacheable line — called with every raw
       * audio chunk as it streams, alongside the normal forward-to-caller
       * path, so the caller can accumulate + store it once the turn ends. */
      onAudioChunk?: (base64Audio: string) => void;
      /** Latency benchmark (§2): timestamp the STT provider declared the
       * caller done talking (speechFinal), if this turn was triggered by
       * caller speech — undefined for the greeting, which has no such
       * instant. Used to compute this turn's voiceToVoiceMs. */
      turnStartedAt?: number;
      /** Latency benchmark (§2): a mutable holder the caller (runTurn/
       * runGreeting) writes this turn's LLM time-to-first-token into, from
       * inside its own onLatency callback — a plain value can't be used
       * here since the LLM ttft is only known partway through generate(),
       * after speak() has already started, but this ref is read only after
       * generate() resolves, by which point onLatency has already fired. */
      turnLlmTtftRef?: { value?: number };
    },
  ) {
    turnAbortController = new AbortController();
    agentIsSpeaking = true;
    // Expressive delivery (2026-07-17) — fresh tone-tag state for this turn.
    toneTagBuffer = "";
    toneTagResolved = false;

    const ttsRequestedAt = Date.now();
    let turnTtsFirstByteMs: number | undefined;
    // Resolved once the TTS provider reports it's sent every audio chunk for
    // this turn — used below to avoid cutting a hangUp/transfer closing line
    // off. Not a guarantee Twilio has finished *playing* it (see
    // estimateRemainingPlaybackMs), just that we've sent everything we're
    // going to send.
    let resolveTtsDone: (() => void) | undefined;
    const ttsDone = new Promise<void>((resolve) => {
      resolveTtsDone = resolve;
    });

    // Word-level timing for this turn only (Cartesia; other providers never
    // call this) — used below to reconstruct what the caller actually heard
    // if they interrupt, instead of recording the full generated text as
    // "said" when only the first few words were ever spoken. See the
    // onWordTimestamp doc comment in tts/types.ts for the full reasoning.
    const spokenWords: string[] = [];

    if (options?.cachedAudioBase64) {
      // Cache hit (Misc-7): no TTS connection at all — just replay the
      // pre-synthesized audio as a single frame, same shape dtmf.ts uses
      // for tone playback.
      tts = null;
      if (ttsFirstByteMs === undefined) {
        ttsFirstByteMs = 0;
        if (pickupToFirstAudioMs === undefined && callAnsweredAt !== undefined) {
          pickupToFirstAudioMs = Date.now() - callAnsweredAt;
          console.log(`[voice] pickup-to-first-audio (cache hit): ${pickupToFirstAudioMs}ms`);
        }
        void persistLatency();
      }
      turnTtsFirstByteMs = 0;
      if (streamSid) {
        try {
          ws.send(transport.buildOutboundMedia(streamSid, options.cachedAudioBase64));
        } catch (err) {
          console.error(`[voice] failed to forward cached audio to ${provider}`, err);
        }
      }
      agentIsSpeaking = false;
      resolveTtsDone?.();
    } else {
      // Cross-provider failover (2026-07-17, recommendation #1 of
      // docs/product-infra-and-gtm-report.md Part 4): the TTS connection is
      // per-turn (unlike STT's persistent per-call connection), so failover
      // here is scoped to "this turn hasn't played any audio yet" — once
      // even one chunk has reached the caller, swapping providers mid-turn
      // would replay or skip words, which is worse than just ending the
      // turn (existing behavior, unchanged for that case). `sentTextBuffer`
      // captures every sendText call so far so it can be replayed to a
      // fallback provider's connection if we do fail over before any audio
      // played — nothing is lost by retrying at that point.
      //
      // Voice identity (see tts-voice-identity.ts): a failover is sticky for
      // the rest of the call (`activeTtsProvider`), because the alternative —
      // rebuilding the chain from the primary on every turn, as this did
      // before — makes a single transient error flip the agent's voice for one
      // turn and then flip it back. The configured voice ID travels only to
      // the provider it belongs to; a fallback provider uses its own default
      // voice instead of being handed an ID that means nothing to it.
      const primaryTtsProvider = activeTtsProvider ?? resolveTtsProvider(ttsProviderOverride, languageOverride);
      const ttsFailoverChain = resolveTtsFailoverChain(primaryTtsProvider, ttsFallbackOrderOverride);
      const sentTextBuffer: string[] = [];
      // Lazy TTS connect (ADR-083, 2026-08-09) — see the `tts = {...}` facade
      // at the end of this block. `realTts` is undefined until the turn
      // actually has a character to synthesize.
      let realTts: TtsConnection | undefined;
      let endTurnRequested = false;
      let pendingTone: string | undefined;

      const attemptTts = (attemptProvider: TtsProvider, replayText: string[] = []): TtsConnection => {
        activeTtsProvider = attemptProvider;
        // Whether this specific socket has ever been handed text. A provider
        // that drops a socket it was never asked to synthesize anything on has
        // told us nothing about its health (ADR-083) — that's an idle timeout,
        // not a failure, and it must not burn a link off the failover chain.
        let textReachedProvider = replayText.length > 0;
        // Declared before connectTts because onError below closes over it and a
        // provider is free to report failure synchronously, before connectTts
        // has even returned — reading a `const` initialized further down would
        // be a temporal-dead-zone throw at exactly the moment we're trying to
        // recover from a failure.
        let wrapper: TtsConnection | undefined;
        const real = connectTts(
          (base64Audio) => {
            if (ttsFirstByteMs === undefined) {
              ttsFirstByteMs = Date.now() - ttsRequestedAt;
              if (pickupToFirstAudioMs === undefined && callAnsweredAt !== undefined) {
                pickupToFirstAudioMs = Date.now() - callAnsweredAt;
                console.log(`[voice] pickup-to-first-audio: ${pickupToFirstAudioMs}ms`);
              }
              void persistLatency();
            }
            if (turnTtsFirstByteMs === undefined) {
              turnTtsFirstByteMs = Date.now() - ttsRequestedAt;
            }
            options?.onAudioChunk?.(base64Audio);
            if (!streamSid) return;
            try {
              ws.send(transport.buildOutboundMedia(streamSid, base64Audio));
            } catch (err) {
              console.error(`[voice] failed to forward TTS audio to ${provider}`, err);
            }
          },
          () => {
            agentIsSpeaking = false;
            resolveTtsDone?.();
          },
          (err) => {
            // ADR-083: an error on a socket that was never given any text is
            // an idle timeout (Cartesia: `1000 connection idle timeout`;
            // Sarvam: `408 Websocket was left open without any messages for
            // too long`), not a provider fault. Drop the dead socket so the
            // next sendText transparently reconnects to the *same* provider —
            // no chain burn, no recordProviderFailover, no sticky voice flip.
            if (!textReachedProvider) {
              console.warn(`[voice] discarding idle TTS socket for "${attemptProvider}" (closed before any text was sent); will reconnect on demand`, err);
              if (wrapper === undefined || realTts === wrapper) realTts = undefined;
              // If the turn already ended without ever producing text, nothing
              // is coming — release the ttsDone waiter instead of letting it
              // burn its full 8s timeout.
              if (endTurnRequested) {
                agentIsSpeaking = false;
                resolveTtsDone?.();
              }
              return;
            }
            const next = turnTtsFirstByteMs === undefined ? ttsFailoverChain.shift() : undefined;
            if (!next) {
              console.error("[voice] TTS turn failed", err);
              agentIsSpeaking = false;
              resolveTtsDone?.();
              return;
            }
            console.warn(`[voice] TTS failover: switching to "${next}" for this turn after the previous provider failed before any audio played`, err);
            recordProviderFailover();
            // Replay whatever text was already sent to the dead connection
            // straight to the new one's `real.sendText` — not through the
            // wrapper below, since that text is already in sentTextBuffer
            // and re-pushing it would duplicate the buffer on a second
            // failover in the same turn.
            realTts = attemptTts(next, [...sentTextBuffer]);
          },
          attemptProvider,
          voiceIdForProvider(ttsVoiceIdOverride, ttsVoiceIdProvider, attemptProvider),
          languageOverride,
          (word) => spokenWords.push(word),
        );
        for (const text of replayText) real.sendText(text);
        wrapper = {
          sendText(text: string) {
            sentTextBuffer.push(text);
            textReachedProvider = true;
            real.sendText(text);
          },
          endTurn: () => real.endTurn(),
          close: () => real.close(),
          // ADR-082: this wrapper omitted setTone, so `tts?.setTone?.(emotion)`
          // in sendTtsTextWithTone resolved to undefined on every live turn and
          // expressive delivery (the tone-tag feature, 2026-07-17) was silently
          // dead in production for every call that synthesized audio. The `?.`
          // was deliberate — an unimplemented provider should no-op — which is
          // exactly why nothing surfaced it. Only the cached-audio path was
          // unaffected (it sets `tts = null` and never calls setTone at all),
          // which is why no test caught it either. Forwarded conditionally so a
          // provider that genuinely lacks setTone still no-ops.
          setTone: real.setTone ? (tone: string) => real.setTone?.(tone) : undefined,
        };
        return wrapper;
      };

      // ADR-083: this used to be `tts = attemptTts(primaryTtsProvider)`, which
      // opened the socket here — at the top of the turn, before generate() had
      // run the LLM and any tool round-trips. On a turn with a tool call that
      // gap is seconds long, and both Cartesia and Sarvam kill a websocket that
      // has sat open with no messages. The resulting close landed in onError
      // above, which read it as a provider hard-failure: it burned a link off
      // the failover chain, called recordProviderFailover, and flipped
      // activeTtsProvider for the *rest of the call* (failover is deliberately
      // sticky, see the comment above). One slow tool call could therefore
      // switch a US caller onto Sarvam's *-IN voice permanently, with the real
      // provider perfectly healthy the whole time.
      //
      // So connect on first byte of text instead. Everything downstream already
      // goes through `tts?.`, so a facade with the same TtsConnection shape is
      // a drop-in: the socket now opens when there is something to synthesize,
      // which is also when the provider expects it.
      tts = {
        sendText(text: string) {
          if (!realTts) {
            realTts = attemptTts(activeTtsProvider ?? primaryTtsProvider);
            // A tone parsed before the socket existed still applies to this
            // turn — setTone is contractually "before any sendText".
            if (pendingTone !== undefined) realTts.setTone?.(pendingTone);
          }
          realTts.sendText(text);
        },
        endTurn() {
          endTurnRequested = true;
          if (realTts) {
            realTts.endTurn();
            return;
          }
          // Turn produced no speakable text at all (aborted mid-generate, or a
          // pure tool turn). No socket was ever opened, so no provider will
          // report done — release the waiter rather than stalling 8s on it.
          agentIsSpeaking = false;
          resolveTtsDone?.();
        },
        close() {
          if (realTts) {
            realTts.close();
            return;
          }
          agentIsSpeaking = false;
          resolveTtsDone?.();
        },
        setTone(tone: string) {
          if (realTts) realTts.setTone?.(tone);
          else pendingTone = tone;
        },
      };
    }

    let fullText = "";
    let wasInterrupted = false;
    try {
      fullText = await generate(turnAbortController.signal);
      // Expressive delivery (2026-07-17) — `fullText` is generate()'s own
      // complete return value, entirely separate from the streamed deltas
      // sendTtsTextWithTone already stripped above. Stripped here too so the
      // tag never lands in conversation history, the transcript, or the
      // barge-in "what did the caller actually hear" reconstruction below —
      // none of which should ever show `[[tone:calm]]` as if it were
      // something the agent said out loud.
      fullText = stripToneTag(fullText).text;
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        console.error("[voice] agent turn failed", err);
      } else {
        wasInterrupted = true;
      }
    } finally {
      tts?.endTurn();
    }

    // Latency benchmark (§2): one row per turn, regardless of whether the
    // turn was interrupted/errored — a partial/aborted turn's latency up to
    // the point it got cut off is still real data, not something to discard.
    //
    // Bug fix (2026-07-17, found while investigating the "5-10s dead air on
    // outbound calls" report): this used to read turnTtsFirstByteMs
    // immediately after `generate()` resolved — but the LLM finishing its
    // full response says nothing about whether TTS has produced its first
    // audio byte yet (TTS lags behind LLM token generation, especially on a
    // short reply where the LLM finishes almost instantly). Snapshotting
    // this early meant turnTtsFirstByteMs (and therefore voiceToVoiceMs,
    // which is derived from it) was silently null on effectively every
    // turn — confirmed against real production turn_latency rows, where
    // ttsFirstByteMs/voiceToVoiceMs were null on every single turn despite
    // the call-level ttsFirstByteMs (captured live, inside the TTS callback
    // itself, not snapshotted) showing real ~1.4s values. `turnIndex` is
    // still reserved synchronously right here (see reserveTurnIndex's doc
    // comment on why); only reading the metrics and inserting the row waits
    // for `ttsDone` (bounded, same 8s cap used below for the hangup/
    // transfer path) — still a fire-and-forget insert, nothing downstream
    // awaits it.
    const thisTurnIndex = reserveTurnIndex();
    void (async () => {
      await Promise.race([ttsDone, sleep(8000)]);
      await persistTurnLatency(thisTurnIndex, {
        llmTtftMs: options?.turnLlmTtftRef?.value,
        ttsFirstByteMs: turnTtsFirstByteMs,
        voiceToVoiceMs: options?.turnStartedAt !== undefined && turnTtsFirstByteMs !== undefined
          ? ttsRequestedAt + turnTtsFirstByteMs - options.turnStartedAt
          : undefined,
      });
    })();

    // Barge-in happened and we have real word-timing data: record only what
    // the caller actually heard, not the full (possibly much longer) reply
    // the LLM had already finished generating — LLMs stream faster than TTS
    // speaks, so on interruption the full text is often already sitting in
    // `fullText` even though the caller only heard the first few words.
    // Pushing the untruncated text into history would make the agent "recall"
    // saying things it never actually said out loud.
    if (wasInterrupted && spokenWords.length > 0) {
      fullText = spokenWords.join(" ");
    }

    if (fullText) {
      history.push({ role: "assistant", content: fullText });
      await logTranscript("agent", fullText);
    }

    // hangUp/transferToHuman requested this turn — let the closing/handoff
    // line actually finish (best-effort) before acting on it, see the
    // helpers above for why this can only ever be an estimate.
    if (pendingHangUp || pendingTransfer) {
      await Promise.race([ttsDone, sleep(8000)]);
      // Bounded separately from the silence timer: waiting for playback here
      // holds the PSTN leg (and its per-minute cost) open, and a runaway LLM
      // closing line should not be able to stall teardown for a full minute.
      await sleep(Math.min(estimateRemainingPlaybackMs(fullText), CLOSING_LINE_MAX_WAIT_MS));

      // Transfer takes precedence over hang-up when the model requested both
      // in the same turn (ADR-082). This branch used to be the other way
      // round, and it silently discarded `pendingTransfer` — call 21
      // (2026-08-09) is the reference case: the agent said "let me connect you
      // with a licensed advisor right now", the caller answered "Okay", and the
      // model read that as BOTH assent to the handoff and a goodbye, emitting
      // transferToHuman and hangUp together (its own hangUp reason was "caller
      // said goodbye"). The caller was hung up on instead of transferred, and
      // the call was still recorded completed/booked — a lost lead that looks
      // like a success on the dashboard.
      //
      // Transfer is the safe resolution of the ambiguity in both directions: a
      // transfer IS an ending (the caller keeps talking, to a human), so
      // honouring it when the model meant "goodbye" costs one bridged call,
      // whereas honouring the hangup when the model meant "handoff" drops a
      // caller who was explicitly promised a person. performTransfer already
      // falls back to a hang-up when the org has no transfer number
      // configured, so the worst case here is exactly the old behaviour.
      if (pendingTransfer) {
        const { reason } = pendingTransfer;
        if (pendingHangUp) {
          console.warn(
            `[voice] same-turn transferToHuman + hangUp — honouring the transfer and dropping the hangup (transfer: "${reason}", hangup: "${pendingHangUp.reason}")`,
          );
        }
        pendingTransfer = undefined;
        pendingHangUp = undefined;
        await performTransfer(ws, reason);
      } else if (pendingHangUp) {
        const { reason } = pendingHangUp;
        pendingHangUp = undefined;
        await performHangUp(ws, reason);
      }
    } else if (!ended) {
      // Every spoken turn (greeting, normal reply, or a silence re-prompt/
      // goodbye) goes through this function — arming the caller-silence
      // timer here, once, covers all of them instead of needing a call site
      // at every place a turn gets run.
      //
      // Audit 10 (2026-08-09): the silence window must start when the caller
      // has finished HEARING this turn, not when we finished sending it — see
      // armSilenceTimer. `wasInterrupted` means the caller barged in and the
      // rest of this turn's audio was discarded, so there is nothing left in
      // flight to wait for; anything else is still playing out.
      armSilenceTimer(ws, wasInterrupted ? 0 : estimateRemainingPlaybackMs(fullText));
    }
  }

  /**
   * @param turnStartedAt Latency benchmark (§2) — Date.now() captured at
   * the moment the STT provider declared speechFinal for the caller
   * utterance this turn is responding to. Threaded through from the STT
   * handler below so voiceToVoiceMs measures real caller-perceived wait,
   * not just work done inside this function.
   */
  async function runTurn(ws: Sendable, turnStartedAt: number) {
    const turnLlmTtftRef: { value?: number } = {};
    // §3a: at most one filler line per turn — a turn with several sequential
    // slow tool calls should still only interject once, not once per call.
    let fillerPlayedThisTurn = false;
    await speak(
      ws,
      (signal) =>
        runVoiceAgentTurn({
          history,
          persona,
          signal,
          onTextDelta: (delta) => sendTtsTextWithTone(delta),
          onToolCall: (name, input, output) => void logToolCall(ws, name, input, output),
          onLatency: (ms, model) => {
            console.log(`[voice] turn time-to-first-token: ${ms}ms (${model})`);
            recordLlmLatency(ms);
            turnLlmTtftRef.value = ms;
          },
          llmProvider: llmProviderOverride,
          llmModel: llmModelOverride,
          llmFallbackModels: llmFallbackModelsOverride,
          enabledTools: enabledToolsOverride,
          capturedState,
          callerMemory: callerMemoryFacts,
          orgId: humanNumberOrgId,
          cartRecovery: cartRecoveryContext,
          codOrder: codOrderContext,
          crmSync: crmSyncContext,
          workflowMetadata,
          onSlowToolCall: (toolName) => {
            if (fillerPlayedThisTurn) return;
            fillerPlayedThisTurn = true;
            console.log(`[voice] tool call "${toolName}" still running past the filler threshold — playing filler audio`);
            void maybePlayToolCallFiller(ws);
          },
        }),
      { turnStartedAt, turnLlmTtftRef },
    );
  }

  /**
   * ADR-062: stamp when the disclosure/opening turn actually fired. The
   * recording/AI disclosure is prepended to the very start of the opening
   * turn (see @weeber/compliance's withDisclosure), so the moment the
   * greeting finishes speaking is the moment disclosure was delivered as
   * audio. Fire-and-forget and gated on disclosure actually being configured
   * for this call — a failure here just leaves the audit record's fire-time
   * empty, it never blocks the call. Idempotent via disclosureFiredStamped.
   */
  function stampDisclosureFired() {
    if (disclosureFiredStamped || !disclosureConfigured || !callSid) return;
    disclosureFiredStamped = true;
    void withRetry(
      () => db.update(calls).set({ disclosureFiredAt: new Date() }).where(eq(calls.twilioCallSid, callSid!)),
      { label: "persist-disclosure-fired" },
    ).catch((err) => console.error("[voice] failed to persist disclosureFiredAt", err));
  }

  async function runGreeting(ws: Sendable) {
    // Latency fix (2026-07-16): a fully-resolved literal greeting was
    // rendered in the "start" handler — speak it directly via the same
    // canned-line path as the silence re-prompt/goodbye (no LLM call, and
    // eligible for the hybrid-audio-cache flag same as those). Falls
    // through to the LLM-generated greeting below whenever this is unset.
    if (literalGreetingText) {
      await speakCannedLine(ws, literalGreetingText);
      stampDisclosureFired();
      return;
    }

    const turnLlmTtftRef: { value?: number } = {};
    await speak(
      ws,
      (signal) =>
        runVoiceAgentGreeting({
          persona,
          signal,
          onTextDelta: (delta) => sendTtsTextWithTone(delta),
          capturedState,
          callerMemory: callerMemoryFacts,
          llmProvider: llmProviderOverride,
          llmModel: llmModelOverride,
          llmFallbackModels: llmFallbackModelsOverride,
          enabledTools: enabledToolsOverride,
          orgId: humanNumberOrgId,
          codOrder: codOrderContext,
          crmSync: crmSyncContext,
          workflowMetadata,
          onLatency: (ms, model) => {
            console.log(`[voice] greeting time-to-first-token: ${ms}ms (${model})`);
            recordLlmLatency(ms);
            turnLlmTtftRef.value = ms;
          },
        }),
      // No turnStartedAt for the greeting — it's agent-initiated, not a
      // response to caller speech, so there's no voiceToVoiceMs to measure.
      { turnLlmTtftRef },
    );
    stampDisclosureFired();
  }

  /**
   * Connects the STT provider for this call. Deliberately called from the
   * "start" handler (after `sttProviderOverride`/`languageOverride` are
   * resolved off the agent config), not eagerly in `onOpen` — the language
   * has to be known before the socket opens for providers like Sarvam that
   * take it as a connection-time query param, not a per-request field.
   * `onOpen` fires immediately, before any of that async agent-config lookup
   * has happened, so connecting there (the old Deepgram-only behavior) meant
   * language could never actually be threaded through. Audio that arrives in
   * the (typically tens-of-ms) window between "start" and this connecting is
   * buffered in `pendingAudioChunks` and flushed right after, not dropped.
   */
  function connectSttForCall(ws: Sendable, failoverProvider?: "deepgram" | "sarvam" | "elevenlabs") {
    stt = connectStt(
      async ({ text, isFinal, speechFinal }) => {
        try {
          // Barge-in: if the agent is mid-response and the caller starts
          // talking again, cut the agent off immediately.
          if (agentIsSpeaking && text.trim().length > 0) {
            if (streamSid) ws.send(transport.buildClear(streamSid));
            turnAbortController?.abort();
            tts?.close();
            tts = null;
            agentIsSpeaking = false;
            // Caller cut in — a fresh utterance begins; restart the timer so a
            // backchannel is measured against THIS utterance, not the prior one.
            callerUtteranceStartedAt = null;
          }

          // Phase IV: backchannels fire on mid-utterance (interim, not
          // speech_final) partials while the agent is silent — see
          // backchannel.ts. Evaluated BEFORE the speech_final early-return
          // below, since by definition a backchannel never fires on the final.
          const trimmed = text.trim();
          if (trimmed && !speechFinal && !agentIsSpeaking) {
            const now = Date.now();
            if (callerUtteranceStartedAt === null) callerUtteranceStartedAt = now;
            if (
              shouldBackchannel({
                enabled: backchannelsEnabled,
                agentIsSpeaking,
                speechFinal,
                hasText: true,
                utteranceMs: now - callerUtteranceStartedAt,
                msSinceLastBackchannel: lastBackchannelAt === null ? null : now - lastBackchannelAt,
              })
            ) {
              lastBackchannelAt = now;
              maybePlayBackchannel(ws);
            }
          }

          if (!speechFinal || !isFinal || !text.trim()) return;

          // A real end-of-turn is being consumed — the current utterance is
          // over, so reset the backchannel utterance timer for the next one.
          callerUtteranceStartedAt = null;

          // Latency benchmark (§2): captured as close as possible to the
          // STT provider's own speechFinal instant — this is the caller's
          // "I'm done talking" moment voiceToVoiceMs measures from, so it
          // has to be taken here, before any of the awaits below (History
          // logging, guardrail checks) can add their own skew to it.
          const turnStartedAt = Date.now();

          // Caller actually responded — reset silence handling (a fresh
          // warning stage next time they go quiet, not an immediate hangup)
          // regardless of the mid-thought check below — real speech arrived
          // either way.
          //
          // recordCallerSpeech() is the half that clearSilenceTimer() cannot
          // do: if the silence timeout has ALREADY fired and is suspended
          // inside `await speakCannedLine`, clearing the timer changes
          // nothing and the goodbye + hangup still land on a caller who is
          // demonstrably talking. Bumping the epoch here is what makes that
          // in-flight timeout abandon itself. See handleSilenceTimeout.
          silenceWarningIssued = false;
          recordCallerSpeech();
          clearSilenceTimer();

          // A1b: the vendor endpointing signal fired, but the sentence
          // itself reads as mid-thought — wait for one more beat instead of
          // answering a fragment. Re-arm the silence timer manually since
          // no turn (and therefore no armSilenceTimer call further down)
          // runs on this path — the re-prompt is still the backstop if the
          // caller genuinely stopped here rather than actually continuing.
          const turnEnd = await turnDetector.decide({ text });
          if (!turnEnd.done) {
            armSilenceTimer(ws);
            return;
          }

          // Heuristic, defense-in-depth guardrail detector — independent of
          // whether the model itself calls flagGuardrailEvent (see agent.ts).
          if (looksLikePromptInjection(text)) {
            void logToolCall(
              ws,
              "guardrail-heuristic-detector",
              { category: "prompt-injection", callerText: text },
              { detectedBy: "heuristic-phrase-match" },
            );
          }

          history.push({ role: "user", content: text });
          await logTranscript("caller", text);
          await runTurn(ws, turnStartedAt);
        } catch (err) {
          console.error("[voice] error handling transcript event", err);
        }
      },
      (err) => {
        // STT provider gave up (or hard-failed). Cross-provider failover
        // (2026-07-17, recommendation #1 of
        // docs/product-infra-and-gtm-report.md Part 4): try the next
        // provider in this call's fallback chain before giving up — the
        // call can no longer hear the caller on the dead provider, but a
        // reconnect on a *different* provider is often still possible.
        // Only end the call once the whole chain is exhausted.
        console.error("[voice] fatal STT error", err);
        if (sttFailoverQueue === null) {
          const activeProvider = resolveSttProvider(failoverProvider ?? sttProviderOverride);
          sttFailoverQueue = resolveSttFailoverChain(activeProvider, sttFallbackOrderOverride);
        }
        const next = sttFailoverQueue.shift();
        if (!next) {
          console.error("[voice] STT failover chain exhausted, ending call");
          endCallOnFatalError(ws);
          return;
        }
        console.warn(`[voice] STT failover: switching to "${next}" mid-call after the previous provider failed`);
        recordProviderFailover();
        stt?.close();
        connectSttForCall(ws, next);
      },
      (stats) => {
        // Surface reconnect counts on the call record so a flaky call is
        // visible in the data, not just buried in logs.
        if (!callSid) return;
        sttReconnectCount = stats.reconnectCount;
        void withRetry(
          () =>
            db
              .update(calls)
              .set({ sttReconnectCount: stats.reconnectCount })
              .where(eq(calls.twilioCallSid, callSid!)),
          { label: "update-stt-stats" },
        );
      },
      (ms) => {
        sttConnectMs = ms;
        void persistLatency();
      },
      failoverProvider ?? sttProviderOverride,
      languageOverride,
    );

    if (pendingAudioChunks.length > 0) {
      for (const chunk of pendingAudioChunks.splice(0)) stt.sendAudio(chunk);
    }
  }

  return {
    onOpen() {
      // STT connects once the call's language/provider is resolved — see
      // connectSttForCall's doc comment. Nothing to do here anymore.
    },

    async onMessage(raw: string, ws: Sendable) {
      const event = transport.parseInbound(raw);
      if (event.type === "unknown") return;

      try {
        if (event.type === "start") {
          // Captured before anything else in this handler runs — every DB
          // round-trip, provider connect, and greeting-generation step that
          // follows counts against pickupToFirstAudioMs from this instant.
          callAnsweredAt = Date.now();
          streamSid = event.streamId;
          callSid = event.callId;
          const session = callSid ? await sessionStore.get(callSid) : undefined;

          // G1.1: bind the merchant's discount for this call once, here.
          // Returns undefined unless this call carries a shop, a stable
          // checkout ref, AND a configured percentage > 0 — in which case
          // the agent simply never gets the discount tool (see
          // buildVoiceTools), which is the behaviour the cart-recovery
          // persona already documents ("if not configured, skip Step 2
          // entirely, do not invent a coupon").
          cartRecoveryContext = resolveCartRecoveryContext({
            metadata: session?.workflowMetadata,
            checkoutToken: session?.checkoutToken,
          });
          // G1.3: same source, different consumer — the discount context above
          // authorizes a *tool*, this hands the *model* the order facts it's
          // calling about.
          workflowMetadata = session?.workflowMetadata;
          codOrderContext = resolveCodOrderContext({ metadata: session?.workflowMetadata });

          if (callSid) {
            let [row] = await db
              .select()
              .from(calls)
              .where(eq(calls.twilioCallSid, callSid))
              .limit(1);

            // Twilio/Plivo both hit an inbound webhook (which inserts the
            // `calls` row) before the WS ever opens — Exotel's WS-only
            // AgentStream has no such step (see voice/routes.ts), so if
            // nothing was pre-created, insert a minimal row now from
            // whatever the start event itself carried.
            //
            // Latency fix (2026-07-17): this used to explicitly exclude
            // Twilio (`provider !== "twilio"`) on the theory that Twilio's
            // own answer webhook always finishes its insert first — true
            // when that insert was awaited, but it's now fire-and-forget
            // (routes.ts's /incoming) specifically so it stops blocking the
            // TwiML response, which means the media stream can legitimately
            // connect and reach here before that insert lands. Now covers
            // Twilio too, and — since `session` (outbound calls: set at
            // placement time, well before ringing) already carries the real
            // org/persona/direction context that a bare Exotel fallback
            // never has — enriched from it instead of the placeholder
            // "inbound" direction with no persona/org this branch used to
            // fall back to for Twilio never has. onConflictDoNothing means
            // whichever insert (this one, or the webhook's) lands second is
            // a harmless no-op.
            if (!row && event.from && event.to) {
              // Same org attribution as /incoming's insert (org-attribution.ts):
              // this branch only runs for a genuinely inbound call whose
              // webhook insert hasn't landed yet, i.e. exactly the case where
              // there is no session orgId to inherit. Resolving it from the
              // dialled number here — not just in the route — is what stops
              // the two insert paths from disagreeing about the org, and is
              // what makes humanNumberOrgId below non-undefined for inbound
              // (feeding caller memory, feature flags, persona and CRM sync).
              // Costs one extra round-trip, and only in this race case.
              const fallbackOrgId = session?.orgId ?? (await resolveOrgIdForNumbers(event.to, event.from));
              const [inserted] = await db
                .insert(calls)
                .values({
                  provider,
                  twilioCallSid: callSid,
                  direction: session?.direction ?? "inbound",
                  fromNumber: event.from,
                  toNumber: event.to,
                  status: "in-progress",
                  agentPersona: session?.persona ?? null,
                  webhookUrl: session?.webhookUrl ?? null,
                  orgId: fallbackOrgId,
                })
                .onConflictDoNothing()
                .returning();
              row = inserted ?? row;
            }

            dbCallId = row?.id ?? null;
            toNumber = row?.toNumber;
            capturedState = { ...row?.capturedState, ...session?.capturedState };

            // Cross-call memory (ADR-023) — a returning caller's prior facts,
            // separate from this call's capturedState. Best-effort: a lookup
            // failure shouldn't block the call from proceeding.
            if (row) {
              humanNumber = resolveHumanNumber(row.direction, row.fromNumber, row.toNumber);
              humanNumberOrgId = row.orgId ?? undefined;
              // G1.4 (ADR-069): bound here, from the same carrier-reported
              // numbers cross-call memory already trusts — not from anything
              // the model says.
              crmSyncContext = resolveCrmSyncContext({ orgId: humanNumberOrgId, humanNumber });
            }

            // Per-number config (see number-config.ts) applies to every call
            // on that number; an explicit session override (outbound trigger,
            // e.g. POST /calls/outbound) takes precedence when both exist.
            const numberConfig = getNumberConfig(row?.toNumber);
            webhookUrl = resolveWebhookUrl(session?.webhookUrl ?? numberConfig.webhookUrl ?? row?.webhookUrl ?? undefined);

            // Latency fix (audit follow-up, 2026-07-16): these three lookups
            // are mutually independent — each only needs `row`/`session`/
            // `numberConfig`/`humanNumberOrgId`, all already resolved above —
            // but used to run as three sequential awaited DB round-trips
            // before the greeting could even start. On an outbound call this
            // entire chain runs only *after* pickup, directly adding to the
            // caller-perceived pickup-to-first-word delay (measured ~1-3s in
            // production). Running them concurrently instead of in sequence
            // removes two round-trips' worth of that wait for free — no
            // behavior change, purely a scheduling change.
            const [callerMemoryResult, agentConfig, effectiveFlagsResult, orgRow, leadGreetingContext] = await Promise.all([
              row ? getCallerMemory(humanNumberOrgId, humanNumber!).catch(() => ({})) : Promise.resolve({}),
              // Misc-1: a "call my phone" test call carries the merchant's
              // exact in-progress form state — use it directly and skip the
              // DB-backed resolution entirely, same as the WS test call does.
              session?.resolvedConfigOverride
                ? Promise.resolve(session.resolvedConfigOverride)
                : resolveAgentConfig({
                    explicitPersona: session?.persona ?? numberConfig.persona ?? row?.agentPersona ?? undefined,
                    calledNumber: row?.toNumber,
                    orgId: session?.orgId ?? row?.orgId ?? undefined,
                    templateKey: session?.workflowName ?? undefined,
                    direction: (row?.direction ?? session?.direction) === "outbound" ? "outbound" : "inbound",
                  }),
              humanNumberOrgId ? getEffectiveFlags(humanNumberOrgId).catch(() => ({})) : Promise.resolve({}),
              // Only needed to fill {{merchant_name}}/{{company_name}} in a
              // literalGreetingTemplate (see below) — folded into the same
              // batch rather than a separate later round-trip.
              humanNumberOrgId
                ? db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, humanNumberOrgId)).limit(1).catch(() => [])
                : Promise.resolve([]),
              // ADR-085: the lead's own name/intake fields, for outbound
              // templates that open by naming the person ({{lead_name}},
              // {{interest_area}}). Folded into this batch rather than added as
              // a later await — it must not add to pickup-to-first-word.
              // Best-effort: a lookup failure just means the greeting falls back
              // to the LLM path, exactly as it did before this existed.
              getLeadGreetingContext(humanNumberOrgId, humanNumber).catch(() => ({})),
            ]);
            callerMemoryFacts = callerMemoryResult;
            persona = agentConfig.systemPrompt;

            // Global Compliance Engine Tier 0 (2026-07-16,
            // docs/global-compliance-engine-plan.md #2/#3): persist the exact
            // disclosure text + version resolved for this call as soon as it's
            // known — audit-trail requirement, proving disclosure was spoken
            // isn't enough without knowing what was actually said, in which
            // language. Fire-and-forget like the sttReconnectCount update
            // below — a failure here shouldn't block the call itself, just
            // means this one call's audit record is incomplete.
            if (callSid && (agentConfig.disclosureText || agentConfig.disclosureVersion)) {
              disclosureConfigured = true;
              void withRetry(
                () =>
                  db
                    .update(calls)
                    .set({
                      disclosureText: agentConfig.disclosureText ?? null,
                      disclosureVersion: agentConfig.disclosureVersion ?? null,
                    })
                    .where(eq(calls.twilioCallSid, callSid!)),
                { label: "persist-disclosure" },
              );
            }

            // Latency fix (2026-07-16): render the template's fixed
            // greeting line directly instead of paying the LLM's ~1s+
            // time-to-first-token for a line that's deterministic once its
            // merge tags resolve. Falls back to the existing LLM-generated
            // greeting (literalGreetingText stays undefined) whenever:
            // there's no literalGreetingTemplate for this call (custom
            // persona, or a template that doesn't have one), or any {{tag}} in
            // the template can't be resolved from context — renderTemplate
            // leaves an unresolved tag as literal "{{tag}}" text, so that's the
            // signal checked.
            //
            // Language (2026-07-19): resolveAgentConfig now hands us a
            // language-APPROPRIATE literalGreetingTemplate — the audited
            // translated line for a non-English configured language (insurance
            // 04–08), or undefined for a language with no audited greeting (so
            // we never speak the English line through a non-English voice).
            // That means the English-only gate here is no longer needed; if a
            // greeting string is present, it's safe to speak in this call's
            // voice.
            if (agentConfig.literalGreetingTemplate) {
              const merchantName = orgRow[0]?.name;
              // Precedence, lowest to highest: the lead row (what we knew
              // before dialling) < capturedState (what this call has already
              // confirmed) < agent identity. So a lead whose name was corrected
              // mid-call is greeted by the corrected name on a later re-render,
              // and a stale intake field never overrides a confirmed one.
              const greetingContext: Record<string, string> = {
                ...leadGreetingContext,
                ...capturedState,
                agent_name: agentConfig.agentName ?? "our team",
              };
              if (merchantName) {
                greetingContext.merchant_name = merchantName;
                greetingContext.company_name = merchantName;
              }
              const rendered = renderTemplate(agentConfig.literalGreetingTemplate, greetingContext);
              if (!/\{\{\w+\}\}/.test(rendered)) {
                literalGreetingText = rendered;
              }
            }
            enabledToolsOverride = agentConfig.enabledTools;
            llmModelOverride = agentConfig.llmModel;
            ttsVoiceIdOverride = agentConfig.voiceId;
            // Per-agent frame config takes precedence over per-number config, which
            // takes precedence over the session override — matches the persona
            // resolution priority (org/agent-specific beats number-wide defaults).
            ttsProviderOverride = agentConfig.ttsProvider ?? session?.ttsProvider ?? numberConfig.ttsProvider;
            llmProviderOverride = agentConfig.llmProvider ?? session?.llmProvider ?? numberConfig.llmProvider;
            sttProviderOverride = agentConfig.sttProvider ?? session?.sttProvider ?? numberConfig.sttProvider;
            sttFallbackOrderOverride = agentConfig.sttFallbackOrder;
            ttsFallbackOrderOverride = agentConfig.ttsFallbackOrder;
            llmFallbackModelsOverride = agentConfig.llmFallbackModels;
            languageOverride = agentConfig.language ?? session?.language ?? numberConfig.language;
            // Voice identity (see tts-voice-identity.ts) — resolved once, here,
            // so every later turn/canned line/cache key agrees on which
            // provider owns `ttsVoiceIdOverride` and which provider the caller
            // is currently hearing. `voiceId` and `voiceProvider` are saved as
            // a pair on the agent config, so the provider resolved from this
            // call's overrides right now is the one that voice was picked for.
            activeTtsProvider = resolveTtsProvider(ttsProviderOverride, languageOverride);
            ttsVoiceIdProvider = ttsVoiceIdOverride ? activeTtsProvider : undefined;

            // Control: optional hard cap on call length (per-call override or
            // per-number config).
            const maxDurationSeconds = session?.maxDurationSeconds ?? numberConfig.maxDurationSeconds;
            if (maxDurationSeconds) {
              maxDurationTimer = setTimeout(() => {
                console.warn(`[voice] call ${callSid} hit its max duration — ending`);
                void finalizeCall("completed");
                try {
                  if (streamSid) ws.send(transport.buildClear(streamSid));
                } catch {
                  // socket may already be closed — ignore
                }
              }, maxDurationSeconds * 1000);
            }

            // §3b: resolved once per call, here, alongside every other
            // org-scoped setting — the media handler below can't itself
            // await a flag lookup on every single audio frame. Fetched
            // concurrently with callerMemory/agentConfig above, not again here.
            const noiseFilterFlags: Record<string, boolean> = effectiveFlagsResult;
            if (noiseFilterFlags[ADAPTIVE_NOISE_FILTER_FLAG] === true) {
              noiseFilter = createRollingNoiseFilter();
            }
            if (noiseFilterFlags[WIND_NOISE_FILTER_FLAG] === true) {
              windFilter = createHighPassFilter();
            }
            expressiveDeliveryEnabled = noiseFilterFlags[EXPRESSIVE_DELIVERY_FLAG] === true;
            backchannelsEnabled = noiseFilterFlags[BACKCHANNEL_FLAG] === true;
            // Phase V: build the per-call end-of-turn detector from the flag.
            // refiner is null (no model vendor wired — deferred per the
            // build-plan gate), so today this returns the plain heuristic and
            // behaves exactly as the old inline endsMidThought check.
            turnDetector = createTurnDetector({
              semanticEnabled: noiseFilterFlags[SEMANTIC_TURN_DETECTION_FLAG] === true,
              refiner: null,
            });
            // Warm the backchannel clips now (fire-and-forget), only when the
            // feature is on, so the first mid-utterance ack is an instant
            // cache hit rather than a live synth — same warm-on-start pattern
            // as the tool-call fillers. No-op past the first call thanks to
            // the shared tts-cache.
            if (backchannelsEnabled) {
              for (const line of BACKCHANNEL_LINES) void warmFillerCache(line);
            }
          }

          connectSttForCall(ws);
          history = [];
          await runGreeting(ws);
          return;
        }

        if (event.type === "media") {
          let audio = Buffer.from(event.mulawBase64, "base64");
          // Wind-noise filter runs *before* the adaptive noise filter on
          // purpose (2026-07-17, wind-noise-filter.ts) — stripping out
          // wind's low-frequency rumble first means noiseFilter's RMS gate
          // (below) is judging genuine remaining loudness, not a signal
          // still inflated by a wind gust it can't otherwise tell apart
          // from speech. Both independently flag-gated; either, both, or
          // neither can be null, and each is a zero-cost no-op when off.
          if (windFilter) {
            audio = Buffer.from(applyHighPassToMulaw(audio, windFilter));
          }
          if (noiseFilter) {
            audio = Buffer.from(applyNoiseFilterToMulaw(audio, noiseFilter));
          }
          if (stt) {
            stt.sendAudio(audio);
          } else if (pendingAudioChunks.length < MAX_PENDING_AUDIO_CHUNKS) {
            pendingAudioChunks.push(audio);
          }
          return;
        }

        if (event.type === "stop") {
          await finalizeCall("completed");
        }
      } catch (err) {
        console.error(`[voice] error handling ${provider} event`, event.type, err);
      }
    },

    onClose() {
      void finalizeCall("completed").catch((err) =>
        console.error("[voice] error finalizing call on close", err),
      );
    },
  };
}
