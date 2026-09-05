import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resolveLlmProvider, getActiveModelLabel, buildGatewayProviderOptions } from "./index";
import { VOICE_AGENT_MODEL as GATEWAY_MODEL } from "../gateway";

describe("resolveLlmProvider", () => {
  it("defaults to gateway when no override or env var", () => {
    expect(resolveLlmProvider()).toBe("gateway");
  });

  it("respects an explicit override", () => {
    expect(resolveLlmProvider("gateway")).toBe("gateway");
  });

  it("fails open to gateway on an unrecognized LLM_PROVIDER value (e.g. a stale 'groq' left over from before its removal)", () => {
    const original = process.env.LLM_PROVIDER;
    process.env.LLM_PROVIDER = "groq";
    try {
      expect(resolveLlmProvider()).toBe("gateway");
    } finally {
      process.env.LLM_PROVIDER = original;
    }
  });
});

describe("getActiveModelLabel", () => {
  it("uses the env-configured default model when no modelOverride is given", () => {
    // Asserted against the actual resolved default (GATEWAY_MODEL, env-
    // overridable) rather than a hardcoded literal — a real AI_GATEWAY_MODEL
    // value in packages/api/.env legitimately changes this deployment's
    // default, and the test should track that instead of asserting a
    // specific model name will always be it.
    expect(getActiveModelLabel("gateway")).toBe(`gateway/${GATEWAY_MODEL}`);
  });

  it("uses the modelOverride when one is given, per-agent (agent-frame.ts's llmModel)", () => {
    expect(getActiveModelLabel("gateway", "openai/gpt-5.4")).toBe("gateway/openai/gpt-5.4");
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
