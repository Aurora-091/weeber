import { describe, it, expect } from "bun:test";
import { resolveLlmProvider } from "./index";

describe("resolveLlmProvider", () => {
  it("defaults to gateway when no override or env var", () => {
    expect(resolveLlmProvider()).toBe("gateway");
  });

  it("respects an explicit override", () => {
    expect(resolveLlmProvider("groq")).toBe("groq");
    expect(resolveLlmProvider("gateway")).toBe("gateway");
  });
});
