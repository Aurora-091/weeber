import type { ModelMessage } from "ai";
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
import { db } from "../database";
import { withRetry } from "../database/with-retry";
import { calls, transcripts, toolCalls, callLatency } from "../database/schema";
import { eq } from "drizzle-orm";

type TwilioEvent =
  | { event: "start"; start: { streamSid: string; callSid: string } }
  | { event: "media"; media: { payload: string } }
  | { event: "mark"; mark: { name: string } }
  | { event: "stop" };

type Sendable = { send: (data: string) => void };

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
  let callerMemoryFacts: Record<string, string> = {};

  let deepgram: ReturnType<typeof connectDeepgram> | null = null;
  let tts: TtsConnection | null = null;
  let turnAbortController: AbortController | null = null;
  let agentIsSpeaking = false;

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
    if (callSid) {
      const priorSession = await sessionStore.get(callSid);
      const previousAttempt = priorSession?.workflowAttempt;
      const priorOrgId = priorSession?.orgId;
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
        await upsertCallerMemory(humanNumber, capturedState, dbCallId);
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

  /** Shared turn runner — used for both the opening greeting and normal replies. */
  async function speak(ws: Sendable, generate: (signal: AbortSignal) => Promise<string>) {
    turnAbortController = new AbortController();
    agentIsSpeaking = true;

    const ttsRequestedAt = Date.now();
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
      },
      (err) => {
        console.error("[voice] TTS turn failed", err);
        agentIsSpeaking = false;
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
              callerMemoryFacts = await getCallerMemory(humanNumber).catch(() => ({}));
            }

            // Per-number config (see number-config.ts) applies to every call
            // on that number; an explicit session override (outbound trigger,
            // e.g. POST /calls/outbound) takes precedence when both exist.
            const numberConfig = getNumberConfig(row?.toNumber);
            webhookUrl = resolveWebhookUrl(session?.webhookUrl ?? numberConfig.webhookUrl ?? row?.webhookUrl ?? undefined);
            persona = resolvePersona(
              session?.persona ?? numberConfig.persona ?? row?.agentPersona ?? undefined,
              row?.toNumber,
            );
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
