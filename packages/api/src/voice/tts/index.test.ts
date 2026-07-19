import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resolveTtsProvider } from "./index";

describe("resolveTtsProvider", () => {
  it("defaults to cartesia when no override or env var", () => {
    expect(resolveTtsProvider()).toBe("cartesia");
  });

  it("respects an explicit override", () => {
    expect(resolveTtsProvider("elevenlabs")).toBe("elevenlabs");
    expect(resolveTtsProvider("cartesia")).toBe("cartesia");
  });

  it("falls back to cartesia for an unknown override value", () => {
    expect(resolveTtsProvider("not-a-real-provider")).toBe("cartesia");
  });

  it("accepts the new sarvam provider", () => {
    expect(resolveTtsProvider("sarvam")).toBe("sarvam");
  });
});

describe("resolveTtsProvider — Indic smart default (2026-07-19)", () => {
  const originalKey = process.env.SARVAM_API_KEY;
  const originalTts = process.env.TTS_PROVIDER;

  beforeEach(() => {
    delete process.env.TTS_PROVIDER;
  });
  afterEach(() => {
    if (originalKey === undefined) delete process.env.SARVAM_API_KEY;
    else process.env.SARVAM_API_KEY = originalKey;
    if (originalTts === undefined) delete process.env.TTS_PROVIDER;
    else process.env.TTS_PROVIDER = originalTts;
  });

  it("routes an Indic language to sarvam when a Sarvam key is configured", () => {
    process.env.SARVAM_API_KEY = "test-key";
    expect(resolveTtsProvider(undefined, "ta")).toBe("sarvam");
    expect(resolveTtsProvider(undefined, "hi")).toBe("sarvam");
    expect(resolveTtsProvider(undefined, "MR")).toBe("sarvam"); // case-insensitive
  });

  it("does NOT route Indic languages to sarvam when no Sarvam key is set", () => {
    delete process.env.SARVAM_API_KEY;
    expect(resolveTtsProvider(undefined, "ta")).toBe("cartesia");
  });

  it("never overrides an explicit provider choice, even for Indic languages", () => {
    process.env.SARVAM_API_KEY = "test-key";
    expect(resolveTtsProvider("cartesia", "ta")).toBe("cartesia");
    expect(resolveTtsProvider("elevenlabs", "hi")).toBe("elevenlabs");
  });

  it("leaves English and 'multi' on the platform default", () => {
    process.env.SARVAM_API_KEY = "test-key";
    expect(resolveTtsProvider(undefined, "en")).toBe("cartesia");
    expect(resolveTtsProvider(undefined, "multi")).toBe("cartesia");
  });
});
