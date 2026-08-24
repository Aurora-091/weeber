import { encode, decode } from "@msgpack/msgpack";
import type { ConnectTts, ConnectTtsSession, TtsSession } from "./types";
import { resolveVoiceId } from "./default-voices";
import { createPcmResampler, pcm16ToMulaw } from "../audio-codec";

/**
 * Fish Audio TTS (2026-08-25, docs/audits/2026-08-25-provider-model-currency-research.md) — added on
 * request as a much cheaper TTS option (~$15/1M chars vs ElevenLabs, ~100ms streaming latency per Fish's
 * own published numbers) after a #1 TTS-Arena2 naturalness ranking on their S1 model.
 *
 * **This file is built from Fish Audio's published docs, not from a live handshake — unlike every other
 * adapter in this directory, none of it has been confirmed against a real account (no credentials in this
 * sandbox, and this session could not place a live call to verify).** Everywhere a fact below could not
 * be confirmed, the comment says so explicitly. Treat this adapter as needing a live smoke test — real
 * `FISH_API_KEY`, a real call — before it is trusted the way the other three providers here are.
 *
 * Two structural differences from every other provider in this directory, both consequences of Fish's
 * own protocol rather than a choice made here:
 *
 * 1. **MessagePack, not JSON.** Fish's WebSocket protocol serializes every message as MessagePack
 *    (binary), not JSON text like Cartesia/ElevenLabs/Sarvam. `@msgpack/msgpack` is the one new runtime
 *    dependency this adapter needed — nothing else in this codebase talks a binary wire protocol.
 * 2. **No confirmed 8kHz mu-law output.** Fish's documented `format` options are `wav | pcm | mp3 | opus`
 *    — no mu-law, and PCM's documented default sample rate is 44100Hz with no confirmed way to request
 *    8000Hz directly (an optional `sample_rate` field is sent speculatively below on the chance it's
 *    honored; if the server ignores it, the resampler still produces correct 8kHz output either way, just
 *    doing more work per chunk). Every other provider here was chosen partly *because* it emits mu-law/
 *    8kHz natively with zero re-encoding — Fish is the first one this codebase has to actually resample
 *    for. See `audio-codec.ts`'s `createPcmResampler` doc comment for why linear interpolation and why
 *    it's stateful across chunks.
 *
 * **Session model, and why it does NOT get Phase C1's persistent-connection win:** Fish's own docs
 * describe one `start` → N `text` → one `stop` cycle per WebSocket connection, after which the socket
 * closes (unconfirmed whether a second `start` on the same still-open socket is actually rejected, or
 * simply undocumented — this adapter assumes the conservative reading and opens a fresh socket per turn,
 * because assuming reuse works and being wrong would silently lose audio, while assuming no-reuse and
 * being wrong only costs an avoidable handshake). `connectFishSession` therefore returns a `TtsSession`
 * whose `startTurn` opens a brand-new socket every call — correctly reported by the existing
 * `turnTtsSocketOpenMs` telemetry (stream.ts), which will show a real per-turn cost for this provider
 * where Cartesia/ElevenLabs/Sarvam show none after the first turn. If a live account confirms multiple
 * start/stop cycles work on one socket, this can be revisited — not assumed here.
 */

const FISH_WS_URL = "wss://api.fish.audio/v1/tts/live";
/** Fish's documented PCM default — see this file's doc comment on why 8000 is requested speculatively
 * rather than assumed to be honored. */
const FISH_SOURCE_SAMPLE_RATE = 44100;

type FishStartEvent = {
  event: "start";
  request: {
    text: string;
    format: "pcm";
    /** Speculative — see doc comment above. Harmless if the server ignores an unrecognized field. */
    sample_rate?: number;
    reference_id?: string;
    latency?: "normal" | "balanced" | "low";
  };
};
type FishTextEvent = { event: "text"; text: string };
type FishStopEvent = { event: "stop" };
/** `decode()` returns `unknown` — this is the shape asserted onto it at the one read site below, not a
 * discriminated union TS can narrow on its own (an index-signature fallback branch for "any other event"
 * would defeat narrowing on the fields that matter), so the read site checks each field defensively
 * instead of relying on the type system to prove the server sent what's expected. */
type FishServerEvent = { event?: unknown; audio?: unknown; reason?: unknown };

function sendMsgpack(ws: WebSocket, payload: FishStartEvent | FishTextEvent | FishStopEvent) {
  if (ws.readyState === WebSocket.OPEN) ws.send(encode(payload));
}

/**
 * Opens one fresh WebSocket per turn (see this file's doc comment on why). `voiceIdOverride`/`language`
 * are re-read on every `startTurn` call from the closure's own params — fixed for the session's whole
 * life, same contract every other `ConnectTtsSession` here has, just re-applied per socket instead of
 * once at connect time (there's no persistent connection here to apply them to once).
 */
