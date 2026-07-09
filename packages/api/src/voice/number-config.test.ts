import { describe, it, expect } from "bun:test";
import { parseNumberConfigMap } from "./number-config";

describe("parseNumberConfigMap", () => {
  it("returns empty map for undefined input", () => {
    expect(parseNumberConfigMap(undefined)).toEqual({});
  });

  it("returns empty map for empty string", () => {
    expect(parseNumberConfigMap("")).toEqual({});
  });

  it("parses a valid config map", () => {
    const raw = JSON.stringify({
      "+15551234567": { ttsProvider: "cartesia", maxDurationSeconds: 300 },
    });
    expect(parseNumberConfigMap(raw)).toEqual({
      "+15551234567": { ttsProvider: "cartesia", maxDurationSeconds: 300 },
    });
  });

  it("returns empty map gracefully for malformed JSON", () => {
    expect(parseNumberConfigMap("{not valid json")).toEqual({});
  });

  it("returns empty map for valid JSON that isn't an object", () => {
    expect(parseNumberConfigMap("42")).toEqual({});
    expect(parseNumberConfigMap('"a string"')).toEqual({});
    expect(parseNumberConfigMap("null")).toEqual({});
  });
});
