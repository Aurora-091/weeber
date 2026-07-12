import { describe, it, expect } from "bun:test";
import { resolveLlmProvider, getActiveModelLabel, GROQ_MODEL } from "./index";
import { VOICE_AGENT_MODEL as GATEWAY_MODEL } from "../gateway";

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
    // Asserted against the actual resolved default (GATEWAY_MODEL/GROQ_MODEL,
    // both env-overridable) rather than a hardcoded literal — a real
    // AI_GATEWAY_MODEL/GROQ_MODEL value in packages/api/.env legitimately
    // changes this deployment's default, and the test should track that
    // instead of asserting a specific model name will always be it.
    expect(getActiveModelLabel("gateway")).toBe(`gateway/${GATEWAY_MODEL}`);
    expect(getActiveModelLabel("groq")).toBe(`groq/${GROQ_MODEL}`);
  });

  it("uses the modelOverride when one is given, per-agent (agent-frame.ts's llmModel)", () => {
    expect(getActiveModelLabel("gateway", "openai/gpt-5.4")).toBe("gateway/openai/gpt-5.4");
    expect(getActiveModelLabel("groq", "some-other-groq-model")).toBe("groq/some-other-groq-model");
  });
});
