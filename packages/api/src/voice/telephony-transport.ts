/**
 * Per-provider WebSocket wire-format adapter for live call audio. This is
 * the seam that lets stream.ts's actual conversation logic (STT -> agent ->
 * TTS, barge-in, latency tracking, etc.) stay provider-agnostic — it only
 * ever produces/consumes mu-law 8kHz audio, same as it always has for
 * Twilio. Each adapter's job is translating that one shared internal shape
 * to/from whatever a given provider's wire protocol actually is.
 *
 * Protocol details below were pulled from each provider's own current docs
 * (2026-07-12, re-checked 2026-09-05) — see docs/india-telephony.md's status
 * update for citations. In particular: Exotel's AgentStream (VoiceBot Applet)
 * is a real bidirectional WebSocket now, structurally close to Twilio/Plivo,
 * NOT the SIP-trunk-only path this doc originally assumed.
 *
 * | Provider | Audio format          | start/media/stop field naming        | clear (barge-in) | playback clock |
 * |----------|------------------------|---------------------------------------|-------------------|----------------|
 * | Twilio   | mu-law 8kHz            | streamSid / callSid                   | {event:"clear", streamSid} | mark |
 * | Plivo    | mu-law 8kHz            | streamId / callId                     | {event:"clearAudio", streamId} | checkpoint → playedStream |
 * | Exotel   | mu-law 8kHz default; L16 opt-in | stream_sid (snake_case)     | {event:"clear", stream_sid} | none |
 *
 * `getTelephonyTransport` returns a **fresh** adapter per call so Exotel can
 * pin the codec from that call's `start` event without racing other calls.
 */

import { mulawToPcm16, pcm16ToMulaw } from "./audio-codec";

/** One 20ms frame of 8kHz/16-bit mono PCM = 160 samples * 2 bytes. */
const EXOTEL_PCM16_FRAME_BYTES = 320;
/** One 20ms frame of 8kHz mu-law = 160 bytes. */
const EXOTEL_MULAW_FRAME_BYTES = 160;

function padToFrameMultiple(bytes: Uint8Array, frameBytes: number): Uint8Array {
  const remainder = bytes.length % frameBytes;
  if (remainder === 0) return bytes;
  const padded = new Uint8Array(bytes.length + (frameBytes - remainder));
  padded.set(bytes, 0);
  return padded;
}

/**
 * Map a provider `encoding` / `contentType` / `MediaFormat` string to the
 * codec we should assume on the wire. Default is mu-law: Twilio and Plivo
 * are always μ-law, and Exotel's Voicebot applet defaults to
 * `audio/x-mulaw;rate=8000` (ADR-126). Linear PCM is opt-in (`L16`,
 * `linear16`, `pcm_s16`).
 */
export function resolveTelephonyCodec(encoding?: string | null): "mulaw" | "pcm16" {
  if (!encoding) return "mulaw";
  const e = encoding.toLowerCase();
  if (e.includes("l16") || e.includes("linear") || e.includes("pcm_s16") || e.includes("pcm16")) {
    return "pcm16";
  }
  return "mulaw";
}

function encodingFromStart(start: Record<string, unknown> | undefined): string | undefined {
  if (!start) return undefined;
  const direct =
    start.mediaFormat ?? start.media_format ?? start.MediaFormat ?? start.contentType ?? start.content_type;
  if (typeof direct === "string") return direct;
  if (direct && typeof direct === "object") {
    const obj = direct as Record<string, unknown>;
    if (typeof obj.encoding === "string") return obj.encoding;
    if (typeof obj.contentType === "string") return obj.contentType;
  }
  if (typeof start.encoding === "string") return start.encoding;
  return undefined;
}

export type TelephonyProvider = "twilio" | "plivo" | "exotel";

export type NormalizedInboundEvent =
  | { type: "start"; streamId: string; callId: string; from?: string; to?: string }
  | { type: "media"; mulawBase64: string }
  | { type: "stop" }
  | { type: "mark"; name: string }
  | { type: "cleared" }
  | { type: "unknown" };

export interface TelephonyTransport {
  parseInbound(raw: string): NormalizedInboundEvent;
  /** Build the outbound frame that plays `mulawBase64` audio back to the caller. */
  buildOutboundMedia(streamId: string, mulawBase64: string): string;
  /** Build the outbound frame that flushes any queued/playing audio — used for barge-in. */
  buildClear(streamId: string): string;
  /**
   * Playback-completion marker (Twilio `mark`, Plivo `checkpoint`). Undefined
   * when the provider has no such event (Exotel). stream.ts falls back to
   * `estimateRemainingPlaybackMs` when this is missing or the ack never arrives.
   */
  buildMark?(streamId: string, name: string): string;
}

