/**
 * Per-provider WebSocket wire-format adapter for live call audio. This is
 * the seam that lets stream.ts's actual conversation logic (STT -> agent ->
 * TTS, barge-in, latency tracking, etc.) stay provider-agnostic — it only
 * ever produces/consumes mu-law 8kHz audio, same as it always has for
 * Twilio. Each adapter's job is translating that one shared internal shape
 * to/from whatever a given provider's wire protocol actually is.
 *
 * Protocol details below were pulled from each provider's own current docs
 * (2026-07-12), not assumed — see docs/india-telephony.md's status update
 * for citations. In particular: Exotel's AgentStream (VoiceBot Applet) is a
 * real bidirectional WebSocket now, structurally close to Twilio/Plivo, NOT
 * the SIP-trunk-only path this doc originally assumed — that assumption is
 * now corrected.
 *
 * | Provider | Audio format          | start/media/stop field naming        | clear (barge-in) |
 * |----------|------------------------|---------------------------------------|-------------------|
 * | Twilio   | mu-law 8kHz            | streamSid / callSid                   | {event:"clear", streamSid} |
 * | Plivo    | mu-law 8kHz            | streamId / callId                     | {event:"clearAudio", streamId} |
 * | Exotel   | linear16 PCM 8kHz      | stream_sid (snake_case), nested       | {event:"clear", stream_sid} |
 *
 * Only Exotel needs actual transcoding (PCM16 <-> mu-law, see audio-codec.ts)
 * — Twilio and Plivo already speak the same mu-law wire format our STT/TTS
 * pipeline is built around.
 */
import { mulawToPcm16, pcm16ToMulaw } from "./audio-codec";

/** One 20ms frame of 8kHz/16-bit mono PCM = 160 samples * 2 bytes. Exotel's
 * VoiceBot applet requires outbound media packets to be a multiple of this. */
const EXOTEL_FRAME_BYTES = 320;

/** Right-pads `pcm` with PCM silence (zero bytes) up to the next multiple of
 * `frameBytes`. A no-op when already frame-aligned. */
function padToFrameMultiple(pcm: Uint8Array, frameBytes: number): Uint8Array {
  const remainder = pcm.length % frameBytes;
  if (remainder === 0) return pcm;
  const padded = new Uint8Array(pcm.length + (frameBytes - remainder));
  padded.set(pcm, 0); // trailing bytes stay zero-initialized = silence
  return padded;
}

export type TelephonyProvider = "twilio" | "plivo" | "exotel";

export type NormalizedInboundEvent =
  | { type: "start"; streamId: string; callId: string; from?: string; to?: string }
  | { type: "media"; mulawBase64: string }
  | { type: "stop" }
  | { type: "unknown" };

export interface TelephonyTransport {
  parseInbound(raw: string): NormalizedInboundEvent;
  /** Build the outbound frame that plays `mulawBase64` audio back to the caller. */
  buildOutboundMedia(streamId: string, mulawBase64: string): string;
  /** Build the outbound frame that flushes any queued/playing audio — used for barge-in. */
  buildClear(streamId: string): string;
}

const twilioTransport: TelephonyTransport = {
  parseInbound(raw) {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return { type: "unknown" };
    }
    if (msg.event === "start") return { type: "start", streamId: msg.start.streamSid, callId: msg.start.callSid };
    if (msg.event === "media") return { type: "media", mulawBase64: msg.media.payload };
    if (msg.event === "stop") return { type: "stop" };
    return { type: "unknown" };
  },
  buildOutboundMedia(streamId, mulawBase64) {
    return JSON.stringify({ event: "media", streamSid: streamId, media: { payload: mulawBase64 } });
  },
  buildClear(streamId) {
    return JSON.stringify({ event: "clear", streamSid: streamId });
  },
};

const plivoTransport: TelephonyTransport = {
  parseInbound(raw) {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return { type: "unknown" };
    }
    if (msg.event === "start") return { type: "start", streamId: msg.start.streamId, callId: msg.start.callId };
    if (msg.event === "media") return { type: "media", mulawBase64: msg.media.payload };
    if (msg.event === "stop" || msg.event === "clearedAudio") return { type: "stop" };
    return { type: "unknown" };
  },
  buildOutboundMedia(_streamId, mulawBase64) {
    // Plivo's playAudio frame carries no stream id — it applies to whichever
    // stream this socket belongs to (one stream per socket).
    return JSON.stringify({
      event: "playAudio",
      media: { contentType: "audio/x-mulaw", sampleRate: 8000, payload: mulawBase64 },
    });
  },
  buildClear(streamId) {
    return JSON.stringify({ event: "clearAudio", streamId });
  },
};

const exotelTransport: TelephonyTransport = {
  parseInbound(raw) {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return { type: "unknown" };
    }
    if (msg.event === "start") {
      // Unlike Twilio/Plivo, Exotel has no separate inbound webhook step
      // that pre-creates our `calls` row before the WS opens (see
      // voice/routes.ts's doc comment on why) — from/to ride along on the
      // start event itself so stream.ts can lazily insert the row here
      // instead of assuming one always already exists.
      return {
        type: "start",
        streamId: msg.start.stream_sid,
        callId: msg.start.call_sid,
        from: msg.start.from,
        to: msg.start.to,
      };
    }
    if (msg.event === "media") {
      // Exotel sends raw PCM16 — transcode to mu-law so downstream (STT)
      // never has to know this call came from a non-mulaw provider.
      const pcm16 = Buffer.from(msg.media.payload, "base64");
      const mulaw = pcm16ToMulaw(pcm16);
      return { type: "media", mulawBase64: Buffer.from(mulaw).toString("base64") };
    }
    if (msg.event === "stop") return { type: "stop" };
    return { type: "unknown" };
  },
  buildOutboundMedia(streamId, mulawBase64) {
    // Reverse transcode: our TTS pipeline only ever produces mu-law —
    // convert back to the linear16 PCM Exotel expects on the way out.
    const mulaw = Buffer.from(mulawBase64, "base64");
    const pcm16 = mulawToPcm16(mulaw);

    // Exotel's VoiceBot applet requires every outbound media packet to be a
    // whole number of 20ms 8kHz/16-bit frames — i.e. a multiple of 320 bytes
    // (160 samples). Our upstream TTS chunks are byte-streamed and NOT frame
    // aligned, so a raw chunk whose length isn't a 320-byte multiple gets
    // rejected/misaligned by Exotel. Pad the tail up to the next frame
    // boundary with PCM silence (0x0000) so every packet is always valid.
    // (A stateful re-framer that carries the <320-byte remainder into the
    // next packet would avoid the sub-20ms silence gap entirely, but needs
    // per-stream state the shared transport singleton can't safely hold;
    // deferred until a live Exotel call validates this path — see
    // docs/india-telephony.md.)
    const framed = padToFrameMultiple(pcm16, EXOTEL_FRAME_BYTES);

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

export function getTelephonyTransport(provider: TelephonyProvider): TelephonyTransport {
  if (provider === "plivo") return plivoTransport;
  if (provider === "exotel") return exotelTransport;
  return twilioTransport;
}
