/**
 * Live voice test call for the Preview drawer (AGENT-CONSOLE-UI-PLAN.md
 * Phase 2) — real mic-in/agent-voice-out over a browser WebSocket, hitting
 * the actual STT -> LLM -> TTS pipeline every real call uses
 * (connectStt/connectTts/runVoiceAgentTurn/runVoiceAgentGreeting, unchanged).
 *
 * Deliberately NOT createVoiceStreamHandlers (stream.ts) with a 4th
 * provider — that state machine is the full production call engine: DB
 * call rows, workflows, webhooks, DNC/compliance, cross-call caller memory,
 * Twilio REST hangup/transfer. None of that belongs in a test sandbox (same
 * principle the existing text test-chat already follows — "does NOT create
 * a call row, does NOT count against usage" — this is that same sandbox,
 * just with real voice instead of text).
 *
 * Wire format: simple JSON text frames (not Twilio's envelope), 8kHz mulaw
 * audio (matches connectStt/connectTts's existing assumption exactly — see
 * audio-codec.ts — so this needs zero STT/TTS provider changes; the
 * browser-side codec in packages/web/src/web/lib/audio-codec.ts is a
 * ported copy of the same pure encode/decode math).
 *
 *   Client -> Server: {"type":"media","audio":"<base64 mulaw>"}
 *                      {"type":"stop"}
 *   Server -> Client: {"type":"ready"}
 *                      {"type":"audio","audio":"<base64 mulaw>"}
 *                      {"type":"transcript","role":"caller"|"agent","text":"..."}
 *                      {"type":"clear"}   (barge-in: stop queued playback now)
 *                      {"type":"failover","simulated":true,"channel":"stt"|"tts","from":"...","to":"..."}
 *                      {"type":"ended","reason":"..."}
 *                      {"type":"error","message":"..."}
 *
 * The "failover" event only ever fires when the caller opted into the
 * Preview drawer's "Simulate provider failure" toggle (test-call-tokens.ts's
 * `simulateFailover`) — sent once right after "ready", before the greeting,
 * for each channel (STT/TTS) that has a resolvable fallback. Always carries
 * `simulated: true`; there is no code path today that emits a real one from
 * this sandbox handler (a genuine mid-call failover is stream.ts/production
 * territory), so `simulated` is forward-looking documentation of intent, not
 * a field the client needs to branch on yet.
 */
import type { ModelMessage } from "ai";
import { connectStt, resolveSttProvider } from "./stt";
import type { SttConnection } from "./stt";
import { connectTts, resolveTtsProvider } from "./tts";
import type { TtsConnection } from "./tts";
import { voiceIdForProvider } from "./tts-voice-identity";
import { toolCallReason } from "./call-control";
import { runVoiceAgentTurn, runVoiceAgentGreeting, resolveAgentConfig, buildPreviewAgentConfig } from "./agent";
import type { TestCallTokenPayload } from "./test-call-tokens";
import { resolveSttFailoverChain, resolveTtsFailoverChain } from "./failover";

type Sendable = { send: (data: string) => void; close?: (code?: number, reason?: string) => void };

/** Hard cap on a single test call — same "can't be unmetered" principle as
 * previewRateLimited/testChatRateLimited (app/routes.ts), sized generously
 * for an actual back-and-forth test conversation without letting one
 * forgotten-open tab run indefinitely against billed STT/LLM/TTS. */
const MAX_TEST_CALL_DURATION_MS = 5 * 60_000;

