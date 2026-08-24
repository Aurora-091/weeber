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

/** Wrap raw PCM16LE bytes in a minimal 44-byte WAV header (mono). Some
 * providers (Sarvam STT) require a WAV container rather than bare PCM. */
export function pcm16ToWav(pcm16: Uint8Array, sampleRate: number): Uint8Array {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const dataSize = pcm16.length;

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate (16-bit mono)
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  const wav = new Uint8Array(44 + dataSize);
  wav.set(new Uint8Array(header), 0);
  wav.set(pcm16, 44);
  return wav;
}

function writeAscii(view: DataView, offset: number, text: string) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

/** Convenience: Twilio mu-law chunk -> base64 raw PCM16LE, ready for JSON APIs
 * whose connection-level params declare the audio codec. Sarvam STT needs this
 * shape — per-frame WAV headers make a 20ms Twilio stream silently deaf. */
export function mulawChunkToPcm16Base64(mulaw: Uint8Array): string {
  return Buffer.from(mulawToPcm16(mulaw)).toString("base64");
}

/** Convenience: Twilio mu-law chunk -> base64 WAV, ready to drop into a JSON message. */
export function mulawChunkToWavBase64(mulaw: Uint8Array, sampleRate = 8000): string {
  const pcm16 = mulawToPcm16(mulaw);
  const wav = pcm16ToWav(pcm16, sampleRate);
  return Buffer.from(wav).toString("base64");
}

/**
 * Fish Audio TTS (2026-08-25, docs/audits/2026-08-25-provider-model-currency-research.md): the first
 * provider added to this file whose native output isn't already 8kHz — its documented WebSocket `pcm`
 * format defaults to 44100Hz, with no confirmed way to request 8000Hz directly (unverified against a live
 * account; see tts/fish.ts's doc comment). Every other provider here (Cartesia/ElevenLabs/Sarvam) was
 * chosen partly *because* it emits mulaw/8kHz natively — this is the one place in the codebase that has to
 * do real sample-rate conversion instead of just re-encoding bit depth/companding at a fixed rate.
 *
 * Linear interpolation, not a windowed-sinc/polyphase filter — the standard low-latency tradeoff for
 * real-time streaming resampling (a proper sinc filter needs future samples, i.e. added latency, to do
 * its job; linear interpolation needs only the previous sample). Audibly worse than a real DSP resampler
 * on a static WAV file, and not this codebase's concern here: it's downsampling speech, at a bounded
 * frame size, in a pipeline whose next hop is 8kHz mu-law telephony audio, which is already a lossy,
 * narrow-band format — the resampler's own artifacts are not the binding constraint on call audio quality.
 *
 * Kept as a **stateful factory**, not a one-shot function, because TTS audio arrives in a stream of
 * chunks, not one buffer — resampling each chunk independently (restarting the fractional read position
 * at 0 every time) would introduce an audible click/discontinuity at every chunk boundary. The returned
 * closure carries the fractional position and the last sample of the previous chunk across calls, so the
 * output is continuous across chunk boundaries exactly as if the whole stream had been resampled at once.
 */
export function createPcmResampler(inputSampleRate: number, outputSampleRate: number) {
  const ratio = inputSampleRate / outputSampleRate;
  /** Fractional read position into the virtual continuous input stream, relative to the start of the
   * NEXT chunk this closure will receive — i.e. carried-over sub-sample phase, always in [0, 1). */
  let phase = 0;
  /** The last sample of the previous chunk, needed to interpolate across the boundary into the first
   * new sample of the next chunk. `null` only before the first chunk has ever been processed. */
  let previousLastSample: number | null = null;

  /** Resample one chunk of 16-bit signed PCM (little-endian bytes). Call repeatedly, in order, on
   * consecutive chunks of the same stream — do not call concurrently on two different streams sharing
   * one resampler instance (create one instance per TTS turn/session, same lifetime as the audio it's
   * resampling). */
  return function resampleChunk(pcm16: Uint8Array): Uint8Array {
    const sampleCount = Math.floor(pcm16.length / 2);
    if (sampleCount === 0) return new Uint8Array(0);
    const view = new DataView(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);
    // `i` reaches -1 only when `phase` carried a negative leftover from the previous chunk (interpolating
    // across the boundary) — `previousLastSample` covers it. `i` reaching `sampleCount` happens only for
    // the +1 lookahead on the very last in-range position of this chunk; clamping to the last real sample
    // is a negligible inaccuracy on that one fractional output sample, corrected for continuity by the
    // real `previousLastSample` read the next chunk's own boundary interpolation uses.
    const readSample = (i: number): number => {
      if (i < 0) return previousLastSample ?? view.getInt16(0, true);
      if (i >= sampleCount) return view.getInt16((sampleCount - 1) * 2, true);
      return view.getInt16(i * 2, true);
    };

    const outSamples: number[] = [];
    // `phase` starts as a position relative to index 0 of THIS chunk (possibly negative, reaching back
    // into the previous chunk's last sample via readSample(-1) above) and advances by `ratio` input-
    // samples per output sample as long as it's still inside this chunk; the leftover (relative to the
    // next chunk) is carried forward as the new `phase`.
    let pos = phase;
    while (pos < sampleCount) {
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      const s0 = readSample(i0);
      const s1 = readSample(i0 + 1);
      const interpolated = s0 + (s1 - s0) * frac;
      outSamples.push(Math.max(-32768, Math.min(32767, Math.round(interpolated))));
      pos += ratio;
    }
    phase = pos - sampleCount;
    previousLastSample = view.getInt16((sampleCount - 1) * 2, true);

    const out = new Uint8Array(outSamples.length * 2);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < outSamples.length; i++) outView.setInt16(i * 2, outSamples[i]!, true);
    return out;
  };
}
