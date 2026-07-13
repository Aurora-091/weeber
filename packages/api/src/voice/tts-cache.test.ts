import { describe, expect, test, beforeEach } from "bun:test";
import { getCachedTtsAudio, setCachedTtsAudio, clearTtsCacheForTests } from "./tts-cache";

describe("tts-cache", () => {
  beforeEach(() => {
    clearTtsCacheForTests();
  });

  test("returns undefined for a line that's never been cached", () => {
    expect(getCachedTtsAudio("cartesia", "voice1", "en", "Hello there")).toBeUndefined();
  });

  test("stores and retrieves audio for an exact (provider, voice, language, text) match", () => {
    const chunkA = Buffer.from("chunk-a").toString("base64");
    const chunkB = Buffer.from("chunk-b").toString("base64");
    setCachedTtsAudio("cartesia", "voice1", "en", "Hello there", [chunkA, chunkB]);

    const cached = getCachedTtsAudio("cartesia", "voice1", "en", "Hello there");
    expect(cached).toBeDefined();
    expect(Buffer.from(cached!, "base64").toString()).toBe("chunk-achunk-b");
  });

  test("does not return a hit for a different voice or provider", () => {
    setCachedTtsAudio("cartesia", "voice1", "en", "Hello there", [Buffer.from("x").toString("base64")]);
    expect(getCachedTtsAudio("elevenlabs", "voice1", "en", "Hello there")).toBeUndefined();
    expect(getCachedTtsAudio("cartesia", "voice2", "en", "Hello there")).toBeUndefined();
    expect(getCachedTtsAudio("cartesia", "voice1", "hi", "Hello there")).toBeUndefined();
  });

  test("does not return a hit for different text, even with the same voice", () => {
    setCachedTtsAudio("cartesia", "voice1", "en", "Hello there", [Buffer.from("x").toString("base64")]);
    expect(getCachedTtsAudio("cartesia", "voice1", "en", "Goodbye")).toBeUndefined();
  });

  test("setCachedTtsAudio with an empty chunk list is a no-op", () => {
    setCachedTtsAudio("cartesia", "voice1", "en", "Hello there", []);
    expect(getCachedTtsAudio("cartesia", "voice1", "en", "Hello there")).toBeUndefined();
  });
});