export function createTestCallStreamHandlers(payload: TestCallTokenPayload) {
  let history: ModelMessage[] = [];
  let stt: SttConnection | null = null;
  let tts: TtsConnection | null = null;
  let turnAbortController: AbortController | null = null;
  let agentIsSpeaking = false;
  let ended = false;
  let maxDurationTimer: ReturnType<typeof setTimeout> | null = null;

  let persona: string | undefined;
  let ttsProviderOverride: "elevenlabs" | "cartesia" | "sarvam" | undefined;
  let llmProviderOverride: "gateway" | "groq" | undefined;
  let sttProviderOverride: "deepgram" | "sarvam" | "elevenlabs" | undefined;
  let languageOverride: string | undefined;
  let ttsVoiceIdOverride: string | undefined;
  let llmModelOverride: string | undefined;
  let enabledToolsOverride: import("./agent-frame").AvailableToolName[] | undefined;
  /**
   * Call-control intent from the current turn — same contract as stream.ts's
   * `pendingHangUp`/`pendingTransfer`: `hangUp` and `transferToHuman` only
   * *signal* intent, they never end anything themselves.
   *
   * This module used to ignore both: `onToolCall` logged `[tool: hangUp]` as a
   * caption and nothing else. `buildVoiceTools` always re-adds `hangUp`
   * (`new Set([...enabledTools, "hangUp"])`), so every preview agent has it and
   * will use it the moment the conversation is genuinely over — at which point
   * the test call kept the mic open and kept billing STT/LLM/TTS until the
   * 5-minute cap or the user closed the drawer. That is the "call is not
   * ending" defect on the surface most likely to be tested first.
   *
   * A transfer can only be *reported* here: there is no PSTN leg to redirect in
   * a browser test call, so it ends the call and says so rather than pretending
   * a handoff happened.
   */
  let pendingCallControl: { tool: "hangUp" | "transferToHuman"; reason: string } | undefined;

  function endCall(ws: Sendable, reason: string) {
    if (ended) return;
    ended = true;
    stt?.close();
    tts?.close();
    turnAbortController?.abort();
    if (maxDurationTimer) clearTimeout(maxDurationTimer);
    try {
      ws.send(JSON.stringify({ type: "ended", reason }));
      ws.close?.();
    } catch {
      // socket may already be closed — ignore
    }
  }

  /** Same shape as stream.ts's speak() minus everything DB/workflow/webhook-related
   * — barge-in, tool calls (still real — users should see their configured tools
   * actually fire), and transcript events, no call-row/latency/disposition persistence. */
  async function speak(ws: Sendable, generate: (signal: AbortSignal) => Promise<string>) {
    turnAbortController = new AbortController();
    agentIsSpeaking = true;

    tts = connectTts(
      (base64Audio) => {
        try {
          ws.send(JSON.stringify({ type: "audio", audio: base64Audio }));
        } catch (err) {
          console.error("[test-call] failed to forward TTS audio", err);
        }
      },
      () => {
        agentIsSpeaking = false;
      },
      (err) => {
        console.error("[test-call] TTS turn failed", err);
        agentIsSpeaking = false;
      },
      ttsProviderOverride,
      ttsVoiceIdOverride,
      languageOverride,
    );

    let fullText = "";
    try {
      fullText = await generate(turnAbortController.signal);
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        console.error("[test-call] agent turn failed", err);
      }
    } finally {
      tts?.endTurn();
    }

    if (fullText) {
      history.push({ role: "assistant", content: fullText });
      try {
        ws.send(JSON.stringify({ type: "transcript", role: "agent", text: fullText }));
      } catch {
        // ignore — socket may be closing
      }
    }

    if (pendingCallControl) {
      const { tool, reason } = pendingCallControl;
      pendingCallControl = undefined;
      await waitForClosingLine();
      endCall(
        ws,
        tool === "hangUp"
          ? `agent ended the call: ${reason}`
          : `agent asked to transfer (no human leg exists in a test call): ${reason}`,
      );
    }
  }

  /**
   * Waits (bounded) for the closing line to actually reach the browser before
   * the socket is closed underneath it. `agentIsSpeaking` flips false from
   * connectTts's `onDone`, i.e. "the provider has sent every chunk for this
   * turn" — the same signal stream.ts's `ttsDone` carries, and the same caveat:
   * sent is not played, hence the fixed grace period for audio already buffered
   * in the browser. Bounded so a provider that never reports done cannot wedge
   * the call open, which is the failure this whole path exists to end.
   */
  async function waitForClosingLine() {
    const deadline = Date.now() + 8000;
    while (agentIsSpeaking && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }

  async function runTurn(ws: Sendable) {
    await speak(ws, (signal) =>
      runVoiceAgentTurn({
        history,
        persona,
        signal,
        onTextDelta: (delta) => tts?.sendText(delta),
        onToolCall: (name, input) => {
          // Real tools genuinely fire in a test call (same as production) —
          // surfaced as a transcript-adjacent event so the drawer's Text
          // tab / caption log can show "tool: bookAppointment" the same
          // way the existing text test-chat sandbox already does.
          try {
            ws.send(JSON.stringify({ type: "transcript", role: "agent", text: `[tool: ${name}]` }));
          } catch {
            // ignore — socket may be closing
          }
          // ...and the two call-control tools are acted on, not just captioned
          // (see pendingCallControl). Registered on the tool NAME alone: a
          // missing `reason` must never be what decides whether a call ends.
          if (name === "hangUp" || name === "transferToHuman") {
            pendingCallControl = { tool: name, reason: toolCallReason(input, "no reason given") };
          }
        },
        llmProvider: llmProviderOverride,
        llmModel: llmModelOverride,
        enabledTools: enabledToolsOverride,
      }),
    );
  }

  async function runGreeting(ws: Sendable) {
    await speak(ws, (signal) =>
      runVoiceAgentGreeting({
        persona,
        signal,
        onTextDelta: (delta) => tts?.sendText(delta),
        llmProvider: llmProviderOverride,
        llmModel: llmModelOverride,
        enabledTools: enabledToolsOverride,
      }),
    );
  }

  function connectSttForCall(ws: Sendable) {
    stt = connectStt(
      async ({ text, isFinal, speechFinal }) => {
        try {
          if (agentIsSpeaking && text.trim().length > 0) {
            // Barge-in — same behavior as a real call.
            ws.send(JSON.stringify({ type: "clear" }));
            turnAbortController?.abort();
            tts?.close();
            tts = null;
            agentIsSpeaking = false;
          }

          if (!speechFinal || !isFinal || !text.trim()) return;

          history.push({ role: "user", content: text });
          try {
            ws.send(JSON.stringify({ type: "transcript", role: "caller", text }));
          } catch {
            // ignore — socket may be closing
          }
          await runTurn(ws);
        } catch (err) {
          console.error("[test-call] error handling transcript event", err);
        }
      },
      (err) => {
        console.error("[test-call] fatal STT error, ending test call", err);
        endCall(ws, "stt-error");
      },
      undefined,
      undefined,
      sttProviderOverride,
      languageOverride,
    );
  }

  return {
    async onOpen(ws: Sendable) {
      try {
        const agentConfig = payload.configOverride
          ? await buildPreviewAgentConfig(payload.templateKey, payload.configOverride, payload.orgId)
          : await resolveAgentConfig({ orgId: payload.orgId, templateKey: payload.templateKey });

        persona = agentConfig.systemPrompt;
        enabledToolsOverride = agentConfig.enabledTools;
        llmModelOverride = agentConfig.llmModel;
        ttsVoiceIdOverride = agentConfig.voiceId;
        ttsProviderOverride = agentConfig.ttsProvider;
        llmProviderOverride = agentConfig.llmProvider;
        sttProviderOverride = agentConfig.sttProvider;
        languageOverride = agentConfig.language;

        // Phase 3 (2026-07-17): "Simulate provider failure" toggle in the
        // Preview drawer. Resolves this agent's actual configured STT/TTS
        // failover chain (same resolveXFailoverChain calls stream.ts makes
        // on a real mid-call provider error) and starts the test call
        // straight on the first fallback instead of the primary — no real
        // error is injected into any provider connection, this just proves
        // the configured chain by using it, then announces it over the WS
        // so the drawer can show exactly what a real failover would look
        // like for this agent's current settings.
        const failoverEvents: { channel: "stt" | "tts"; from: string; to: string }[] = [];
        if (payload.simulateFailover) {
          const sttPrimary = resolveSttProvider(sttProviderOverride, languageOverride);
          const sttChain = resolveSttFailoverChain(sttPrimary, agentConfig.sttFallbackOrder);
          if (sttChain.length > 0) {
            failoverEvents.push({ channel: "stt", from: sttPrimary, to: sttChain[0] });
            sttProviderOverride = sttChain[0];
          }
          // `languageOverride` is passed here for the same reason it is on the
          // STT line above: without it this resolves the English-first default
          // and the preview would report a failover chain the real call would
          // never take for an Indic-language agent (ADR-060's smart default).
          const ttsPrimary = resolveTtsProvider(ttsProviderOverride, languageOverride);
          const ttsChain = resolveTtsFailoverChain(ttsPrimary, agentConfig.ttsFallbackOrder);
          if (ttsChain.length > 0) {
            failoverEvents.push({ channel: "tts", from: ttsPrimary, to: ttsChain[0] });
            ttsProviderOverride = ttsChain[0];
            // Voice identity (see tts-voice-identity.ts): the configured voice
            // ID belongs to the primary provider, so it must not travel to the
            // fallback — the preview would either error or silently synthesize
            // in the fallback's env-default voice, neither of which is what a
            // real failover sounds like.
            ttsVoiceIdOverride = voiceIdForProvider(ttsVoiceIdOverride, ttsPrimary, ttsChain[0]);
          }
        }

        maxDurationTimer = setTimeout(() => {
          console.warn(`[test-call] org ${payload.orgId} test call hit its max duration — ending`);
          endCall(ws, "max-duration");
        }, MAX_TEST_CALL_DURATION_MS);

        connectSttForCall(ws);
        history = [];
        ws.send(JSON.stringify({ type: "ready" }));
        for (const evt of failoverEvents) {
          ws.send(JSON.stringify({ type: "failover", simulated: true, ...evt }));
        }
        await runGreeting(ws);
      } catch (err) {
        console.error("[test-call] failed to start test call", err);
        try {
          ws.send(JSON.stringify({ type: "error", message: "Failed to start test call" }));
        } catch {
          // ignore
        }
        endCall(ws, "startup-error");
      }
    },

    onMessage(raw: string, ws: Sendable) {
      if (ended) return;
      let event: { type?: string; audio?: string };
      try {
        event = JSON.parse(raw);
      } catch {
        return;
      }

      if (event.type === "media" && event.audio) {
        const audio = Buffer.from(event.audio, "base64");
        stt?.sendAudio(audio);
        return;
      }

      if (event.type === "stop") {
        endCall(ws, "client-stopped");
      }
    },

    onClose() {
      if (ended) return;
      ended = true;
      stt?.close();
      tts?.close();
      turnAbortController?.abort();
      if (maxDurationTimer) clearTimeout(maxDurationTimer);
    },
  };
}