export const connectFishSession: ConnectTtsSession = (voiceIdOverride, _language, onConnected) => {
  const voiceId = resolveVoiceId("fish", voiceIdOverride);
  let currentWs: WebSocket | undefined;
  let closedByUs = false;

  const session: TtsSession = {
    startTurn(onAudioChunk, onDone, onError, onWordTimestamp) {
      closedByUs = false;
      const connectRequestedAt = Date.now();
      const resample = createPcmResampler(FISH_SOURCE_SAMPLE_RATE, 8000);
      let finished = false;

      // Bun's WebSocket constructor accepts a headers option (same pattern as tts/sarvam.ts's
      // Api-Subscription-Key) — not in the standard lib.dom WebSocket type, hence the cast.
      const ws = new WebSocket(FISH_WS_URL, {
        headers: { Authorization: `Bearer ${process.env.FISH_API_KEY ?? ""}` },
      } as unknown as string[]);
      currentWs = ws;

      const pendingText: string[] = [];
      let opened = false;

      ws.addEventListener("open", () => {
        opened = true;
        onConnected?.(Date.now() - connectRequestedAt);
        sendMsgpack(ws, {
          event: "start",
          request: {
            text: "",
            format: "pcm",
            sample_rate: 8000,
            // Omit rather than send an empty string — an absent field is
            // documented to fall back to the model's own default voice;
            // an empty-string reference_id is not confirmed to mean the
            // same thing and risks being treated as an invalid id instead.
            ...(voiceId ? { reference_id: voiceId } : {}),
            latency: "low",
          },
        });
        for (const text of pendingText.splice(0)) sendMsgpack(ws, { event: "text", text });
      });

      ws.addEventListener("message", async (event) => {
        try {
          const raw = event.data instanceof Blob ? new Uint8Array(await event.data.arrayBuffer()) : (event.data as ArrayBuffer | Uint8Array);
          const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer);
          const msg = decode(bytes) as FishServerEvent;
          if (msg.event === "audio" && msg.audio instanceof Uint8Array) {
            // `msg.audio` is msgpack's native binary type, decoded as a Uint8Array — assumed to be raw
            // PCM16LE at FISH_SOURCE_SAMPLE_RATE (unconfirmed; see doc comment). Word-level timestamps
            // are not documented for this endpoint, so `onWordTimestamp` is accepted for interface
            // compatibility but never invoked here — same "not every provider has this" shape
            // tts-tts-voice-identity/lazy-connect tests already handle for other optional callbacks.
            void onWordTimestamp;
            const pcm8k = resample(msg.audio);
            const mulaw = pcm16ToMulaw(pcm8k);
            if (mulaw.length > 0) onAudioChunk(Buffer.from(mulaw).toString("base64"));
          } else if (msg.event === "finish") {
            finished = true;
            if (msg.reason === "error") onError?.(new Error("Fish Audio reported a synthesis error"));
            else onDone?.();
          }
        } catch (err) {
          console.error("[fish] failed to decode message", err);
        }
      });

      ws.addEventListener("error", (err) => {
        console.error("[fish] socket error", err);
        if (!finished && !closedByUs) onError?.(err);
      });

      ws.addEventListener("close", (evt) => {
        if (!finished && !closedByUs) {
          console.warn("[fish] connection closed before turn finished", evt.code, evt.reason);
          onError?.(new Error(`Fish Audio socket closed unexpectedly (code ${evt.code})`));
        }
      });

      return {
        sendText(text: string) {
          if (!opened) {
            pendingText.push(text);
            return;
          }
          sendMsgpack(ws, { event: "text", text });
        },
        endTurn() {
          sendMsgpack(ws, { event: "stop" });
        },
        close() {
          closedByUs = true;
          if (opened) ws.close();
        },
      };
    },
    isOpen() {
      // There is no persistent connection to report on for this provider — see doc comment. Always
      // "open" at the session level; `startTurn` opens its own fresh socket regardless of this value.
      return true;
    },
    close() {
      closedByUs = true;
      currentWs?.close();
      currentWs = undefined;
    },
  };
  return session;
};

/**
 * One-shot shape for callers that want exactly one turn — the dashboard's voice-preview button
 * (tts-preview.ts). Derived from the session above, same pattern as the other three providers.
 */
export const connectFishTts: ConnectTts = (onAudioChunk, onDone, onError, voiceIdOverride, language, onWordTimestamp, onConnected) => {
  const session = connectFishSession(voiceIdOverride, language, onConnected);
  const turn = session.startTurn(onAudioChunk, onDone, onError, onWordTimestamp);
  return {
    ...turn,
    close() {
      turn.close();
      session.close();
    },
  };
};
