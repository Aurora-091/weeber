/**
 * Wind-noise high-pass filter (2026-07-17, follow-up to §3b's adaptive
 * noise filter — see audio-noise-filter.ts's module doc comment). That
 * filter is built for *steady* background noise (room hiss, PSTN line
 * noise, AC hum): it tracks a slow-moving loudness floor and gates chunks
 * that are close to it. Wind is a fundamentally different noise type —
 * loud, bursty, and broadband — so a loudness-only gate can't reliably
 * tell "a gust of wind" from "loud speech": both spike RMS the same way.
 *
 * The standard, cheap DSP fix for wind specifically is a high-pass filter:
 * wind rumble (from air turbulence hitting a phone's mic) concentrates
 * energy below roughly 100-200Hz, well below where speech intelligibility
 * lives (the important content for understanding speech is ~300Hz-3.4kHz,
 * telephony's own traditional passband). Cutting content below the filter's
 * cutoff removes most of that rumble before it ever reaches the adaptive
 * noise filter or STT — and, as a side effect, makes the adaptive filter's
 * own RMS gate *more* accurate too, since a wind gust's RMS after this
 * filter is dominated only by whatever higher-frequency content survived,
 * which is far lower than actual speech.
 *
 * This is a single-pole (first-order) digital high-pass filter — the
 * simplest filter that actually attenuates by frequency rather than just
 * loudness, and cheap enough to run on every inbound audio frame of every
 * call without a real per-call cost. It is NOT a substitute for the
 * adaptive noise filter — the two are complementary and meant to run
 * together (high-pass first, then the RMS gate) when both flags are on.
 */
import { mulawToPcm16, pcm16ToMulaw } from "./audio-codec";

export type HighPassFilterOptions = {
  /** Frequencies below this are attenuated; frequencies well above it pass
   * through close to unchanged. 120Hz sits below virtually all speech
   * fundamental frequencies (adult speech typically starts around 85-
   * 180Hz) while still catching the bulk of wind-rumble energy, which is
   * concentrated well under 100Hz. */
  cutoffHz?: number;
  /** Telephony's fixed wire sample rate throughout this codebase (see
   * audio-codec.ts) — mu-law audio off Twilio/Plivo/Exotel is always 8kHz. */
  sampleRateHz?: number;
};

const DEFAULT_CUTOFF_HZ = 120;
const DEFAULT_SAMPLE_RATE_HZ = 8000;

export type HighPassFilter = {
  /** Applies the filter to one chunk of PCM16 samples, returning a new
   * same-length array. Maintains filter state (the previous input/output
   * sample) *across* calls — audio chunks are a continuous stream, not
   * independent snapshots, and a filter reset every chunk would introduce
   * an audible click at every chunk boundary. */
  apply(samples: Int16Array): Int16Array;
};

/**
 * Single-pole RC high-pass filter, discretized the standard way:
 *   RC = 1 / (2*pi*cutoffHz)
 *   dt = 1 / sampleRateHz
 *   alpha = RC / (RC + dt)
 *   y[n] = alpha * (y[n-1] + x[n] - x[n-1])
 *
 * `alpha` is close to 1 for a low cutoff relative to the sample rate (here,
 * ~0.906 for 120Hz at 8kHz) — the filter leans heavily on "whatever changed
 * since last sample" and only slowly forgets the running output, which is
 * exactly the high-pass behavior: slow (low-frequency) drift gets damped,
 * fast (higher-frequency) changes pass through.
 */
export function createHighPassFilter(options?: HighPassFilterOptions): HighPassFilter {
  const cutoffHz = options?.cutoffHz ?? DEFAULT_CUTOFF_HZ;
  const sampleRateHz = options?.sampleRateHz ?? DEFAULT_SAMPLE_RATE_HZ;
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const dt = 1 / sampleRateHz;
  const alpha = rc / (rc + dt);

  let prevInput = 0;
  let prevOutput = 0;

  return {
    apply(samples: Int16Array): Int16Array {
      const out = new Int16Array(samples.length);
      for (let i = 0; i < samples.length; i++) {
        const x = samples[i]!;
        const y = alpha * (prevOutput + x - prevInput);
        out[i] = Math.max(-32768, Math.min(32767, Math.round(y)));
        prevInput = x;
        prevOutput = y;
      }
      return out;
    },
  };
}

/**
 * Wire-format convenience mirroring audio-noise-filter.ts's
 * applyNoiseFilterToMulaw exactly — decodes one mu-law chunk, filters,
 * re-encodes. Kept as its own decode/encode pass (not fused with the
 * adaptive noise filter's) for isolation/testability; stream.ts's media
 * handler chains the two at the call site when both flags are on, which
 * costs two small decode/encode passes per chunk instead of one — not
 * meaningfully different at this chunk size (20ms of 8kHz mono audio).
 */
export function applyHighPassToMulaw(mulaw: Uint8Array, filter: HighPassFilter): Uint8Array {
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
 * same staged-rollout/kill-switch pattern as ADAPTIVE_NOISE_FILTER_FLAG.
 * Independent of that flag on purpose: they solve different noise types,
 * an org may want either, both, or neither. */
export const WIND_NOISE_FILTER_FLAG = "wind-noise-filter";