function createTwilioTransport(): TelephonyTransport {
  return {
    parseInbound(raw) {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return { type: "unknown" };
      }
      if (msg.event === "start") {
        const start = (msg.start ?? {}) as Record<string, unknown>;
        const custom = (start.customParameters ?? {}) as Record<string, unknown>;
        return {
          type: "start",
          streamId: String(start.streamSid ?? ""),
          callId: String(start.callSid ?? ""),
          from: custom.from ? String(custom.from) : undefined,
          to: custom.to ? String(custom.to) : undefined,
        };
      }
      if (msg.event === "media") {
        const media = (msg.media ?? {}) as Record<string, unknown>;
        return { type: "media", mulawBase64: String(media.payload ?? "") };
      }
      if (msg.event === "stop") return { type: "stop" };
      if (msg.event === "mark") {
        const mark = (msg.mark ?? {}) as Record<string, unknown>;
        return { type: "mark", name: String(mark.name ?? "") };
      }
      return { type: "unknown" };
    },
    buildOutboundMedia(streamId, mulawBase64) {
      return JSON.stringify({ event: "media", streamSid: streamId, media: { payload: mulawBase64 } });
    },
    buildClear(streamId) {
      return JSON.stringify({ event: "clear", streamSid: streamId });
    },
    buildMark(streamId, name) {
      return JSON.stringify({ event: "mark", streamSid: streamId, mark: { name } });
    },
  };
}

function createPlivoTransport(): TelephonyTransport {
  return {
    parseInbound(raw) {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return { type: "unknown" };
      }
      if (msg.event === "start") {
        const start = (msg.start ?? {}) as Record<string, unknown>;
        return { type: "start", streamId: String(start.streamId ?? ""), callId: String(start.callId ?? "") };
      }
      if (msg.event === "media") {
        const media = (msg.media ?? {}) as Record<string, unknown>;
        return { type: "media", mulawBase64: String(media.payload ?? "") };
      }
      if (msg.event === "stop") return { type: "stop" };
      // Barge-in ack — MUST NOT be treated as stream end (ADR-126).
      if (msg.event === "clearedAudio") return { type: "cleared" };
      if (msg.event === "playedStream") return { type: "mark", name: String(msg.name ?? "") };
      return { type: "unknown" };
    },
    buildOutboundMedia(_streamId, mulawBase64) {
      return JSON.stringify({
        event: "playAudio",
        media: { contentType: "audio/x-mulaw", sampleRate: 8000, payload: mulawBase64 },
      });
    },
    buildClear(streamId) {
      return JSON.stringify({ event: "clearAudio", streamId });
    },
    buildMark(streamId, name) {
      return JSON.stringify({ event: "checkpoint", streamId, name });
    },
  };
}

function createExotelTransport(): TelephonyTransport {
  // Exotel Voicebot default is mu-law 8 kHz. Linear16 is opt-in via MediaFormat.
  let wire: "mulaw" | "pcm16" = "mulaw";
  return {
    parseInbound(raw) {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return { type: "unknown" };
      }
      if (msg.event === "start") {
        const start = (msg.start ?? {}) as Record<string, unknown>;
        wire = resolveTelephonyCodec(encodingFromStart(start));
        return {
          type: "start",
          streamId: String(start.stream_sid ?? ""),
          callId: String(start.call_sid ?? ""),
          from: start.from ? String(start.from) : undefined,
          to: start.to ? String(start.to) : undefined,
        };
      }
      if (msg.event === "media") {
        const media = (msg.media ?? {}) as Record<string, unknown>;
        const payload = String(media.payload ?? "");
        if (wire === "mulaw") return { type: "media", mulawBase64: payload };
        const pcm16 = Buffer.from(payload, "base64");
        const mulaw = pcm16ToMulaw(pcm16);
        return { type: "media", mulawBase64: Buffer.from(mulaw).toString("base64") };
      }
      if (msg.event === "stop") return { type: "stop" };
      return { type: "unknown" };
    },
    buildOutboundMedia(streamId, mulawBase64) {
      if (wire === "mulaw") {
        const mulaw = Buffer.from(mulawBase64, "base64");
        const framed = padToFrameMultiple(mulaw, EXOTEL_MULAW_FRAME_BYTES);
        return JSON.stringify({
          event: "media",
          stream_sid: streamId,
          media: { payload: Buffer.from(framed).toString("base64") },
        });
      }
      const mulaw = Buffer.from(mulawBase64, "base64");
      const pcm16 = mulawToPcm16(mulaw);
      const framed = padToFrameMultiple(pcm16, EXOTEL_PCM16_FRAME_BYTES);
      return JSON.stringify({
        event: "media",
        stream_sid: streamId,
        media: { payload: Buffer.from(framed).toString("base64") },
      });
    },
    buildClear(streamId) {
      return JSON.stringify({ event: "clear", stream_sid: streamId });
    },
  };
}

export function getTelephonyTransport(provider: TelephonyProvider): TelephonyTransport {
  if (provider === "plivo") return createPlivoTransport();
  if (provider === "exotel") return createExotelTransport();
  return createTwilioTransport();
}
