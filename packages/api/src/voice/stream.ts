import type { ModelMessage } from "ai";
import twilioPkg from "twilio";
const { VoiceResponse } = twilioPkg.twiml;
import { connectDeepgram } from "./deepgram";
import { connectTts } from "./tts";
import type { TtsConnection } from "./tts";
import { runVoiceAgentTurn, runVoiceAgentGreeting, resolvePersona } from "./agent";
import { sessionStore } from "./session-store";
import { getNumberConfig } from "./number-config";
import { runWorkflowForOutcome } from "./workflows/engine";
import type { WorkflowOutcome } from "./workflows/types";
import { dispatchWebhook, resolveWebhookUrl } from "./webhooks";
import { getCallerMemory, upsertCallerMemory, resolveHumanNumber } from "./caller-memory";
import { twilioClient } from "./twilio-client";
import { db } from "../database";
import { withRetry } from "../database/with-retry";
import { calls, transcripts, toolCalls, callLatency, orgs } from "../database/schema";
import { eq } from "drizzle-orm";

type TwilioEvent =
  | { event: "start"; start: { streamSid: string; callSid: string } }
  | { event: "media"; media: { payload: string } }
  | { event: "mark"; mark: { name: string } }
  | { event: "stop" };

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
export function createVoiceStreamHandlers() {
  let streamSid: string | null = null;
  let callSid: string | null = null;
  let dbCallId: number | null = null;
  let webhookUrl: string | null = null;
  let persona: string | undefined;
  let ttsProviderOverride: "elevenlabs" | "cartesia" | undefined;
  let llmProviderOverride: "gateway" | "groq" | undefined;
  let toNumber: string | undefined;
  let capturedDisposition: string | undefined;
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
   * once per call — first STT connect, first LLM time-to-first-token, first TTS first-audio-byte —
   * and persisted as a single row when the call ends, not written continuously (unlike capturedState,
   * these aren't needed for crash recovery, just for the dashboard after the fact).
   */
  let sttConnectMs: number | undefined;
  let llmTtftMs: number | undefined;
  let ttsFirstByteMs: number | undefined;

  function recordLlmLatency(ms: number) {
    if (llmTtftMs === undefined) llmTtftMs = ms;
  }

  /** Cross-call memory (ADR-023) — the human's number for this call, and their rolling facts, if any. */
  let humanNumber: string | undefined;
  let humanNumberOrgId: string | undefined;
  let callerMemoryFacts: Record<string, string> = {};

  let deepgram: ReturnType<typeof connectDeepgram> | null = null;
  let tts: TtsConnection | null = null;
  let turnAbortController: AbortController | null = null;
  let agentIsSpeaking = false;

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

  async function logToolCall(name: string, input: unknown, output: unknown) {
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
    }
  }

  async function finalizeCall(status: string) {
    if (ended) return;
    ended = true;
    deepgram?.close();
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
            })
            .where(eq(calls.twilioCallSid, callSid!)),
        { label: "finalize-call" },
      );

      // Per-call latency breakdown (ADR-022) — only write a row if we actually
      // captured at least one metric, so a call that failed before Deepgram
      // ever connected doesn't leave a pointless all-null row behind.
      if (dbCallId && (sttConnectMs !== undefined || llmTtftMs !== undefined || ttsFirstByteMs !== undefined)) {
        await db
          .insert(callLatency)
          .values({ callId: dbCallId, sttConnectMs, llmTtftMs, ttsFirstByteMs })
          .onConflictDoUpdate({
            target: callLatency.callId,
            set: { sttConnectMs, llmTtftMs, ttsFirstByteMs, capturedAt: new Date() },
          })
          .catch((err) => console.error("[voice] failed to persist call latency", err));
      }

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

  function endCallOnFatalError(ws: Sendable) {
    try {
      if (streamSid) ws.send(JSON.stringify({ event: "clear", streamSid }));
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
   * guarantee the underlying PSTN call hangs up. */
  async function performHangUp(ws: Sendable, reason: string) {
    console.log(`[voice] hangUp requested: ${reason}`);
    clearSilenceTimer();
    if (callSid) {
      await twilioClient
        .calls(callSid)
        .update({ status: "completed" })
        .catch((err) => console.error("[voice] failed to end Twilio call via REST API", err));
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
   * the caller it was transferring them. */
  async function performTransfer(ws: Sendable, reason: string) {
    console.log(`[voice] transferToHuman requested: ${reason}`);
    clearSilenceTimer();
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
      await twilioClient
        .calls(callSid)
        .update({ twiml: twiml.toString() })
        .catch((err) => console.error("[voice] failed to redirect call for transfer", err));
    }
    await finalizeCall("transferred");
  }

  /** Speaks a fixed line with no LLM call involved — used for the silence
   * re-prompt/goodbye so a flaky LLM turn can't compound an already-quiet
   * caller into an even longer wait. */
  async function speakCannedLine(ws: Sendable, text: string) {
    await speak(ws, async () => text);
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
  async function speak(ws: Sendable, generate: (signal: AbortSignal) => Promise<string>) {
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

    tts = connectTts(
      (base64Audio) => {
        if (ttsFirstByteMs === undefined) ttsFirstByteMs = Date.now() - ttsRequestedAt;
        if (!streamSid) return;
        try {
          ws.send(JSON.stringify({ event: "media", streamSid, media: { payload: base64Audio } }));
        } catch (err) {
          console.error("[voice] failed to forward TTS audio to Twilio", err);
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
    );

    let fullText = "";
    try {
      fullText = await generate(turnAbortController.signal);
    } catch (err) {
      if ((err as Error).name !== "AbortError") console.error("[voice] agent turn failed", err);
    } finally {
      tts?.endTurn();
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
        onToolCall: (name, input, output) => void logToolCall(name, input, output),
        onLatency: (ms, model) => {
          console.log(`[voice] turn time-to-first-token: ${ms}ms (${model})`);
          recordLlmLatency(ms);
        },
        llmProvider: llmProviderOverride,
        capturedState,
        callerMemory: callerMemoryFacts,
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
        onLatency: (ms, model) => {
          console.log(`[voice] greeting time-to-first-token: ${ms}ms (${model})`);
          recordLlmLatency(ms);
        },
      }),
    );
  }

  return {
    onOpen(ws: Sendable) {
      deepgram = connectDeepgram(
        async ({ text, isFinal, speechFinal }) => {
          try {
            // Barge-in: if the agent is mid-response and the caller starts
            // talking again, cut the agent off immediately.
            if (agentIsSpeaking && text.trim().length > 0) {
              if (streamSid) ws.send(JSON.stringify({ event: "clear", streamSid }));
              turnAbortController?.abort();
              tts?.close();
              tts = null;
              agentIsSpeaking = false;
            }

            if (!speechFinal || !isFinal || !text.trim()) return;

            // Caller actually responded — reset silence handling (a fresh
            // warning stage next time they go quiet, not an immediate hangup).
            silenceWarningIssued = false;
            clearSilenceTimer();

            // Heuristic, defense-in-depth guardrail detector — independent of
            // whether the model itself calls flagGuardrailEvent (see agent.ts).
            if (looksLikePromptInjection(text)) {
              void logToolCall(
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
          // Deepgram gave up reconnecting — the call can no longer hear the
          // caller. End the call rather than leaving it hanging silently.
          console.error("[voice] fatal Deepgram error, ending call", err);
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
        },
      );
    },

    async onMessage(raw: string, ws: Sendable) {
      let msg: TwilioEvent;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      try {
        if (msg.event === "start") {
          streamSid = msg.start.streamSid;
          callSid = msg.start.callSid;
          const session = callSid ? await sessionStore.get(callSid) : undefined;

          if (callSid) {
            const [row] = await db
              .select()
              .from(calls)
              .where(eq(calls.twilioCallSid, callSid))
              .limit(1);
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
            persona = await resolvePersona({
              explicitPersona: session?.persona ?? numberConfig.persona ?? row?.agentPersona ?? undefined,
              calledNumber: row?.toNumber,
              orgId: session?.orgId ?? row?.orgId ?? undefined,
              templateKey: session?.workflowName ?? undefined,
            });
            ttsProviderOverride = session?.ttsProvider ?? numberConfig.ttsProvider;
            llmProviderOverride = session?.llmProvider ?? numberConfig.llmProvider;

            // Control: optional hard cap on call length (per-call override or
            // per-number config).
            const maxDurationSeconds = session?.maxDurationSeconds ?? numberConfig.maxDurationSeconds;
            if (maxDurationSeconds) {
              maxDurationTimer = setTimeout(() => {
                console.warn(`[voice] call ${callSid} hit its max duration — ending`);
                void finalizeCall("completed");
                try {
                  ws.send(JSON.stringify({ event: "clear", streamSid }));
                } catch {
                  // socket may already be closed — ignore
                }
              }, maxDurationSeconds * 1000);
            }
          }

          history = [];
          await runGreeting(ws);
          return;
        }

        if (msg.event === "media") {
          const audio = Buffer.from(msg.media.payload, "base64");
          deepgram?.sendAudio(audio);
          return;
        }

        if (msg.event === "stop") {
          await finalizeCall("completed");
        }
      } catch (err) {
        console.error("[voice] error handling Twilio event", msg.event, err);
      }
    },

    onClose() {
      void finalizeCall("completed").catch((err) =>
        console.error("[voice] error finalizing call on close", err),
      );
    },
  };
}
