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
 *                      {"type":"ended","reason":"..."}
 *                      {"type":"error","message":"..."}
 */
import type { ModelMessage } from "ai";
import { connectStt } from "./stt";
import type { SttConnection } from "./stt";
import { connectTts } from "./tts";
import type { TtsConnection } from "./tts";
import { runVoiceAgentTurn, runVoiceAgentGreeting, resolveAgentConfig, buildPreviewAgentConfig } from "./agent";
import type { TestCallTokenPayload } from "./test-call-tokens";

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
  let sttProviderOverride: "deepgram" | "sarvam" | undefined;
  let languageOverride: string | undefined;
  let ttsVoiceIdOverride: string | undefined;
  let llmModelOverride: string | undefined;
  let enabledToolsOverride: import("./agent-frame").AvailableToolName[] | undefined;

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
   * — barge-in, tool calls (still real — merchants should see their configured tools
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
            void input; // ignore — socket may be closing
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
          ? await buildPreviewAgentConfig(payload.templateKey, payload.configOverride)
          : await resolveAgentConfig({ orgId: payload.orgId, templateKey: payload.templateKey });

        persona = agentConfig.systemPrompt;
        enabledToolsOverride = agentConfig.enabledTools;
        llmModelOverride = agentConfig.llmModel;
        ttsVoiceIdOverride = agentConfig.voiceId;
        ttsProviderOverride = agentConfig.ttsProvider;
        llmProviderOverride = agentConfig.llmProvider;
        sttProviderOverride = agentConfig.sttProvider;
        languageOverride = agentConfig.language;

        maxDurationTimer = setTimeout(() => {
          console.warn(`[test-call] org ${payload.orgId} test call hit its max duration — ending`);
          endCall(ws, "max-duration");
        }, MAX_TEST_CALL_DURATION_MS);

        connectSttForCall(ws);
        history = [];
        ws.send(JSON.stringify({ type: "ready" }));
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
