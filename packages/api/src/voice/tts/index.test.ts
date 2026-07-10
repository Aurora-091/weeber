import { describe, it, expect } from "bun:test";
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
