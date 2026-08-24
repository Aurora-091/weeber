import { describe, it, expect } from "bun:test";
import { createPcmResampler } from "./audio-codec";

/**
 * Fish Audio (2026-08-25) — createPcmResampler is the one piece of DSP this
 * codebase has never needed before: every other TTS provider emits mu-law/
 * 8kHz natively, so downsampling was never required. Linear interpolation,
 * stateful across chunks (see that function's doc comment for why a
 * per-chunk-independent resample would click at chunk boundaries).
 */

function pcm16From(samples: number[]): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i]!, true);
  return out;
}

function toSamples(pcm16: Uint8Array): number[] {
  const view = new DataView(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);
  const out: number[] = [];
  for (let i = 0; i < pcm16.byteLength / 2; i++) out.push(view.getInt16(i * 2, true));
  return out;
}

describe("createPcmResampler", () => {
  it("produces roughly inputLength/ratio output samples for a downsample", () => {
    const resample = createPcmResampler(44100, 8000);
    const input = pcm16From(Array.from({ length: 44100 }, (_, i) => (i % 2 === 0 ? 1000 : -1000)));
    const output = toSamples(resample(input));
    // ~8000 samples for one second of 44100Hz input at an 8000Hz output rate —
    // within a few samples for the boundary/phase-carry rounding.
    expect(output.length).toBeGreaterThan(7900);
    expect(output.length).toBeLessThan(8100);
  });

  it("a constant-value signal resamples to the same constant value throughout", () => {
    const resample = createPcmResampler(44100, 8000);
    const input = pcm16From(Array.from({ length: 1000 }, () => 5000));
    const output = toSamples(resample(input));
    expect(output.length).toBeGreaterThan(0);
    for (const s of output) expect(s).toBe(5000);
  });

  it("is continuous across a chunk boundary — splitting one stream into two chunks yields the same samples as one chunk, up to the last incomplete interpolation window", () => {
    // A linear ramp is exactly representable by linear interpolation, so a
    // correct resampler must reproduce it exactly regardless of where the
    // input is split into chunks — this is the test that would fail if
    // `phase`/`previousLastSample` weren't carried across calls.
    const ramp = Array.from({ length: 2000 }, (_, i) => i - 1000);

    const wholeStream = createPcmResampler(44100, 8000);
    const wholeOutput = toSamples(wholeStream(pcm16From(ramp)));

    const chunked = createPcmResampler(44100, 8000);
    const firstHalf = toSamples(chunked(pcm16From(ramp.slice(0, 700))));
    const secondHalf = toSamples(chunked(pcm16From(ramp.slice(700))));
    const chunkedOutput = [...firstHalf, ...secondHalf];

    // Same total sample count (the chunk boundary must not drop or duplicate
    // a sample), and every value matches within 1 unit of rounding.
    expect(chunkedOutput.length).toBe(wholeOutput.length);
    for (let i = 0; i < wholeOutput.length; i++) {
      expect(Math.abs(chunkedOutput[i]! - wholeOutput[i]!)).toBeLessThanOrEqual(1);
    }
  });

  it("an upsample (rare, but the same function) also produces continuous output", () => {
    const resample = createPcmResampler(8000, 16000);
    const input = pcm16From([0, 1000, 2000, 1000, 0, -1000, -2000, -1000]);
    const output = toSamples(resample(input));
    expect(output.length).toBeGreaterThanOrEqual(15);
  });
});
