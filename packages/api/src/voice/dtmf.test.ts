import { describe, expect, test } from "bun:test";
import { buildDtmfAudio, isValidDtmfSequence } from "./dtmf";

describe("dtmf", () => {
  test("isValidDtmfSequence accepts digits, *, and #", () => {
    expect(isValidDtmfSequence("123")).toBe(true);
    expect(isValidDtmfSequence("*0#")).toBe(true);
    expect(isValidDtmfSequence("41234567#")).toBe(true);
  });

  test("isValidDtmfSequence rejects empty or non-DTMF characters", () => {
    expect(isValidDtmfSequence("")).toBe(false);
    expect(isValidDtmfSequence("abc")).toBe(false);
    expect(isValidDtmfSequence("1a2")).toBe(false);
  });

  test("buildDtmfAudio returns non-empty base64 mu-law audio for a valid sequence", () => {
    const audio = buildDtmfAudio("123#");
    expect(typeof audio).toBe("string");
    expect(audio.length).toBeGreaterThan(0);
    // Roundtrips through base64 decode without throwing.
    expect(() => Buffer.from(audio, "base64")).not.toThrow();
  });

  test("buildDtmfAudio produces longer audio for longer sequences", () => {
    const short = Buffer.from(buildDtmfAudio("1"), "base64");
    const long = Buffer.from(buildDtmfAudio("123456"), "base64");
    expect(long.length).toBeGreaterThan(short.length);
  });

  test("buildDtmfAudio silently skips invalid characters instead of throwing", () => {
    expect(() => buildDtmfAudio("1a2b3")).not.toThrow();
    const withJunk = Buffer.from(buildDtmfAudio("1a2b3"), "base64");
    const clean = Buffer.from(buildDtmfAudio("123"), "base64");
    expect(withJunk.length).toBe(clean.length);
  });
});
