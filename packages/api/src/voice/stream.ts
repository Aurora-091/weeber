import type { ModelMessage } from "ai";
import twilioPkg from "twilio";
const { VoiceResponse } = twilioPkg.twiml;
import { connectStt, resolveSttProvider } from "./stt";
import type { SttConnection } from "./stt";
import { connectTts, resolveTtsProvider } from "./tts";
import type { TtsConnection } from "./tts";
import { resolveSttFailoverChain, resolveTtsFailoverChain } from "./failover";
import { runVoiceAgentTurn, runVoiceAgentGreeting, resolveAgentConfig } from "./agent";
import type { AvailableToolName } from "./agent-frame";
import { sessionStore } from "./session-store";
import { getNumberConfig } from "./number-config";
import { runWorkflowForOutcome } from "./workflows/engine";
import { resumeWorkflowAfterCall } from "./workflows/graph-engine";
import type { WorkflowOutcome } from "./workflows/types";
import { dispatchWebhook, resolveWebhookUrl } from "./webhooks";
import { getCallerMemory, upsertCallerMemory, resolveHumanNumber } from "./caller-memory";
import { getTwilioClientForOrg, getPublicUrl } from "./twilio-client";
import { hangupPlivoCall, transferPlivoCall } from "./plivo-client";
import { sendSmsForOrg } from "./send-sms";
import { buildDtmfAudio, isValidDtmfSequence } from "./dtmf";
import { getCachedTtsAudio, setCachedTtsAudio, HYBRID_AUDIO_CACHE_FLAG } from "./tts-cache";
import { getEffectiveFlags } from "./org-queries";
import { renderTemplate } from "./workflows/variables";
import { createRollingNoiseFilter, applyNoiseFilterToMulaw, ADAPTIVE_NOISE_FILTER_FLAG } from "./audio-noise-filter";
import type { NoiseFilter } from "./audio-noise-filter";
import { createHighPassFilter, applyHighPassToMulaw, WIND_NOISE_FILTER_FLAG } from "./wind-noise-filter";
import type { HighPassFilter } from "./wind-noise-filter";
import { stripToneTag, CARTESIA_EMOTION_BY_TONE, TONE_TAG_MAX_BUFFER_CHARS, EXPRESSIVE_DELIVERY_FLAG } from "./tone-tags";
import { getTelephonyTransport, type TelephonyProvider } from "./telephony-transport";
import { estimateCallCostCents } from "./cost-estimate";
import { db } from "../database";
import { withRetry } from "../database/with-retry";
import { calls, transcripts, toolCalls, callLatency, turnLatency, orgs } from "../database/schema";
import { eq } from "drizzle-orm";

type Sendable = { send: (data: string) => void; close?: (code?: number, reason?: string) => void };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Heuristic-only estimate of remaining audio playback time after the TTS
 * provider has finished *sending* every chunk for this turn — sending isn't
 * the same as Twilio having finished *playing* it back to the caller.
 * ~18 characters/sec is a reasonably conservative average spoken pace;
 * clamped so a one-word reply doesn't wait needlessly long and a long
 * closing line doesn't get cut short.
 */
export function estimateRemainingPlaybackMs(text: string): number {
  return Math.min(Math.max(text.length * 55, 400), 4000);
}

/**
 * Best-effort, defense-in-depth phrase detector for prompt-injection
 * attempts in raw caller speech — independent of whether the model itself
 * calls flagGuardrailEvent (see agent.ts's withCallControl persona
 * instructions). Not a filter/blocker — the model still decides how to
 * respond — this only guarantees the attempt is logged for dashboard
 * review even if the model doesn't self-report it.
 */
