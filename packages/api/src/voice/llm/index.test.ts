import { describe, it, expect } from "bun:test";
import { resolveLlmProvider, getActiveModelLabel } from "./index";

describe("resolveLlmProvider", () => {
  it("defaults to gateway when no override or env var", () => {
    expect(resolveLlmProvider()).toBe("gateway");
  });

  it("respects an explicit override", () => {
    expect(resolveLlmProvider("groq")).toBe("groq");
    expect(resolveLlmProvider("gateway")).toBe("gateway");
  });
});

describe("getActiveModelLabel", () => {
  it("uses the env-configured default model when no modelOverride is given", () => {
    expect(getActiveModelLabel("gateway")).toBe("gateway/openai/gpt-5.4-mini");
    expect(getActiveModelLabel("groq")).toBe("groq/llama-3.3-70b-versatile");
  });

  it("uses the modelOverride when one is given, per-agent (agent-frame.ts's llmModel)", () => {
    expect(getActiveModelLabel("gateway", "openai/gpt-5.4")).toBe("gateway/openai/gpt-5.4");
    expect(getActiveModelLabel("groq", "some-other-groq-model")).toBe("groq/some-other-groq-model");
  });
});
