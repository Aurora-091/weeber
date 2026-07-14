import type { ModelMessage } from "ai";
import twilioPkg from "twilio";
const { VoiceResponse } = twilioPkg.twiml;
import { connectStt } from "./stt";
import type { SttConnection } from "./stt";
import { connectTts, resolveTtsProvider } from "./tts";
import type { TtsConnection } from "./tts";
import { runVoiceAgentTurn, runVoiceAgentGreeting, resolveAgentConfig } from "./agent";
import type { AvailableToolName } from "./agent-frame";
import { sessionStore } from "./session-store";
import { getNumberConfig } from "./number-config";
import { runWorkflowForOutcome } from "./workflows/engine";
import { resumeWorkflowAfterCall } from "./workflows/graph-engine";
import type { WorkflowOutcome } from "./workflows/types";
import { dispatchWebhook, resolveWebhookUrl } from "./webhooks";
import { getCallerMemory, upsertCallerMemory, resolveHumanNumber } from "./caller-memory";
import { getTwilioClientForOrg } from "./twilio-client";
import { sendSmsForOrg } from "./send-sms";
import { buildDtmfAudio, isValidDtmfSequence } from "./dtmf";
import { getCachedTtsAudio, setCachedTtsAudio, HYBRID_AUDIO_CACHE_FLAG } from "./tts-cache";
import { getEffectiveFlags } from "./org-queries";
import { getTelephonyTransport, type TelephonyProvider } from "./telephony-transport";
import { db } from "../database";
import { withRetry } from "../database/with-retry";
import { calls, transcripts, toolCalls, callLatency, orgs } from "../database/schema";
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
  let sttProviderOverride: "deepgram" | "sarvam" | undefined;
  let languageOverride: string | undefined;
  /** Per-agent frame overrides (see agent-frame.ts, agent.ts's resolveAgentConfig) — all
   * undefined unless the call's org+template has a configured agent config row. */
  let ttsVoiceIdOverride: string | undefined;
  let llmModelOverride: string | undefined;
  let enabledToolsOverride: AvailableToolName[] | undefined;
  let toNumber: string | undefined;
  let capturedDisposition: string | undefined;
  let capturedSentiment: string | undefined;
  let history: ModelMessage[] = [];
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

  /**
   * Upserts whichever of the three metrics are currently set. Safe to call multiple times per call
   * (once per metric as it's first captured, plus once more at finalizeCall as a final safety net) —
   * each call just re-upserts the current in-memory snapshot, which is always a superset of the last.
   */
  async function persistLatency() {
    if (!dbCallId) return;
    if (sttConnectMs === undefined && llmTtftMs === undefined && ttsFirstByteMs === undefined) return;
    await db
      .insert(callLatency)
      .values({ callId: dbCallId, sttConnectMs, llmTtftMs, ttsFirstByteMs })
      .onConflictDoUpdate({
        target: callLatency.callId,
        set: { sttConnectMs, llmTtftMs, ttsFirstByteMs, capturedAt: new Date() },
      })
      .catch((err) => console.error("[voice] failed to persist call latency", err));
  }

  function recordLlmLatency(ms: number) {
    if (llmTtftMs === undefined) {
      llmTtftMs = ms;
      void persistLatency();
    }
  }

  /** Cross-call memory (ADR-023) — the human's number for this call, and their rolling facts, if any. */
  let humanNumber: string | undefined;
  let humanNumberOrgId: string | undefined;
  let callerMemoryFacts: Record<string, string> = {};

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

      await withRetry(
        () =>
          db
            .update(calls)
            .set({
              status,
              endedAt: new Date(),
              ...(capturedDisposition ? { disposition: capturedDisposition } : {}),
              ...(capturedSentiment ? { sentiment: capturedSentiment } : {}),
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

  /** `orgs.humanTransferNumber` for this call's org, falling back to the
   * HUMAN_TRANSFER_NUMBER env var — same override-then-env-fallback pattern
   * as the outbound caller ID (see routes.ts's /calls/outbound). */
  async function resolveHumanTransferNumber(orgId: string): Promise<string | undefined> {
    const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId)).limit(1).catch(() => [] as never[]);
    return org?.humanTransferNumber ?? process.env.HUMAN_TRANSFER_NUMBER ?? undefined;
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

  /** Redirects the live Twilio call out of the media stream into a real
   * `<Dial>` to a human — the call keeps going, just no longer through the
   * agent. Falls back to hanging up (rather than silently no-oping) if no
   * transfer number is configured anywhere, since the agent already told
   * the caller it was transferring them.
   *
   * Twilio-only — Plivo/Exotel both have different mid-call transfer APIs
   * (Plivo: Call.transfer with a new aleg_url; Exotel: the Legs API's
   * transfer action) that haven't been implemented yet. For those
   * providers this falls back to a hang-up rather than silently pretending
   * to transfer and then just dropping the call. */
  async function performTransfer(ws: Sendable, reason: string) {
    console.log(`[voice] transferToHuman requested: ${reason}`);
    clearSilenceTimer();

    if (provider !== "twilio") {
      console.warn(`[voice] transferToHuman requested on ${provider} call — no transfer API wired up for this provider yet, hanging up instead`);
      await performHangUp(ws, `${reason} (transfer unsupported on ${provider})`);
      return;
    }

    const transferNumber = humanNumberOrgId
      ? await resolveHumanTransferNumber(humanNumberOrgId)
      : (process.env.HUMAN_TRANSFER_NUMBER ?? undefined);

    if (!transferNumber) {
      console.error("[voice] transferToHuman requested but no transfer number is configured anywhere — hanging up instead");
      await performHangUp(ws, "transfer requested but no transfer number configured");
      return;
    }

    if (callSid) {
      const twiml = new VoiceResponse();
      twiml.dial(transferNumber);
      await (await getTwilioClientForOrg(humanNumberOrgId))
        .calls(callSid)
        .update({ twiml: twiml.toString() })
        .catch((err) => console.error("[voice] failed to redirect call for transfer", err));
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

    const resolvedProvider = resolveTtsProvider(ttsProviderOverride);
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
    },
  ) {
    turnAbortController = new AbortController();
    agentIsSpeaking = true;

    const ttsRequestedAt = Date.now();
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
        void persistLatency();
      }
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
      tts = connectTts(
        (base64Audio) => {
          if (ttsFirstByteMs === undefined) {
            ttsFirstByteMs = Date.now() - ttsRequestedAt;
            void persistLatency();
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
        console.error("[voice] TTS turn failed", err);
        agentIsSpeaking = false;
        resolveTtsDone?.();
      },
      ttsProviderOverride,
      ttsVoiceIdOverride,
      languageOverride,
      (word) => spokenWords.push(word),
      );
    }

    let fullText = "";
    let wasInterrupted = false;
    try {
      fullText = await generate(turnAbortController.signal);
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        console.error("[voice] agent turn failed", err);
      } else {
        wasInterrupted = true;
      }
    } finally {
      tts?.endTurn();
    }

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

  async function runTurn(ws: Sendable) {
    await speak(ws, (signal) =>
      runVoiceAgentTurn({
        history,
        persona,
        signal,
        onTextDelta: (delta) => tts?.sendText(delta),
        onToolCall: (name, input, output) => void logToolCall(ws, name, input, output),
        onLatency: (ms, model) => {
          console.log(`[voice] turn time-to-first-token: ${ms}ms (${model})`);
          recordLlmLatency(ms);
        },
        llmProvider: llmProviderOverride,
        llmModel: llmModelOverride,
        enabledTools: enabledToolsOverride,
        capturedState,
        callerMemory: callerMemoryFacts,
        orgId: humanNumberOrgId,
      }),
    );
  }

  async function runGreeting(ws: Sendable) {
    await speak(ws, (signal) =>
      runVoiceAgentGreeting({
        persona,
        signal,
        onTextDelta: (delta) => tts?.sendText(delta),
        capturedState,
        callerMemory: callerMemoryFacts,
        llmProvider: llmProviderOverride,
        llmModel: llmModelOverride,
        enabledTools: enabledToolsOverride,
        orgId: humanNumberOrgId,
        onLatency: (ms, model) => {
          console.log(`[voice] greeting time-to-first-token: ${ms}ms (${model})`);
          recordLlmLatency(ms);
        },
      }),
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
  function connectSttForCall(ws: Sendable) {
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
          await runTurn(ws);
        } catch (err) {
          console.error("[voice] error handling transcript event", err);
        }
      },
      (err) => {
        // STT provider gave up (or hard-failed) — the call can no longer hear
        // the caller. End the call rather than leaving it hanging silently.
        console.error("[voice] fatal STT error, ending call", err);
        endCallOnFatalError(ws);
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
      sttProviderOverride,
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
            // whatever the start event itself carried. Best-effort: this
            // call won't have org/persona/session context an outbound
            // trigger would have set, only what the wire protocol told us.
            if (!row && provider !== "twilio" && event.from && event.to) {
              const [inserted] = await db
                .insert(calls)
                .values({
                  provider,
                  twilioCallSid: callSid,
                  direction: "inbound",
                  fromNumber: event.from,
                  toNumber: event.to,
                  status: "in-progress",
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
              callerMemoryFacts = await getCallerMemory(humanNumberOrgId, humanNumber).catch(() => ({}));
            }

            // Per-number config (see number-config.ts) applies to every call
            // on that number; an explicit session override (outbound trigger,
            // e.g. POST /calls/outbound) takes precedence when both exist.
            const numberConfig = getNumberConfig(row?.toNumber);
            webhookUrl = resolveWebhookUrl(session?.webhookUrl ?? numberConfig.webhookUrl ?? row?.webhookUrl ?? undefined);
            // Misc-1: a "call my phone" test call carries the merchant's
            // exact in-progress form state — use it directly and skip the
            // DB-backed resolution entirely, same as the WS test call does.
            const agentConfig = session?.resolvedConfigOverride
              ? session.resolvedConfigOverride
              : await resolveAgentConfig({
                  explicitPersona: session?.persona ?? numberConfig.persona ?? row?.agentPersona ?? undefined,
                  calledNumber: row?.toNumber,
                  orgId: session?.orgId ?? row?.orgId ?? undefined,
                  templateKey: session?.workflowName ?? undefined,
                });
            persona = agentConfig.systemPrompt;
            enabledToolsOverride = agentConfig.enabledTools;
            llmModelOverride = agentConfig.llmModel;
            ttsVoiceIdOverride = agentConfig.voiceId;
            // Per-agent frame config takes precedence over per-number config, which
            // takes precedence over the session override — matches the persona
            // resolution priority (org/agent-specific beats number-wide defaults).
            ttsProviderOverride = agentConfig.ttsProvider ?? session?.ttsProvider ?? numberConfig.ttsProvider;
            llmProviderOverride = agentConfig.llmProvider ?? session?.llmProvider ?? numberConfig.llmProvider;
            sttProviderOverride = agentConfig.sttProvider ?? session?.sttProvider ?? numberConfig.sttProvider;
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
          }

          connectSttForCall(ws);
          history = [];
          await runGreeting(ws);
          return;
        }

        if (event.type === "media") {
          const audio = Buffer.from(event.mulawBase64, "base64");
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