const INJECTION_PHRASE_PATTERNS = [
  /ignore\s+(all|your|the|any)?\s*(previous|prior|above)?\s*instructions?/i,
  /disregard\s+(your|the|any)?\s*(previous|prior)?\s*instructions?/i,
  /forget\s+(your|the)?\s*(rules|instructions|prompt|guidelines)/i,
  /you('re| are)\s+now\s+(a|an)\b/i,
  /pretend\s+(you'?re|to be|you are)/i,
  /act\s+as\s+(if|a|an)\b/i,
  /reveal\s+your\s+(system\s+)?(prompt|instructions)/i,
  /what\s+(is|are)\s+your\s+(system\s+)?(prompt|instructions)/i,
  /i('m| am)\s+(the\s+|a\s+)?(developer|admin|administrator)\b/i,
];

export function looksLikePromptInjection(text: string): boolean {
  return INJECTION_PHRASE_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * A1b (VAD/endpointing audit, 2026-07-14): Deepgram's `endpointing`/
 * `speech_final` is a single fixed-silence-timeout signal — it has no idea
 * whether the caller's sentence is actually grammatically complete. A
 * caller who pauses mid-thought right after a conjunction/filler ("and...",
 * "so...", "um...") can get cut off and answered on a fragment. This is a
 * cheap, rule-based regex-context check (not a model call) layered on top
 * of the vendor signal, matching the report's "endpointing as rule-based +
 * regex-context, not vendor-signal-alone" recommendation — the caller
 * simply gets treated as still-mid-turn for one more beat; the existing
 * silence-timeout re-prompt is still the backstop if they really did stop.
 */
const TRAILING_FILLER_PATTERN = /\b(and|so|but|or|because|um+|uh+|like|well|then)[.,]?$/i;

export function endsMidThought(text: string): boolean {
  return TRAILING_FILLER_PATTERN.test(text.trim());
}

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
  let llmModelOverride: string | undefined;
  let enabledToolsOverride: AvailableToolName[] | undefined;
  let toNumber: string | undefined;
  let capturedDisposition: string | undefined;
  let capturedSentiment: string | undefined;
  let capturedIntent: string | undefined;
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

  /** Caller-silence handling (re-prompt once, then hang up) — see armSilenceTimer. */
  let silenceTimer: ReturnType<typeof setTimeout> | null = null;
  let silenceWarningIssued = false;

  function clearSilenceTimer() {
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
  }

  async function logTranscript(role: "caller" | "agent", text: string) {
    if (!dbCallId) return;
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
    if (name === "hangUp" && input && typeof input === "object" && "reason" in input) {
      pendingHangUp = { reason: String((input as { reason: unknown }).reason) };
    }
    if (name === "transferToHuman" && input && typeof input === "object" && "reason" in input) {
      pendingTransfer = { reason: String((input as { reason: unknown }).reason) };
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
            ttsProvider: ttsProviderOverride,
            durationSeconds,
          });
        }
      } catch (err) {
        console.error("[voice] failed to compute per-call cost estimate", err);
      }

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
              ttsProviderUsed: ttsProviderOverride ?? null,
              llmProviderUsed: llmProviderOverride ?? null,
              estimatedCostUsdCents,
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
    if (callSid && provider === "twilio") {
      await (await getTwilioClientForOrg(humanNumberOrgId))
        .calls(callSid)
        .update({ status: "completed" })
        .catch((err) => console.error("[voice] failed to end Twilio call via REST API", err));
    } else if (callSid && provider === "plivo" && humanNumberOrgId) {
      // Plivo hangup (2026-07-17, closing the gap flagged in docs/india-telephony.md) — see
      // plivo-client.ts's hangupPlivoCall doc comment for the API this calls.
      const result = await hangupPlivoCall(humanNumberOrgId, callSid);
      if (!result.ok) console.error(`[voice] failed to end Plivo call via REST API: ${result.error}`);
    } else if (callSid) {
      console.warn(`[voice] hangUp on ${provider} call ${callSid} — closing the WebSocket only, no REST hangup wired up for this provider yet`);
    }
    try {
      ws.close?.();
    } catch {
      // socket may already be closed — ignore
    }
    await finalizeCall("completed");
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

    if (callSid && provider === "twilio") {
      const twiml = new VoiceResponse();
      twiml.dial(transferNumber);
      await (await getTwilioClientForOrg(humanNumberOrgId))
        .calls(callSid)
        .update({ twiml: twiml.toString() })
        .catch((err) => console.error("[voice] failed to redirect call for transfer", err));
    } else if (callSid && provider === "plivo" && humanNumberOrgId) {
      const alegUrl = `${getPublicUrl()}/api/voice/transfer-xml/plivo?to=${encodeURIComponent(transferNumber)}`;
      const result = await transferPlivoCall(humanNumberOrgId, callSid, alegUrl);
      if (!result.ok) console.error(`[voice] failed to redirect Plivo call for transfer: ${result.error}`);
    }
    await finalizeCall("transferred");
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

    const resolvedProvider = resolveTtsProvider(ttsProviderOverride, languageOverride);
    const cached = getCachedTtsAudio(resolvedProvider, ttsVoiceIdOverride, languageOverride, text);
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
    setCachedTtsAudio(resolvedProvider, ttsVoiceIdOverride, languageOverride, text, chunks);
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
    const resolvedProvider = resolveTtsProvider(ttsProviderOverride, languageOverride);
    if (getCachedTtsAudio(resolvedProvider, ttsVoiceIdOverride, languageOverride, text)) return;
    const chunks: string[] = [];
    await new Promise<void>((resolve) => {
      const warmupTts = connectTts(
        (base64Audio) => chunks.push(base64Audio),
        () => resolve(),
        (err) => {
          console.error("[voice] failed to warm filler-audio cache", err);
          resolve();
        },
        ttsProviderOverride,
        ttsVoiceIdOverride,
        languageOverride,
      );
      warmupTts.sendText(text);
      warmupTts.endTurn();
    });
    setCachedTtsAudio(resolvedProvider, ttsVoiceIdOverride, languageOverride, text, chunks);
  }

  async function maybePlayToolCallFiller(ws: Sendable) {
    const flagOrgId = humanNumberOrgId ?? undefined;
    const flags: Record<string, boolean> = flagOrgId
      ? await getEffectiveFlags(flagOrgId).catch(() => ({}))
      : {};
    if (flags[HYBRID_AUDIO_CACHE_FLAG] !== true) return;
    if (ended || !streamSid) return;

    const text = TOOL_CALL_FILLER_LINES[Math.floor(Math.random() * TOOL_CALL_FILLER_LINES.length)];
    const resolvedProvider = resolveTtsProvider(ttsProviderOverride, languageOverride);
    const cached = getCachedTtsAudio(resolvedProvider, ttsVoiceIdOverride, languageOverride, text);
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

  function armSilenceTimer(ws: Sendable) {
    if (ended) return;
    clearSilenceTimer();
    silenceTimer = setTimeout(() => {
      void handleSilenceTimeout(ws);
    }, silenceWarningIssued ? SILENCE_HANGUP_MS : SILENCE_WARNING_MS);
  }

  async function handleSilenceTimeout(ws: Sendable) {
    if (ended) return;
    if (!silenceWarningIssued) {
      silenceWarningIssued = true;
      await speakCannedLine(ws, "Are you still there? Let me know if you need anything else.");
      armSilenceTimer(ws);
    } else {
      await speakCannedLine(ws, "I haven't heard back, so I'll go ahead and end the call here. Feel free to call back anytime. Goodbye.");
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
      const ttsFailoverChain = resolveTtsFailoverChain(resolveTtsProvider(ttsProviderOverride, languageOverride), ttsFallbackOrderOverride);
      const sentTextBuffer: string[] = [];

      const attemptTts = (providerOverride: string | undefined, replayText: string[] = []): TtsConnection => {
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
            tts = attemptTts(next, [...sentTextBuffer]);
          },
          providerOverride,
          ttsVoiceIdOverride,
          languageOverride,
          (word) => spokenWords.push(word),
        );
        for (const text of replayText) real.sendText(text);
        return {
          sendText(text: string) {
            sentTextBuffer.push(text);
            real.sendText(text);
          },
          endTurn: () => real.endTurn(),
          close: () => real.close(),
        };
      };

      tts = attemptTts(ttsProviderOverride);
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
      await sleep(estimateRemainingPlaybackMs(fullText));

      if (pendingHangUp) {
        const { reason } = pendingHangUp;
        pendingHangUp = undefined;
        pendingTransfer = undefined;
        await performHangUp(ws, reason);
      } else if (pendingTransfer) {
        const { reason } = pendingTransfer;
        pendingTransfer = undefined;
        await performTransfer(ws, reason);
      }
    } else if (!ended) {
      // Every spoken turn (greeting, normal reply, or a silence re-prompt/
      // goodbye) goes through this function — arming the caller-silence
      // timer here, once, covers all of them instead of needing a call site
      // at every place a turn gets run.
      armSilenceTimer(ws);
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

  async function runGreeting(ws: Sendable) {
    // Latency fix (2026-07-16): a fully-resolved literal greeting was
    // rendered in the "start" handler — speak it directly via the same
    // canned-line path as the silence re-prompt/goodbye (no LLM call, and
    // eligible for the hybrid-audio-cache flag same as those). Falls
    // through to the LLM-generated greeting below whenever this is unset.
    if (literalGreetingText) {
      await speakCannedLine(ws, literalGreetingText);
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
          }

          if (!speechFinal || !isFinal || !text.trim()) return;

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
          silenceWarningIssued = false;
          clearSilenceTimer();

          // A1b: the vendor endpointing signal fired, but the sentence
          // itself reads as mid-thought — wait for one more beat instead of
          // answering a fragment. Re-arm the silence timer manually since
          // no turn (and therefore no armSilenceTimer call further down)
          // runs on this path — the re-prompt is still the backstop if the
          // caller genuinely stopped here rather than actually continuing.
          if (endsMidThought(text)) {
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
                  orgId: session?.orgId ?? null,
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
            const [callerMemoryResult, agentConfig, effectiveFlagsResult, orgRow] = await Promise.all([
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
            // persona, or a template that doesn't have one), the language
            // is anything other than English (Hindi/other variants aren't
            // wired here yet), or any {{tag}} in the template can't be
            // resolved from context — renderTemplate leaves an unresolved
            // tag as literal "{{tag}}" text, so that's the signal checked.
            const resolvedLanguage = agentConfig.language ?? session?.language ?? numberConfig.language;
            if (agentConfig.literalGreetingTemplate && (!resolvedLanguage || resolvedLanguage === "en")) {
              const merchantName = orgRow[0]?.name;
              const greetingContext: Record<string, string> = { ...capturedState, agent_name: agentConfig.agentName ?? "our team" };
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
