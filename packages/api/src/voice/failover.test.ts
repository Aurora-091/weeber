import { describe, it, expect } from "bun:test";
import { resolveSttFailoverChain, resolveTtsFailoverChain, DEFAULT_STT_FALLBACK_ORDER, DEFAULT_TTS_FALLBACK_ORDER } from "./failover";

describe("resolveSttFailoverChain — cross-provider failover (recommendation #1)", () => {
  it("returns the platform default chain minus the primary, when no override is given", () => {
    expect(resolveSttFailoverChain("deepgram")).toEqual(["elevenlabs", "sarvam"]);
  });

  it("excludes the primary even if the default order lists it first", () => {
    expect(resolveSttFailoverChain("elevenlabs")).toEqual(["deepgram", "sarvam"]);
    expect(resolveSttFailoverChain("sarvam")).toEqual(["deepgram", "elevenlabs"]);
  });

  it("uses a per-agent override order verbatim (minus the primary) instead of the platform default", () => {
    expect(resolveSttFailoverChain("deepgram", ["sarvam", "elevenlabs"])).toEqual(["sarvam", "elevenlabs"]);
  });

  it("filters out the primary from an override even if the caller listed it", () => {
    expect(resolveSttFailoverChain("deepgram", ["deepgram", "sarvam", "elevenlabs"])).toEqual(["sarvam", "elevenlabs"]);
  });

  it("drops unrecognized provider names from an override instead of throwing (fail-open)", () => {
    expect(resolveSttFailoverChain("deepgram", ["not-a-real-provider", "sarvam"])).toEqual(["sarvam"]);
  });

  it("falls back to the platform default when the override is an empty array", () => {
    expect(resolveSttFailoverChain("deepgram", [])).toEqual(["elevenlabs", "sarvam"]);
  });

  it("falls back to the platform default when the override is null", () => {
    expect(resolveSttFailoverChain("deepgram", null)).toEqual(["elevenlabs", "sarvam"]);
  });

  it("de-duplicates a override chain that lists the same provider twice", () => {
    expect(resolveSttFailoverChain("deepgram", ["sarvam", "sarvam", "elevenlabs"])).toEqual(["sarvam", "elevenlabs"]);
  });

  it("the exported default order contains exactly the three real STT providers", () => {
    expect(new Set(DEFAULT_STT_FALLBACK_ORDER)).toEqual(new Set(["deepgram", "elevenlabs", "sarvam"]));
  });
});

describe("resolveTtsFailoverChain — cross-provider failover (recommendation #1)", () => {
  it("returns the platform default chain minus the primary, when no override is given", () => {
    expect(resolveTtsFailoverChain("cartesia")).toEqual(["elevenlabs", "sarvam"]);
  });

  it("excludes the primary even if the default order lists it first", () => {
    expect(resolveTtsFailoverChain("elevenlabs")).toEqual(["cartesia", "sarvam"]);
  });

  it("uses a per-agent override order verbatim (minus the primary) instead of the platform default", () => {
    expect(resolveTtsFailoverChain("cartesia", ["sarvam", "elevenlabs"])).toEqual(["sarvam", "elevenlabs"]);
  });

  it("drops unrecognized provider names from an override instead of throwing (fail-open)", () => {
    expect(resolveTtsFailoverChain("cartesia", ["not-a-real-provider"])).toEqual([]);
  });

  it("falls back to the platform default when the override is null", () => {
    expect(resolveTtsFailoverChain("cartesia", null)).toEqual(["elevenlabs", "sarvam"]);
  });

  it("the exported default order contains exactly the three real TTS providers", () => {
    expect(new Set(DEFAULT_TTS_FALLBACK_ORDER)).toEqual(new Set(["elevenlabs", "cartesia", "sarvam"]));
  });
});
