/**
 * §3b: rolling-RMS adaptive noise filter — attenuates likely-background-
 * noise audio (room hiss, PSTN line noise, AC hum) before it reaches STT,
 * using a continuously-tracked noise floor rather than a fixed threshold
 * (which would need per-deployment tuning and still misfire the moment a
 * call's actual background noise level differs from whatever was tuned).
 *
 * Deliberately attenuates rather than drops/mutes chunks entirely — STT
 * providers (see stt/deepgram.ts, stt/sarvam.ts) expect a continuous audio
 * stream at a fixed sample rate; dropping frames would desync their own
 * internal timing/VAD, and hard digital silence can itself read as an odd
 * discontinuity to some providers' endpointing. Scaling toward (not all the
 * way to) zero keeps the stream continuous while making genuine noise far
 * quieter relative to actual speech.
 *
 * The floor only ever moves *toward* a chunk that itself looks like noise
 * (its own RMS is already close to the current floor) — a chunk that reads
 * as likely speech never nudges the floor, no matter how loud or how long
 * it runs. Without that asymmetry, a long, loud utterance would slowly drag
 * the floor up and start gating quieter speech that comes right after it.
 */
import { mulawToPcm16, pcm16ToMulaw } from "./audio-codec";


/** Root-mean-square energy of a chunk of 16-bit PCM samples — the standard
 * loudness measure this whole module's noise/speech distinction is built on. */
export function computeRms(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    sumSquares += s * s;
  }
  return Math.sqrt(sumSquares / samples.length);
}

export type NoiseFilterOptions = {
  /** A chunk is treated as noise (and gated) when its RMS is under
   * `noiseFloor * gateMultiplier` — i.e. how many multiples above the
   * tracked floor a chunk has to be before it's trusted as real speech. */
  gateMultiplier?: number;
  /** How much a gated chunk's samples are scaled by. Not 0 — see the
   * module doc comment on why a small residual signal (not hard silence)
   * is kept. */
  attenuationFactor?: number;
  /** EMA smoothing factor used only when a chunk is gated as noise — how
   * fast the floor moves toward that chunk's own RMS. Deliberately fast
   * (a handful of chunks) so the floor calibrates quickly at call start
   * and re-calibrates quickly after a genuine ambient-noise change. */
  attackAlpha?: number;
  /** Starting floor estimate before any audio has been seen — a modest
   * value on the 16-bit PCM scale, comparable to typical quiet-room/PSTN
   * line noise, so the first few real chunks converge fast either way
   * rather than starting from 0 (which would gate nothing) or something
   * large (which would gate everything). */
  initialFloor?: number;
  /** Hard bounds so a pathological run of input (e.g. a burst of DTMF tones
   * or a bad connection) can never drag the tracked floor to an extreme
   * that stops adapting sanely afterward. */
  minFloor?: number;
  maxFloor?: number;
};

const DEFAULTS: Required<NoiseFilterOptions> = {
  gateMultiplier: 2.0,
  attenuationFactor: 0.12,
  attackAlpha: 0.2,
  initialFloor: 40,
  minFloor: 5,
  maxFloor: 2000,
};

export type NoiseFilter = {
  /** Applies the current adaptive gate to one chunk of PCM16 samples,
   * returning a new same-length array — never drops or resizes audio. */
  apply(samples: Int16Array): Int16Array;
  /** Current noise-floor RMS estimate — exposed for tests/observability,
   * not used by callers in the live call path. */
  getNoiseFloor(): number;
};

export function createRollingNoiseFilter(options?: NoiseFilterOptions): NoiseFilter {
  const opts = { ...DEFAULTS, ...options };
  let noiseFloor = opts.initialFloor;

  return {
    apply(samples: Int16Array): Int16Array {
      const rms = computeRms(samples);
      const isLikelyNoise = rms < noiseFloor * opts.gateMultiplier;

      if (isLikelyNoise) {
        noiseFloor = noiseFloor + opts.attackAlpha * (rms - noiseFloor);
        noiseFloor = Math.min(opts.maxFloor, Math.max(opts.minFloor, noiseFloor));
      }

      if (!isLikelyNoise) return samples;

      const out = new Int16Array(samples.length);
      for (let i = 0; i < samples.length; i++) out[i] = Math.round(samples[i]! * opts.attenuationFactor);
      return out;
    },
    getNoiseFloor() {
      return noiseFloor;
    },
  };
}

/**
 * Wire-format convenience for stream.ts's media handler — decodes one
 * mu-law chunk straight off Twilio/Plivo/Exotel's wire, runs it through the
 * filter, and re-encodes back to mu-law, so the call site never has to
 * touch PCM directly. Reuses audio-codec.ts's existing mulaw<->PCM16
 * helpers exactly as they are (no new codec logic here) — manual
 * DataView reads/writes rather than casting a typed array directly over
 * the buffer, since the source Buffer's byteOffset isn't guaranteed to be
 * 2-byte aligned for an Int16Array view.
 */
export function applyNoiseFilterToMulaw(mulaw: Uint8Array, filter: NoiseFilter): Uint8Array {
  const pcmBytes = mulawToPcm16(mulaw);
  const sampleCount = Math.floor(pcmBytes.length / 2);
  const inView = new DataView(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.byteLength);
  const samples = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) samples[i] = inView.getInt16(i * 2, true);

  const filtered = filter.apply(samples);

  const outBytes = new Uint8Array(filtered.length * 2);
  const outView = new DataView(outBytes.buffer);
  for (let i = 0; i < filtered.length; i++) outView.setInt16(i * 2, filtered[i]!, true);

  return pcm16ToMulaw(outBytes);
}

/** Opt-in org/global feature flag (see org-queries.ts's getEffectiveFlags) —
 * same staged-rollout pattern as tts-cache.ts's HYBRID_AUDIO_CACHE_FLAG.
 * Off by default: this touches every inbound audio frame of every call, so
 * it gets a kill switch like every other audio-path behavior change here. */
export const ADAPTIVE_NOISE_FILTER_FLAG = "adaptive-noise-filter";

