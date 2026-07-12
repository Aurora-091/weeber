/**
 * Browser-side port of packages/api/src/voice/audio-codec.ts's mu-law <->
 * PCM16 math (G.711), used by useVoiceTestCall.ts to speak the exact wire
 * format connectStt/connectTts already expect (8kHz mu-law) — see
 * test-call-stream.ts's header comment for the full wire protocol.
 *
 * Deliberately a plain copy, not a shared import: the API package uses
 * Node's `Buffer` in a couple of helpers there, which doesn't exist in the
 * browser, and this file only needs the two pure, dependency-free functions
 * anyway (mulawToPcm16 / pcm16ToMulaw) — copying keeps this package free of
 * any accidental Node-only import creeping in through a shared module.
 */

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

/** Decode a buffer of 8-bit mu-law samples into 16-bit signed PCM samples. */
export function mulawToPcm16(mulaw: Uint8Array): Int16Array {
  const out = new Int16Array(mulaw.length);
  for (let i = 0; i < mulaw.length; i++) {
    out[i] = MULAW_DECODE_TABLE[mulaw[i]!]!;
  }
  return out;
}

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

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

/** Encode 16-bit signed PCM samples into 8-bit mu-law bytes. */
export function pcm16ToMulaw(pcm16: Int16Array): Uint8Array {
  const out = new Uint8Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) {
    out[i] = encodeMulawSample(pcm16[i]!);
  }
  return out;
}

/** base64 <-> Uint8Array, browser-safe (no Buffer/Node APIs). */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/**
 * Linear resample of 16-bit PCM samples from one sample rate to another —
 * used both directions: mic capture is always 44.1/48kHz (whatever
 * AudioContext gives you), the wire format is fixed 8kHz; agent audio comes
 * back at 8kHz and needs to go out at the AudioContext's playback rate.
 * Good enough for voice-band speech, not audiophile quality — this is a
 * test sandbox, not the production call path (which never resamples;
 * Twilio/Plivo/Exotel all speak 8kHz natively).
 */
export function resamplePcm16(input: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outLength = Math.floor(input.length / ratio);
  const out = new Int16Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcIndex = i * ratio;
    const i0 = Math.floor(srcIndex);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = srcIndex - i0;
    out[i] = Math.round(input[i0]! * (1 - frac) + input[i1]! * frac);
  }
  return out;
}
