import { createGroq } from "@ai-sdk/groq";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { gateway, VOICE_AGENT_MODEL as GATEWAY_MODEL } from "../gateway";
import type { LlmTransportLink } from "./transport-chain";

export type LlmProvider = "gateway" | "groq" | "openai" | "anthropic" | "openrouter";

const ALL_LLM_PROVIDERS: readonly LlmProvider[] = ["gateway", "groq", "openai", "anthropic", "openrouter"];

/**
 * LLM provider registry, mirroring the TTS provider split (see ../tts/).
 * The platform default is LLM_PROVIDER; an individual agent overrides it with
 * org_agent_configs.llm_provider + llm_model (agent-frame.ts), so "which LLM"
 * is a per-agent choice and the env var is only the fallback default.
 *
 * "gateway" and "groq" are two different TRANSPORTS, not two different models:
 * "gateway" routes through Vercel AI Gateway (which can itself forward to Groq
 * compute via a groq/* model id) and "groq" talks to Groq directly. Measured
 * 2026-08-12, median time-to-first-content-delta, same model both ways:
 * gateway -> groq/llama-3.3-70b-versatile 334ms vs groq direct 206ms, so the
 * Vercel hop costs ~130ms. Direct is faster, but buildGatewayProviderOptions
 * below returns empty providerOptions for "groq" — going direct trades that
 * 130ms for having NO LLM failover at all. Default to "gateway" until a Groq
 * multi-model failover path exists. (Measured from a dev sandbox, not from
 * Railway Singapore, so treat the ranking as sound and the absolute numbers
 * as indicative.)
 *
 * `openai`/`anthropic`/`openrouter` (2026-08-27) — direct SDK transports, the
 * same shape as `groq`: no gateway hop, no gateway-native failover, and (like
 * every provider here) the resolver never checks whether the corresponding
 * API key is actually set. An org can still be configured to use one with no
 * key present; the request just fails at call time with that provider's own
 * auth error, same as pointing an agent at Sarvam TTS with no SARVAM_API_KEY.
 * `isLlmProviderConfigured`/`getConfiguredLlmProviders` below exist for the
 * *other* half of that — deciding what to OFFER as a choice in the first
 * place (the admin dashboard's LLM-provider dropdown, `/api/health`'s
 * `keysConfigured`) — so an unconfigured provider simply never gets selected
 * by anyone, rather than needing to be rejected after the fact.
 */
export function resolveLlmProvider(override?: LlmProvider): LlmProvider {
  const configured = (override ?? process.env.LLM_PROVIDER ?? "gateway").toLowerCase();
  if ((ALL_LLM_PROVIDERS as readonly string[]).includes(configured)) return configured as LlmProvider;
  console.warn(`[llm] Unknown LLM provider "${configured}" — falling back to "gateway"`);
  return "gateway";
}

/** Whether this provider's own API key is present — see resolveLlmProvider's
 * doc comment for why this is deliberately separate from resolution/dialing.
 * `gateway` checks AI_GATEWAY_API_KEY (config-check.ts already treats an
 * unset gateway key as a boot-time misconfiguration for the same reason). */
export function isLlmProviderConfigured(provider: LlmProvider): boolean {
  switch (provider) {
    case "gateway":
      return Boolean(process.env.AI_GATEWAY_API_KEY);
    case "groq":
      return Boolean(process.env.GROQ_API_KEY);
    case "openai":
      return Boolean(process.env.OPENAI_API_KEY);
    case "anthropic":
      return Boolean(process.env.ANTHROPIC_API_KEY);
    case "openrouter":
      return Boolean(process.env.OPENROUTER_API_KEY);
  }
}

/** Every provider whose API key is currently set — what a provider picker
 * (dashboard dropdown, `/api/health`) should actually offer. */
export function getConfiguredLlmProviders(): LlmProvider[] {
  return ALL_LLM_PROVIDERS.filter(isLlmProviderConfigured);
}

const groq = createGroq({ apiKey: process.env.GROQ_API_KEY });
const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
// OpenRouter speaks the OpenAI chat-completions wire format, so it needs no
// dedicated SDK package — the same createOpenAI factory pointed at
// OpenRouter's base URL is OpenRouter's own documented Vercel AI SDK
// integration path, not a hack.
const openrouter = createOpenAI({ apiKey: process.env.OPENROUTER_API_KEY, baseURL: "https://openrouter.ai/api/v1" });

// Llama 3.3 70B is the commonly recommended Groq model for real-time voice
// agents — strong quality/latency tradeoff and native tool-calling support.
export const GROQ_MODEL = process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile";
export const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-5.4-mini";
export const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";
// Provider-prefixed per OpenRouter's own model-id convention (its catalog
// spans many upstream vendors on one endpoint) — unlike the other four
// constants here, this id is meaningless without the vendor prefix.
export const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL ?? "openai/gpt-5.4-mini";

function modelIdFor(provider: LlmProvider): string {
  switch (provider) {
    case "groq":
      return GROQ_MODEL;
    case "openai":
      return OPENAI_MODEL;
    case "anthropic":
      return ANTHROPIC_MODEL;
    case "openrouter":
      return OPENROUTER_MODEL;
    case "gateway":
      return GATEWAY_MODEL;
  }
}

