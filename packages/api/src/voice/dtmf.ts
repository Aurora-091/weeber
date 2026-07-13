/**
 * DTMF tone generation (Misc-2) — lets the agent navigate someone else's
 * phone tree ("press 1 for billing") by literally playing dual-tone audio
 * into the live media stream, the same channel TTS speech already goes out
 * on. This works uniformly across Twilio/Plivo/Exotel because
 * telephony-transport.ts's `buildOutboundMedia` already accepts mu-law 8kHz
 * audio and handles per-provider wire format + transcoding — DTMF tones are
 * just another audio buffer from that seam's point of view, so no
 * provider-specific DTMF API (e.g. Twilio's REST `sendDigits`) is needed and
 * this can't accidentally interrupt/replace the live TwiML/media stream the
 * way a REST call-update would.
 *
 * Standard DTMF dual-frequency table (ITU-T Q.23).
 */
import { pcm16ToMulaw } from "./audio-codec";

const SAMPLE_RATE = 8000;
const TONE_MS = 150;
const GAP_MS = 100;
/** Keep well under full-scale (32767) so the two summed sine waves never clip. */
const AMPLITUDE = 8000;

const DTMF_FREQUENCIES: Record<string, [number, number]> = {
  "1": [697, 1209],
  "2": [697, 1336],
  "3": [697, 1477],
  "4": [770, 1209],
  "5": [770, 1336],
  "6": [770, 1477],
  "7": [852, 1209],
  "8": [852, 1336],
  "9": [852, 1477],
  "0": [941, 1336],
  "*": [941, 1209],
  "#": [941, 1477],
};

/** Only digits, star, and pound are valid DTMF tones — anything else in the input is
 * silently skipped rather than throwing, so a stray character from a
 * captured/transcribed number doesn't kill the whole sequence. */
export function isValidDtmfSequence(digits: string): boolean {
  return digits.length > 0 && [...digits].every((d) => d in DTMF_FREQUENCIES);
}

function toneToPcm16(freqA: number, freqB: number, ms: number): Uint8Array {
  const sampleCount = Math.round((SAMPLE_RATE * ms) / 1000);
  const pcm = new Uint8Array(sampleCount * 2);
  const view = new DataView(pcm.buffer);
  for (let i = 0; i < sampleCount; i++) {
    const t = i / SAMPLE_RATE;
    const sample =
      AMPLITUDE * (Math.sin(2 * Math.PI * freqA * t) + Math.sin(2 * Math.PI * freqB * t)) / 2;
    view.setInt16(i * 2, Math.round(sample), true);
  }
  return pcm;
}

function silencePcm16(ms: number): Uint8Array {
  return new Uint8Array(Math.round((SAMPLE_RATE * ms) / 1000) * 2); // zero = silence
}

/**
 * Builds one mu-law 8kHz audio buffer (base64) playing every digit in
 * sequence with standard tone/gap timing — ready to hand straight to
 * `transport.buildOutboundMedia`, same as a TTS chunk.
 */
export function buildDtmfAudio(digits: string): string {
  const valid = [...digits].filter((d) => d in DTMF_FREQUENCIES);
  const chunks: Uint8Array[] = [];
  for (const digit of valid) {
    const [freqA, freqB] = DTMF_FREQUENCIES[digit]!;
    chunks.push(toneToPcm16(freqA, freqB, TONE_MS));
    chunks.push(silencePcm16(GAP_MS));
  }
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const pcm16 = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    pcm16.set(chunk, offset);
    offset += chunk.length;
  }
  const mulaw = pcm16ToMulaw(pcm16);
  return Buffer.from(mulaw).toString("base64");
}
