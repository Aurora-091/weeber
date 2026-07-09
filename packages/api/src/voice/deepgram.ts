/**
 * Thin wrapper around Deepgram's live streaming STT WebSocket, tuned for
 * 8kHz mu-law audio coming straight off a Twilio Media Stream (no re-encoding
 * needed — Deepgram accepts mulaw natively).
 *
 * Includes a bounded auto-reconnect: if the socket drops unexpectedly mid-call
 * (network blip, Deepgram-side hiccup), we transparently reconnect once or
 * twice rather than silently losing transcription for the rest of the call.
 * While reconnecting, incoming audio is buffered (bounded) and flushed the
 * moment the new socket opens, so a brief drop doesn't silently swallow
 * whatever the caller said during the gap — this was the root cause of a
 * mid-call "went blank" incident during testing.
 */
export type DeepgramTranscriptHandler = (params: {
  text: string;
  isFinal: boolean;
  speechFinal: boolean;
}) => void;

export type DeepgramStats = {
  reconnectCount: number;
  totalGapMs: number;
};

const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_BASE_DELAY_MS = 500;
// ~2s of audio at 8kHz mu-law (1 byte/sample) — enough to cover the typical
// reconnect window without buffering unbounded memory if Deepgram is down.
const MAX_BUFFERED_BYTES = 16_000;

export function connectDeepgram(
  onTranscript: DeepgramTranscriptHandler,
  onFatalError?: (err: unknown) => void,
  onStatsUpdate?: (stats: DeepgramStats) => void,
  /** Fires once, on the very first successful connect (not on reconnects) — the
   * "STT connect" leg of the per-call latency breakdown, see database/schema.ts's callLatency. */
  onConnected?: (ms: number) => void,
) {
  let ws: WebSocket;
  let closedIntentionally = false;
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let isOpen = false;
  let disconnectedAt: number | null = null;
  let hasReportedInitialConnect = false;
  const connectRequestedAt = Date.now();

  const stats: DeepgramStats = { reconnectCount: 0, totalGapMs: 0 };
  const audioBuffer: Uint8Array[] = [];
  let bufferedBytes = 0;

  function bufferAudio(chunk: Uint8Array) {
    audioBuffer.push(chunk);
    bufferedBytes += chunk.byteLength;
    while (bufferedBytes > MAX_BUFFERED_BYTES && audioBuffer.length > 0) {
      const dropped = audioBuffer.shift()!;
      bufferedBytes -= dropped.byteLength;
    }
  }

  function flushBufferedAudio() {
    if (audioBuffer.length === 0) return;
    for (const chunk of audioBuffer) {
      if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
    }
    audioBuffer.length = 0;
    bufferedBytes = 0;
  }

  const params = new URLSearchParams({
    model: "nova-3",
    encoding: "mulaw",
    sample_rate: "8000",
    channels: "1",
    punctuate: "true",
    smart_format: "true",
    interim_results: "true",
    endpointing: "300",
    vad_events: "true",
  });

  function open() {
    ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params.toString()}`, [
      "token",
      process.env.DEEPGRAM_API_KEY ?? "",
    ]);

    ws.addEventListener("open", () => {
      isOpen = true;
      reconnectAttempts = 0;
      if (!hasReportedInitialConnect) {
        hasReportedInitialConnect = true;
        onConnected?.(Date.now() - connectRequestedAt);
      }
      if (disconnectedAt) {
        const gap = Date.now() - disconnectedAt;
        stats.totalGapMs += gap;
        disconnectedAt = null;
        console.warn(`[deepgram] reconnected after ${gap}ms gap — flushing ${audioBuffer.length} buffered chunks`);
        onStatsUpdate?.({ ...stats });
      }
      flushBufferedAudio();
    });

    ws.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        if (msg.type !== "Results") return;
        const alt = msg.channel?.alternatives?.[0];
        const text: string = alt?.transcript ?? "";
        if (!text) return;
        onTranscript({
          text,
          isFinal: Boolean(msg.is_final),
          speechFinal: Boolean(msg.speech_final),
        });
      } catch (err) {
        console.error("[deepgram] failed to parse message", err);
      }
    });

    ws.addEventListener("error", (err) => console.error("[deepgram] socket error", err));

    ws.addEventListener("close", () => {
      isOpen = false;
      if (closedIntentionally) return;
      disconnectedAt = Date.now();
      if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.error("[deepgram] gave up reconnecting after", reconnectAttempts, "attempts");
        onFatalError?.(new Error("Deepgram connection lost and reconnect attempts exhausted"));
        return;
      }
      reconnectAttempts += 1;
      stats.reconnectCount += 1;
      onStatsUpdate?.({ ...stats });
      const delay = RECONNECT_BASE_DELAY_MS * 2 ** (reconnectAttempts - 1);
      console.warn(`[deepgram] connection closed unexpectedly — reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
      reconnectTimer = setTimeout(open, delay);
    });
  }

  open();

  return {
    sendAudio(chunk: Uint8Array) {
      if (isOpen && ws.readyState === WebSocket.OPEN) {
        ws.send(chunk);
      } else {
        // Reconnecting — buffer instead of silently dropping the caller's audio.
        bufferAudio(chunk);
      }
    },
    getStats(): DeepgramStats {
      return { ...stats };
    },
    close() {
      closedIntentionally = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "CloseStream" }));
      }
      ws.close();
    },
  };
}
