import { describe, it, expect } from "bun:test";
import { hangUp } from "./hangUp";

describe("hangUp tool", () => {
  it("echoes back the reason with a hangUpRequested flag", async () => {
    // @ts-expect-error — execute is present on this tool definition at runtime
    const result = await hangUp.execute({ reason: "caller said goodbye" });
    expect(result).toEqual({ hangUpRequested: true, reason: "caller said goodbye" });
  });

  it("instructs saying the closing line in the same turn, not instead of one", () => {
    expect(hangUp.description).toContain("same turn");
    expect(hangUp.description).toContain("never call this instead of saying goodbye");
  });
});
