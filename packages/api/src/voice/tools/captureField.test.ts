import { describe, it, expect } from "bun:test";
import { captureField } from "./captureField";

describe("captureField tool", () => {
  it("echoes back the captured field/value with a captured flag", async () => {
    // @ts-expect-error — execute is present on this tool definition at runtime
    const result = await captureField.execute({ field: "email", value: "a@b.com" });
    expect(result).toEqual({ captured: true, field: "email", value: "a@b.com" });
  });

  it("has a description that instructs immediate capture, not end-of-call batching", () => {
    expect(captureField.description).toContain("immediately");
  });
});
