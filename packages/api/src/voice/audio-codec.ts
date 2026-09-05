/**
 * Minimal G.711 μ-law <-> PCM16 conversion + WAV framing.
 *
 * Twilio Media Streams send/expect 8kHz mu-law audio. Deepgram, Cartesia,
 * and ElevenLabs all accept/emit mu-law natively (zero-conversion path).
 * Sarvam does not: its STT input only accepts wav/pcm, and while its TTS
 * output can be configured to emit mulaw directly (no conversion needed on
 * that side), the STT side needs mu-law decoded to 16-bit PCM before it's
 * sent. This file is the one place that logic lives, so any future
 * non-mulaw-native provider can reuse it instead of re-deriving the G.711
 * table.
 */

// Standard G.711 mu-law decode table (256 entries -> 16-bit signed PCM).
// Derived from the ITU-T G.711 reference algorithm, not looked up from a
// vendor SDK — safe to keep dependency-free.
const MULAW_DECODE_TABLE = buildMulawDecodeTable();

function buildMulawDecodeTable(): Int16Array {
  const table = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    let muVal = ~i & 0xff;
    const sign = muVal & 0x80;
    const exponent = (muVal >> 4) & 0x07;
    const mantissa = muVal & 0x0f;
    let sample = ((mantissa << 3) + 0x84) << exponent;
    sample -= 0x84;
    table[i] = sign ? -sample : sample;
  }
  return table;
}

/** Decode a buffer of 8-bit mu-law samples into 16-bit signed PCM (little-endian bytes). */
export function mulawToPcm16(mulaw: Uint8Array): Uint8Array {
  const out = new Uint8Array(mulaw.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < mulaw.length; i++) {
    view.setInt16(i * 2, MULAW_DECODE_TABLE[mulaw[i]]!, true);
  }
  return out;
}

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

/** Encode one 16-bit signed PCM sample into an 8-bit mu-law byte — standard
 * ITU-T G.711 encode algorithm (the inverse of MULAW_DECODE_TABLE above). */
function encodeMulawSample(sampleIn: number): number {
  let sample = sampleIn;
  const sign = sample < 0 ? 0x80 : 0;
  if (sign) sample = -sample;
  if (sample > MULAW_CLIP) sample = MULAW_CLIP;
  sample += MULAW_BIAS;

  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  const muByte = ~(sign | (exponent << 4) | mantissa) & 0xff;
  return muByte;
}

/** Encode 16-bit signed PCM (little-endian bytes) into 8-bit mu-law — the
 * direction Exotel's raw-PCM streams need (Exotel sends/expects linear16,
 * not mu-law, unlike Twilio/Plivo — see voice/telephony-transport.ts). */
export function pcm16ToMulaw(pcm16: Uint8Array): Uint8Array {
  const sampleCount = Math.floor(pcm16.length / 2);
  const view = new DataView(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);
  const out = new Uint8Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    out[i] = encodeMulawSample(view.getInt16(i * 2, true));
  }
  return out;
}

/** Convenience: Twilio mu-law chunk -> base64 raw PCM16LE, ready for JSON APIs
 * whose connection-level params declare the audio codec. Sarvam STT needs this
 * shape — per-frame WAV headers make a 20ms Twilio stream silently deaf. */
export function mulawChunkToPcm16Base64(mulaw: Uint8Array): string {
  return Buffer.from(mulawToPcm16(mulaw)).toString("base64");
}
