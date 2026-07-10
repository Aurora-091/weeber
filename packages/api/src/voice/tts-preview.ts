import { connectTts } from "./tts";
import type { TtsProvider } from "./tts";

/**
 * One-shot TTS helper for the dashboard's "preview this voice" button — not
 * part of a live call at all. Runs a single turn through the same
 * `connectTts` every real call uses (so the preview genuinely matches what
 * callers will hear), collects every mu-law 8kHz chunk instead of forwarding
 * them to a Twilio Media Stream, and wraps the result in a WAV header so any
 * browser `<audio>` element can play it directly with no client-side
 * decoding.
 */
const PREVIEW_TIMEOUT_MS = 15_000;

export async function generatePreviewAudio(
  text: string,
  provider: TtsProvider,
  voiceId: string | undefined,
): Promise<Buffer> {
  const chunks: Buffer[] = [];

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("TTS preview timed out")), PREVIEW_TIMEOUT_MS);

    const tts = connectTts(
      (base64Audio) => {
        chunks.push(Buffer.from(base64Audio, "base64"));
      },
      () => {
        clearTimeout(timeout);
        resolve();
      },
      (err) => {
        clearTimeout(timeout);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
      provider,
      voiceId,
    );

    tts.sendText(text);
    tts.endTurn();
  });

  const audioBytes = Buffer.concat(chunks);
  return wrapMulawInWavHeader(audioBytes);
}

/**
 * Every TTS provider here outputs raw 8kHz mono mu-law (G.711) with zero
 * re-encoding, so it drops straight into a Twilio Media Stream — but raw
 * mu-law has no container a browser can play back on its own. This prepends
 * a minimal WAV header declaring mu-law format (code 7), 8kHz, mono, 8
 * bits/sample, so the same bytes play directly in an `<audio>` tag.
 */
export function wrapMulawInWavHeader(mulawData: Buffer): Buffer {
  const header = Buffer.alloc(44);
  const sampleRate = 8000;
  const dataSize = mulawData.length;

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(7, 20); // format code 7 = mu-law
  header.writeUInt16LE(1, 22); // channels
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate, 28); // byte rate (1 byte/sample * sampleRate)
  header.writeUInt16LE(1, 32); // block align
  header.writeUInt16LE(8, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, mulawData]);
}
