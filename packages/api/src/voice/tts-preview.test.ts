import { describe, it, expect } from "bun:test";
import { wrapMulawInWavHeader } from "./tts-preview";

describe("wrapMulawInWavHeader", () => {
  it("produces a valid RIFF/WAVE header with mu-law format code 7", () => {
    const rawAudio = Buffer.from([1, 2, 3, 4, 5]);
    const wav = wrapMulawInWavHeader(rawAudio);

    expect(wav.length).toBe(44 + rawAudio.length);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.toString("ascii", 12, 16)).toBe("fmt ");
    expect(wav.readUInt16LE(20)).toBe(7); // mu-law format code
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(8000); // sample rate
    expect(wav.toString("ascii", 36, 40)).toBe("data");
    expect(wav.readUInt32LE(40)).toBe(rawAudio.length);
  });

  it("appends the exact raw audio bytes after the 44-byte header", () => {
    const rawAudio = Buffer.from([9, 8, 7]);
    const wav = wrapMulawInWavHeader(rawAudio);
    expect(wav.subarray(44)).toEqual(rawAudio);
  });
});
