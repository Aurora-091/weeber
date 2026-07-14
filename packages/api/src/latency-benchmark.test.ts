import { describe, it, expect } from "bun:test";
import { percentile, computeStats, runStage } from "../scripts/latency-benchmark";

/**
 * Unit coverage for the benchmark's pure math + control-flow (§2b) —
 * the CLI entrypoint itself (main()) talks to real STT/LLM/TTS providers
 * over the network, which isn't something a unit test should depend on.
 * `runStage` is the seam that lets everything above it (measureSttConnect/
 * measureLlmTtft/measureTtsFirstByte) be swapped for a synthetic measurer
 * here, so this exercises the exact same aggregation/skip logic the real
 * CLI run goes through.
 */
describe("latency-benchmark percentile/computeStats", () => {
  it("nearest-rank P50/P90 matches hand-computed values", () => {
    const samples = Array.from({ length: 10 }, (_, i) => (i + 1) * 100); // 100..1000
    expect(percentile(samples, 50)).toBe(500);
    expect(percentile(samples, 90)).toBe(900);
  });

  it("returns null on an empty sample rather than 0 or NaN", () => {
    expect(percentile([], 50)).toBeNull();
    const stats = computeStats({ stage: "x", provider: "y", configured: true, samples: [] });
    expect(stats.p50).toBeNull();
    expect(stats.p90).toBeNull();
    expect(stats.avg).toBeNull();
  });

  it("rounds the average and reports the real sample count", () => {
    const stats = computeStats({ stage: "llm", provider: "groq", configured: true, samples: [100, 150, 200] });
    expect(stats.avg).toBe(150);
    expect(stats.sampleCount).toBe(3);
  });
});

describe("latency-benchmark runStage", () => {
  it("collects every successful sample across iterations", async () => {
    const values = [120, 130, 110, 140, 125];
    let i = 0;
    const result = await runStage("fake", "fake-provider", 5, async () => values[i++]);
    expect(result.configured).toBe(true);
    expect(result.samples).toEqual(values);
  });

  it("tolerates a transient failure without discarding the whole stage", async () => {
    const outcomes = [100, new Error("transient"), 110, 120];
    let i = 0;
    const result = await runStage("fake", "fake-provider", 4, async () => {
      const next = outcomes[i++];
      if (next instanceof Error) throw next;
      return next;
    });
    expect(result.configured).toBe(true);
    expect(result.samples).toEqual([100, 110, 120]);
  });

  it("reports not-configured (not a pile of 0ms samples) when every iteration fails", async () => {
    const result = await runStage("fake", "fake-provider", 3, async () => {
      throw new Error("FAKE_API_KEY is not set");
    });
    expect(result.configured).toBe(false);
    expect(result.samples).toEqual([]);
    expect(result.skipReason).toContain("FAKE_API_KEY");
  });
});
