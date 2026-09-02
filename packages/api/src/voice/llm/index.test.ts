import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resolveLlmProvider, getActiveModelLabel, GROQ_MODEL, buildGatewayProviderOptions } from "./index";
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

describe("buildGatewayProviderOptions — cross-provider LLM failover (recommendation #1)", () => {
  const ORIGINAL_ENV = { ...process.env };
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.AI_GATEWAY_FALLBACK_MODELS;
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("returns undefined for the groq provider — no native multi-model failover exists there", () => {
    expect(buildGatewayProviderOptions("groq", ["openai/gpt-5.4-mini"])).toBeUndefined();
  });

  it("returns undefined when gateway is active but neither an override nor the env var is set", () => {
    expect(buildGatewayProviderOptions("gateway")).toBeUndefined();
  });

  it("uses the per-agent override list when given, as the AI Gateway's native providerOptions.gateway.models shape", () => {
    expect(buildGatewayProviderOptions("gateway", ["openai/gpt-5.4-mini", "anthropic/claude-haiku"])).toEqual({
      gateway: { models: ["openai/gpt-5.4-mini", "anthropic/claude-haiku"] },
    });
  });

  it("falls back to the AI_GATEWAY_FALLBACK_MODELS env var (comma-separated) when no per-agent override is set", () => {
    process.env.AI_GATEWAY_FALLBACK_MODELS = "openai/gpt-5.4-mini, groq/llama-3.1-70b-versatile";
    expect(buildGatewayProviderOptions("gateway")).toEqual({
      gateway: { models: ["openai/gpt-5.4-mini", "groq/llama-3.1-70b-versatile"] },
    });
  });

  it("prefers the per-agent override over the env var when both are set", () => {
    process.env.AI_GATEWAY_FALLBACK_MODELS = "should-not-be-used";
    expect(buildGatewayProviderOptions("gateway", ["openai/gpt-5.4"])).toEqual({
      gateway: { models: ["openai/gpt-5.4"] },
    });
  });

  it("defaults to the gateway provider when no override is passed (matches resolveLlmProvider's default)", () => {
    process.env.AI_GATEWAY_FALLBACK_MODELS = "openai/gpt-5.4-mini";
    expect(buildGatewayProviderOptions()).toEqual({ gateway: { models: ["openai/gpt-5.4-mini"] } });
  });
});
