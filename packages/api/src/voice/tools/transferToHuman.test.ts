import { describe, it, expect } from "bun:test";
import { transferToHuman } from "./transferToHuman";

describe("transferToHuman tool", () => {
  it("echoes back the reason with a transferRequested flag", async () => {
    // @ts-expect-error — execute is present on this tool definition at runtime
    const result = await transferToHuman.execute({ reason: "caller asked for a person" });
    expect(result).toEqual({ transferRequested: true, reason: "caller asked for a person" });
  });

  it("instructs telling the caller before transferring, not doing it silently", () => {
    expect(transferToHuman.description).toContain("same turn");
    expect(transferToHuman.description).toContain("never transfer silently");
  });
});