function providerInstanceFor(provider: LlmProvider) {
  switch (provider) {
    case "groq":
      return groq;
    case "openai":
      return openai;
    case "anthropic":
      return anthropic;
    case "openrouter":
      return openrouter;
    case "gateway":
      return gateway;
  }
}

/** Returns the active model instance to pass to `streamText`. `modelOverride`
 * (agent-frame.ts's llmModel) bypasses the env-configured default model id
 * for the resolved provider — e.g. a specific agent using `openai/gpt-5.4`
 * on the gateway while every other agent still defaults to the mini model. */
export function resolveVoiceModel(override?: LlmProvider, modelOverride?: string) {
  const provider = resolveLlmProvider(override);
  return providerInstanceFor(provider)(modelOverride || modelIdFor(provider));
}

/**
 * Cross-provider LLM failover (2026-07-17, recommendation #1 of
 * docs/product-infra-and-gtm-report.md Part 4). The AI Gateway (the `ai`
 * SDK's `createGateway`) already has native multi-model failover support —
 * https://vercel.com/docs/ai-gateway/models-and-providers/model-fallbacks —
 * so this is a config-shape helper, not a custom retry wrapper: pass a
 * `models` array via `providerOptions.gateway` and the gateway itself
 * retries against the next model on a failure, automatically. Only
 * meaningful when the resolved provider is "gateway" — Groq (this platform's
 * low-latency alternative provider) has no equivalent built-in multi-model
 * failover, so this is a no-op (empty providerOptions) for "groq" today.
 *
 * `override` here is the per-agent llmFallbackModels list (agent-frame.ts);
 * undefined falls back to the AI_GATEWAY_FALLBACK_MODELS env var (comma-
 * separated model ids), which is itself optional — with neither set, this
 * returns an empty providerOptions object and streamText behaves exactly as
 * it did before this feature existed (zero risk to the default path).
 */
export function buildGatewayProviderOptions(
  provider?: LlmProvider,
  override?: string[],
): { gateway: { models: string[] } } | undefined {
  if (resolveLlmProvider(provider) !== "gateway") return undefined;
  const fallbackModels =
    override && override.length > 0
      ? override
      : (process.env.AI_GATEWAY_FALLBACK_MODELS ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
  if (fallbackModels.length === 0) return undefined;
  return { gateway: { models: fallbackModels } };
}

/**
 * ADR-109 — the primary link of the transport chain, expressed in the same
 * shape as its fallbacks so the chain is homogeneous. Derived from exactly the
 * same inputs `resolveVoiceModel` uses, so the primary can never disagree with
 * the model actually instantiated.
 */
export function resolvePrimaryTransportLink(
  override?: LlmProvider,
  modelOverride?: string,
): LlmTransportLink {
  const provider = resolveLlmProvider(override);
  return {
    transport: provider,
    model: modelOverride || modelIdFor(provider),
  };
}

/** Instantiates the model for one link. The link's transport is authoritative
 * here — it must NOT be re-resolved from env, or a fallback link would be
 * silently served by the primary's transport. */
export function modelForTransportLink(link: LlmTransportLink) {
  return providerInstanceFor(link.transport)(link.model);
}

/**
 * ADR-109 — the label for the link that actually ran. Deliberately produces the
 * SAME `transport/model` shape as `getActiveModelLabel` below, so
 * `turn_latency.llm_provider_used` stays comparable across the cutover and no
 * dashboard has to learn a second format.
 */
export function formatActiveModelLabel(link: LlmTransportLink): string {
  return `${link.transport}/${link.model}`;
}

export function getActiveModelLabel(override?: LlmProvider, modelOverride?: string): string {
  const provider = resolveLlmProvider(override);
  const model = modelOverride || modelIdFor(provider);
  return `${provider}/${model}`;
}

/**
 * Rough per-provider $/token rates for the agent test-chat sandbox's cost
 * estimate (routes.ts, app/routes.ts) — NOT used for real billing, just a
 * "is this roughly cheap or expensive" signal shown next to each test
 * message. Previously hardcoded to a single OpenAI-mini-ish rate regardless
 * of which provider/model was actually active, which was flat wrong for
 * Groq. Groq rate is real
 * (llama-3.3-70b-versatile, groq.com/pricing as of mid-2026); gateway rate
 * is a rough gpt-4o-mini-class placeholder since AI_GATEWAY_MODEL can be
 * swapped to anything — update both if pricing drifts or the gateway
 * default model changes. `openai`/`anthropic`/`openrouter` (2026-08-27) are
 * the same kind of rough placeholder, priced to each provider's own
 * mini/haiku-class default model — update alongside OPENAI_MODEL/
 * ANTHROPIC_MODEL/OPENROUTER_MODEL if those defaults change.
 */
const LLM_PRICE_PER_MILLION_TOKENS: Record<LlmProvider, { input: number; output: number }> = {
  groq: { input: 0.59, output: 0.79 },
  gateway: { input: 0.15, output: 0.6 },
  openai: { input: 0.15, output: 0.6 },
  anthropic: { input: 0.8, output: 4.0 },
  openrouter: { input: 0.15, output: 0.6 },
};

export function estimateLlmCost(provider: LlmProvider, inputTokens: number, outputTokens: number): number {
  const rate = LLM_PRICE_PER_MILLION_TOKENS[provider];
  return (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;
}
