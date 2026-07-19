import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resolveSttProvider } from "./index";

describe("resolveSttProvider", () => {
  const originalStt = process.env.STT_PROVIDER;
  afterEach(() => {
    if (originalStt === undefined) delete process.env.STT_PROVIDER;
    else process.env.STT_PROVIDER = originalStt;
  });

  it("defaults to deepgram when no override or env var", () => {
    delete process.env.STT_PROVIDER;
    expect(resolveSttProvider()).toBe("deepgram");
  });

  it("respects an explicit override", () => {
    expect(resolveSttProvider("sarvam")).toBe("sarvam");
    expect(resolveSttProvider("deepgram")).toBe("deepgram");
    expect(resolveSttProvider("elevenlabs")).toBe("elevenlabs");
  });

  it("falls back to deepgram for an unknown override value", () => {
    expect(resolveSttProvider("not-a-real-provider")).toBe("deepgram");
  });
});

describe("resolveSttProvider — Indic smart default (2026-07-19)", () => {
  const originalKey = process.env.SARVAM_API_KEY;
  const originalStt = process.env.STT_PROVIDER;

  beforeEach(() => {
    delete process.env.STT_PROVIDER;
  });
  afterEach(() => {
    if (originalKey === undefined) delete process.env.SARVAM_API_KEY;
    else process.env.SARVAM_API_KEY = originalKey;
    if (originalStt === undefined) delete process.env.STT_PROVIDER;
    else process.env.STT_PROVIDER = originalStt;
  });

  it("routes an Indic language to sarvam when a Sarvam key is configured", () => {
    process.env.SARVAM_API_KEY = "test-key";
    expect(resolveSttProvider(undefined, "ta")).toBe("sarvam");
    expect(resolveSttProvider(undefined, "bn")).toBe("sarvam");
    expect(resolveSttProvider(undefined, "HI")).toBe("sarvam"); // case-insensitive
  });

  it("does NOT route Indic languages to sarvam when no Sarvam key is set", () => {
    delete process.env.SARVAM_API_KEY;
    expect(resolveSttProvider(undefined, "ta")).toBe("deepgram");
  });

  it("never overrides an explicit provider choice, even for Indic languages", () => {
    process.env.SARVAM_API_KEY = "test-key";
    expect(resolveSttProvider("deepgram", "ta")).toBe("deepgram");
    expect(resolveSttProvider("elevenlabs", "hi")).toBe("elevenlabs");
  });

  it("leaves English and 'multi' on the platform default (deepgram)", () => {
    process.env.SARVAM_API_KEY = "test-key";
    expect(resolveSttProvider(undefined, "en")).toBe("deepgram");
    // "multi" is Deepgram's own code-switching mode — must stay on deepgram.
    expect(resolveSttProvider(undefined, "multi")).toBe("deepgram");
  });
});
