import { describe, it, expect } from "bun:test";
import { createHighPassFilter, applyHighPassToMulaw } from "./wind-noise-filter";
import { mulawToPcm16, pcm16ToMulaw } from "./audio-codec";

const SAMPLE_RATE = 8000;

/** A pure sine tone at `freqHz`, `durationMs` long, at 8kHz — the standard
 * way to probe a filter's frequency response without needing an FFT: run
 * a single known frequency through it and measure how much energy survives. */
function sineTone(freqHz: number, durationMs: number, amplitude = 8000): Int16Array {
  const sampleCount = Math.round((SAMPLE_RATE * durationMs) / 1000);
  const out = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    out[i] = Math.round(amplitude * Math.sin((2 * Math.PI * freqHz * i) / SAMPLE_RATE));
  }
  return out;
}

function rms(samples: Int16Array): number {
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) sumSquares += samples[i]! * samples[i]!;
  return Math.sqrt(sumSquares / samples.length);
}

/** Int16Array -> the little-endian byte buffer pcm16ToMulaw expects. */
function int16ToPcmBytes(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i]!, true);
  return out;
}

/** The reverse — mulawToPcm16's byte buffer back into an Int16Array. */
function pcmBytesToInt16(bytes: Uint8Array): Int16Array {
  const sampleCount = Math.floor(bytes.length / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}

describe("createHighPassFilter — wind-rumble attenuation", () => {
  it("heavily attenuates a low-frequency (wind-rumble-like) tone well under the cutoff", () => {
    const filter = createHighPassFilter({ cutoffHz: 120 });
    const tone = sineTone(30, 500); // 30Hz — deep wind rumble, far below the 120Hz cutoff
    const filtered = filter.apply(tone);
    const attenuationRatio = rms(filtered) / rms(tone);
    // A single-pole filter this far below cutoff should knock out the
    // large majority of the energy — not perfect (that needs a steeper
    // multi-pole filter), but a clear, real reduction.
    expect(attenuationRatio).toBeLessThan(0.3);
  });

  it("passes a mid-range speech-band tone through largely unchanged", () => {
    const filter = createHighPassFilter({ cutoffHz: 120 });
    const tone = sineTone(800, 500); // 800Hz — solidly inside the speech band
    const filtered = filter.apply(tone);
    const passRatio = rms(filtered) / rms(tone);
    expect(passRatio).toBeGreaterThan(0.9);
  });

  it("attenuates low frequencies much more than it attenuates speech-band frequencies (the actual point of the filter)", () => {
    const filter = createHighPassFilter({ cutoffHz: 120 });
    const lowTone = sineTone(40, 500);
    const speechTone = sineTone(800, 500);
    const lowRatio = rms(filter.apply(lowTone)) / rms(lowTone);
    // Fresh filter instance — state shouldn't leak between unrelated signals
    // in a real call either, but this test only cares about each ratio.
    const filter2 = createHighPassFilter({ cutoffHz: 120 });
    const speechRatio = rms(filter2.apply(speechTone)) / rms(speechTone);
    expect(lowRatio).toBeLessThan(speechRatio * 0.5);
  });

  it("maintains filter state across multiple apply() calls (no click/discontinuity at chunk boundaries)", () => {
    const filter = createHighPassFilter({ cutoffHz: 120 });
    const wholeTone = sineTone(30, 200);
    const filteredWhole = filter.apply(wholeTone);

    const filter2 = createHighPassFilter({ cutoffHz: 120 });
    const half = Math.floor(wholeTone.length / 2);
    const firstHalf = filter2.apply(wholeTone.slice(0, half));
    const secondHalf = filter2.apply(wholeTone.slice(half));
    const filteredInTwoChunks = new Int16Array([...firstHalf, ...secondHalf]);

    // Splitting the same signal into two chunks through the same
    // (state-carrying) filter instance should produce the same output as
    // running it whole, sample for sample.
    expect(Array.from(filteredInTwoChunks)).toEqual(Array.from(filteredWhole));
  });

  it("never resizes the output — same length in as out, every call", () => {
    const filter = createHighPassFilter();
    const samples = sineTone(200, 137); // odd, non-round duration on purpose
    expect(filter.apply(samples).length).toBe(samples.length);
  });

  it("clamps output to the valid Int16 range instead of overflowing/wrapping", () => {
    const filter = createHighPassFilter({ cutoffHz: 120 });
    const extreme = new Int16Array([32767, -32768, 32767, -32768, 32767, -32768]);
    const filtered = filter.apply(extreme);
    for (const sample of filtered) {
      expect(sample).toBeGreaterThanOrEqual(-32768);
      expect(sample).toBeLessThanOrEqual(32767);
    }
  });
});

describe("applyHighPassToMulaw — wire-format integration", () => {
  it("round-trips through mu-law without changing length", () => {
    const filter = createHighPassFilter();
    const pcm = sineTone(800, 20); // 20ms chunk, matches stream.ts's real chunk size
    const mulaw = pcm16ToMulaw(int16ToPcmBytes(pcm));
    const filtered = applyHighPassToMulaw(mulaw, filter);
    expect(filtered.length).toBe(mulaw.length);
  });

  it("actually reduces a low-frequency mu-law chunk's decoded RMS relative to the unfiltered original", () => {
    const filter = createHighPassFilter({ cutoffHz: 120 });
    const pcm = sineTone(30, 20);
    const mulaw = pcm16ToMulaw(int16ToPcmBytes(pcm));
    const filteredMulaw = applyHighPassToMulaw(mulaw, filter);

    const originalSamples = pcmBytesToInt16(mulawToPcm16(mulaw));
    const filteredSamples = pcmBytesToInt16(mulawToPcm16(filteredMulaw));
    expect(rms(filteredSamples)).toBeLessThan(rms(originalSamples));
  });
});
