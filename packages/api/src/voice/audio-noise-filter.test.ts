import { describe, it, expect } from "bun:test";
import { computeRms, createRollingNoiseFilter, applyNoiseFilterToMulaw } from "./audio-noise-filter";
import { mulawToPcm16, pcm16ToMulaw } from "./audio-codec";

function silentChunk(length = 160): Int16Array {
  return new Int16Array(length); // all zeros
}

function quietNoiseChunk(length = 160, amplitude = 30): Int16Array {
  // Deterministic low-amplitude "noise" — alternating +/- amplitude, not
  // actual random noise, so tests are reproducible.
  const out = new Int16Array(length);
  for (let i = 0; i < length; i++) out[i] = i % 2 === 0 ? amplitude : -amplitude;
  return out;
}

function loudSpeechChunk(length = 160, amplitude = 8000): Int16Array {
  const out = new Int16Array(length);
  for (let i = 0; i < length; i++) out[i] = i % 2 === 0 ? amplitude : -amplitude;
  return out;
}

describe("computeRms", () => {
  it("returns 0 for silence", () => {
    expect(computeRms(silentChunk())).toBe(0);
  });

  it("returns 0 for an empty sample array", () => {
    expect(computeRms(new Int16Array(0))).toBe(0);
  });

  it("returns the constant amplitude for a chunk of uniform +/-N samples", () => {
    // RMS of alternating +N/-N is exactly N.
    expect(computeRms(quietNoiseChunk(160, 30))).toBeCloseTo(30, 5);
    expect(computeRms(loudSpeechChunk(160, 8000))).toBeCloseTo(8000, 5);
  });
});

describe("createRollingNoiseFilter — §3b adaptive noise gate", () => {
  it("attenuates a quiet chunk that's within gating range of the initial floor", () => {
    const filter = createRollingNoiseFilter({ initialFloor: 40, gateMultiplier: 2, attenuationFactor: 0.1 });
    const quiet = quietNoiseChunk(160, 30); // rms 30 < 40*2=80 -> gated
    const out = filter.apply(quiet);
    expect(out.length).toBe(quiet.length);
    // Every sample should be scaled down, not passed through unchanged.
    expect(Math.abs(out[0]!)).toBeLessThan(Math.abs(quiet[0]!));
    expect(out[0]).toBe(Math.round(30 * 0.1));
  });

  it("passes a loud speech chunk through completely unchanged", () => {
    const filter = createRollingNoiseFilter({ initialFloor: 40, gateMultiplier: 2 });
    const speech = loudSpeechChunk(160, 8000); // rms 8000 >> 40*2=80 -> not gated
    const out = filter.apply(speech);
    expect(out).toEqual(speech);
  });

  it("never moves the noise floor in response to a loud speech chunk, even a very long one", () => {
    const filter = createRollingNoiseFilter({ initialFloor: 40 });
    const floorBefore = filter.getNoiseFloor();
    for (let i = 0; i < 50; i++) filter.apply(loudSpeechChunk(160, 9000));
    expect(filter.getNoiseFloor()).toBe(floorBefore);
  });

  it("converges the floor toward a sustained lower ambient noise level", () => {
    const filter = createRollingNoiseFilter({ initialFloor: 100, attackAlpha: 0.3 });
    for (let i = 0; i < 30; i++) filter.apply(quietNoiseChunk(160, 20));
    // Floor should have moved well down from 100 toward ~20, not stayed put.
    expect(filter.getNoiseFloor()).toBeLessThan(30);
    expect(filter.getNoiseFloor()).toBeGreaterThan(15);
  });

  it("recovers and starts gating again after the floor re-calibrates down following a loud burst", () => {
    const filter = createRollingNoiseFilter({ initialFloor: 40, gateMultiplier: 2 });
    // A loud burst never moved the floor (previous test), so a subsequent
    // quiet chunk is still correctly gated against the original floor.
    filter.apply(loudSpeechChunk(160, 9000));
    const quiet = quietNoiseChunk(160, 30);
    const out = filter.apply(quiet);
    expect(out[0]).not.toBe(quiet[0]);
  });

  it("clamps the floor within [minFloor, maxFloor] even given extreme sustained input", () => {
    const filter = createRollingNoiseFilter({ initialFloor: 40, minFloor: 5, maxFloor: 200, attackAlpha: 0.9 });
    // A near-silent chunk still counts as "noise" relative to the floor —
    // repeatedly feeding it should never push the floor below minFloor.
    for (let i = 0; i < 100; i++) filter.apply(silentChunk());
    expect(filter.getNoiseFloor()).toBeGreaterThanOrEqual(5);
  });
});

describe("applyNoiseFilterToMulaw — wire-format integration", () => {
  it("round-trips through mu-law without changing length", () => {
    const filter = createRollingNoiseFilter({ initialFloor: 40 });
    // A real mu-law silence byte is 0xFF (encodes to 0 PCM) — 160 bytes is
    // one Twilio 20ms frame at 8kHz.
    const mulawSilence = new Uint8Array(160).fill(0xff);
    const out = applyNoiseFilterToMulaw(mulawSilence, filter);
    expect(out.length).toBe(mulawSilence.length);
  });

  it("actually attenuates a quiet mu-law chunk once the floor has calibrated to something louder", () => {
    const filter = createRollingNoiseFilter({ initialFloor: 200, gateMultiplier: 2 });
    // Build real mu-law bytes for a genuinely quiet (rms ~30) PCM signal via
    // the real encoder, rather than hand-picking mu-law byte values — mu-law
    // has coarse quantization near zero where several distinct bytes all
    // decode to exactly 0, which would silently make this test a no-op.
    const quietPcmBytes = new Uint8Array(320); // 160 samples * 2 bytes
    const view = new DataView(quietPcmBytes.buffer);
    for (let i = 0; i < 160; i++) view.setInt16(i * 2, i % 2 === 0 ? 30 : -30, true);
    const mulawQuiet = pcm16ToMulaw(quietPcmBytes);

    const decodedBefore = mulawToPcm16(mulawQuiet);
    const out = applyNoiseFilterToMulaw(mulawQuiet, filter);
    const decodedAfter = mulawToPcm16(out);
    // At least one sample must differ after attenuation + re-encoding —
    // proves the filter actually ran, not just passed bytes through.
    expect(decodedAfter).not.toEqual(decodedBefore);
  });
});
