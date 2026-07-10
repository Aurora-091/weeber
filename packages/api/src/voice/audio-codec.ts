/**
 * Minimal G.711 μ-law <-> PCM16 conversion + WAV framing.
 *
 * Twilio Media Streams send/expect 8kHz mu-law audio. Deepgram, Cartesia,
 * and ElevenLabs all accept/emit mu-law natively (zero-conversion path).
 * Sarvam does not: its STT input only accepts wav/pcm, and while its TTS
 * output can be configured to emit mulaw directly (no conversion needed on
 * that side), the STT side needs mu-law decoded to 16-bit PCM and wrapped in
 * a WAV header before it's sent. This file is the one place that logic
 * lives, so any future non-mulaw-native provider can reuse it instead of
 * re-deriving the G.711 table.
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

/** Convenience: Twilio mu-law chunk -> base64 WAV, ready to drop into a JSON message. */
export function mulawChunkToWavBase64(mulaw: Uint8Array, sampleRate = 8000): string {
  const pcm16 = mulawToPcm16(mulaw);
  const wav = pcm16ToWav(pcm16, sampleRate);
  return Buffer.from(wav).toString("base64");
}
