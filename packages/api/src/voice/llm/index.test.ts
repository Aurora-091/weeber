import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  resolveLlmProvider,
  getActiveModelLabel,
  GROQ_MODEL,
  OPENAI_MODEL,
  ANTHROPIC_MODEL,
  OPENROUTER_MODEL,
  buildGatewayProviderOptions,
  isLlmProviderConfigured,
  getConfiguredLlmProviders,
  estimateLlmCost,
} from "./index";
import { VOICE_AGENT_MODEL as GATEWAY_MODEL } from "../gateway";

describe("resolveLlmProvider", () => {
  it("defaults to gateway when no override or env var", () => {
    expect(resolveLlmProvider()).toBe("gateway");
  });

  it("respects an explicit override", () => {
    expect(resolveLlmProvider("groq")).toBe("groq");
    expect(resolveLlmProvider("gateway")).toBe("gateway");
  });

  it("respects the three direct-transport providers added 2026-08-27 (openai/anthropic/openrouter)", () => {
    expect(resolveLlmProvider("openai")).toBe("openai");
    expect(resolveLlmProvider("anthropic")).toBe("anthropic");
    expect(resolveLlmProvider("openrouter")).toBe("openrouter");
  });
});

describe("isLlmProviderConfigured / getConfiguredLlmProviders", () => {
  const ORIGINAL_ENV = { ...process.env };
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("is false for a direct provider with no API key set, without touching resolution", () => {
    expect(isLlmProviderConfigured("openai")).toBe(false);
    // Unconfigured doesn't stop resolveLlmProvider from returning it — that's
    // the "picker offers it or not" concern, not a resolution-time gate; see
    // llm/index.ts's own doc comment on resolveLlmProvider for why.
    expect(resolveLlmProvider("openai")).toBe("openai");
  });

  it("flips true the moment the env var is set — no code change needed", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    expect(isLlmProviderConfigured("anthropic")).toBe(true);
  });

  it("getConfiguredLlmProviders lists exactly the providers whose keys are set", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const configured = getConfiguredLlmProviders();
    expect(configured).toContain("openai");
    expect(configured).toContain("openrouter");
    expect(configured).not.toContain("anthropic");
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

  it("resolves each direct transport added 2026-08-27 to its own env-overridable default model", () => {
    expect(getActiveModelLabel("openai")).toBe(`openai/${OPENAI_MODEL}`);
    expect(getActiveModelLabel("anthropic")).toBe(`anthropic/${ANTHROPIC_MODEL}`);
    expect(getActiveModelLabel("openrouter")).toBe(`openrouter/${OPENROUTER_MODEL}`);
  });
});

describe("estimateLlmCost", () => {
  it("has a real (non-zero, finite) rate for every provider, including the three added 2026-08-27", () => {
    for (const provider of ["gateway", "groq", "openai", "anthropic", "openrouter"] as const) {
      const cost = estimateLlmCost(provider, 1_000_000, 1_000_000);
      expect(Number.isFinite(cost)).toBe(true);
      expect(cost).toBeGreaterThan(0);
    }
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
    process.env.AI_GATEWAY_FALLBACK_MODELS = "openai/gpt-5.4-mini, groq/llama-3.3-70b-versatile";
    expect(buildGatewayProviderOptions("gateway")).toEqual({
      gateway: { models: ["openai/gpt-5.4-mini", "groq/llama-3.3-70b-versatile"] },
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
