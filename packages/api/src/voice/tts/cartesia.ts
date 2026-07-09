import type { ConnectTts } from "./types";

/**
 * Thin wrapper around Cartesia's streaming TTS WebSocket (Sonic model),
 * configured to output mu-law 8kHz audio directly — same zero-re-encoding
 * path as ElevenLabs, so it drops straight into a Twilio Media Stream.
 *
 * Uses Cartesia's "continuation" flow: all text chunks for one agent turn
 * share a single `context_id`, sent with `continue: true` until the turn
 * ends, at which point a final empty-transcript message with
 * `continue: false` flushes and closes out that context.
 */
export const connectCartesiaTts: ConnectTts = (onAudioChunk, onDone, onError) => {
  const apiKey = process.env.CARTESIA_API_KEY ?? "";
  const cartesiaVersion = "2025-11-04";
  const url = `wss://api.cartesia.ai/tts/websocket?api_key=${encodeURIComponent(apiKey)}&cartesia_version=${cartesiaVersion}`;

  const ws = new WebSocket(url);
  const contextId = `vent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let closedIntentionally = false;
  let finished = false;
  let opened = false;
  const pendingSends: string[] = [];

  function send(payload: Record<string, unknown>) {
    const json = JSON.stringify(payload);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(json);
    } else {
      pendingSends.push(json);
    }
  }

  ws.addEventListener("open", () => {
    opened = true;
    for (const json of pendingSends.splice(0)) ws.send(json);
  });

  ws.addEventListener("message", (event) => {
    try {
      const msg = JSON.parse(event.data as string);
      if (msg.type === "chunk" && (msg.data || msg.audio)) onAudioChunk((msg.data ?? msg.audio) as string);
      if (msg.type === "done") {
        finished = true;
        onDone?.();
      }
      if (msg.type === "error") {
        console.error("[cartesia] server error", msg.error ?? msg);
        onError?.(new Error(msg.error ?? "Cartesia TTS error"));
      }
    } catch (err) {
      console.error("[cartesia] failed to parse message", err);
    }
  });

  ws.addEventListener("error", (err) => {
    console.error("[cartesia] socket error", err);
    if (!finished && !closedIntentionally) onError?.(err);
  });

  ws.addEventListener("close", (evt) => {
    if (!finished && !closedIntentionally) {
      console.warn("[cartesia] connection closed before turn finished", evt.code, evt.reason);
      onError?.(new Error(`Cartesia socket closed unexpectedly (code ${evt.code})`));
    }
  });

  return {
    sendText(text: string) {
      send({
        context_id: contextId,
        model_id: "sonic-3",
        transcript: text,
        voice: { mode: "id", id: process.env.CARTESIA_VOICE_ID },
        output_format: { container: "raw", encoding: "pcm_mulaw", sample_rate: 8000 },
        continue: true,
        add_timestamps: false,
      });
    },
    endTurn() {
      send({
        context_id: contextId,
        model_id: "sonic-3",
        transcript: "",
        voice: { mode: "id", id: process.env.CARTESIA_VOICE_ID },
        output_format: { container: "raw", encoding: "pcm_mulaw", sample_rate: 8000 },
        continue: false,
        add_timestamps: false,
      });
    },
    close() {
      closedIntentionally = true;
      if (opened) ws.close();
    },
  };
};
