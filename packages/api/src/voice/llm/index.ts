import { createGroq } from "@ai-sdk/groq";
import { gateway, VOICE_AGENT_MODEL as GATEWAY_MODEL } from "../gateway";

export type LlmProvider = "gateway" | "groq";

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
 */
export function resolveLlmProvider(override?: LlmProvider): LlmProvider {
  const configured = (override ?? process.env.LLM_PROVIDER ?? "gateway").toLowerCase();
  if (configured === "gateway" || configured === "groq") return configured;
  console.warn(`[llm] Unknown LLM provider "${configured}" — falling back to "gateway"`);
  return "gateway";
}

const groq = createGroq({ apiKey: process.env.GROQ_API_KEY });

// Llama 3.3 70B is the commonly recommended Groq model for real-time voice
// agents — strong quality/latency tradeoff and native tool-calling support.
export const GROQ_MODEL = process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile";

/** Returns the active model instance to pass to `streamText`. `modelOverride`
 * (agent-frame.ts's llmModel) bypasses the env-configured default model id
 * for the resolved provider — e.g. a specific agent using `openai/gpt-5.4`
 * on the gateway while every other agent still defaults to the mini model. */
export function resolveVoiceModel(override?: LlmProvider, modelOverride?: string) {
  const provider = resolveLlmProvider(override);
  if (provider === "groq") return groq(modelOverride || GROQ_MODEL);
  return gateway(modelOverride || GATEWAY_MODEL);
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

export function getActiveModelLabel(override?: LlmProvider, modelOverride?: string): string {
  const provider = resolveLlmProvider(override);
  const model = modelOverride || (provider === "groq" ? GROQ_MODEL : GATEWAY_MODEL);
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
 * default model changes.
 */
const LLM_PRICE_PER_MILLION_TOKENS: Record<LlmProvider, { input: number; output: number }> = {
  groq: { input: 0.59, output: 0.79 },
  gateway: { input: 0.15, output: 0.6 },
};

export function estimateLlmCost(provider: LlmProvider, inputTokens: number, outputTokens: number): number {
  const rate = LLM_PRICE_PER_MILLION_TOKENS[provider];
  return (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;
}
