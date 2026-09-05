import { gateway, VOICE_AGENT_MODEL as GATEWAY_MODEL } from "../gateway";

export type LlmProvider = "gateway";

/**
 * LLM provider registry, mirroring the TTS provider split (see ../tts/).
 * The platform default is LLM_PROVIDER; an individual agent overrides it with
 * org_agent_configs.llm_provider + llm_model (agent-frame.ts), so "which LLM"
 * is a per-agent choice and the env var is only the fallback default.
 *
 * Groq (a second, direct transport) was removed 2026-09-04 — see the ADR
 * superseding ADR-005 and ADR-109. "gateway" is the only provider now; this
 * still fails open on an unrecognized value (e.g. a stale "groq" left in an
 * old org_agent_configs row) rather than throwing, matching every other
 * per-agent override in this codebase.
 */
export function resolveLlmProvider(override?: LlmProvider): LlmProvider {
  const configured = (override ?? process.env.LLM_PROVIDER ?? "gateway").toLowerCase();
  if (configured === "gateway") return configured;
  console.warn(`[llm] Unknown LLM provider "${configured}" — falling back to "gateway"`);
  return "gateway";
}

/** Returns the active model instance to pass to `streamText`. `modelOverride`
 * (agent-frame.ts's llmModel) bypasses the env-configured default model id
 * for the resolved provider — e.g. a specific agent using `openai/gpt-5.4`
 * on the gateway while every other agent still defaults to the mini model. */
export function resolveVoiceModel(override?: LlmProvider, modelOverride?: string) {
  resolveLlmProvider(override);
  return gateway(modelOverride || GATEWAY_MODEL);
}

/**
 * Cross-provider LLM failover (2026-07-17, recommendation #1 of
 * docs/product-infra-and-gtm-report.md Part 4). The AI Gateway (the `ai`
 * SDK's `createGateway`) already has native multi-model failover support —
 * https://vercel.com/docs/ai-gateway/models-and-providers/model-fallbacks —
 * so this is a config-shape helper, not a custom retry wrapper: pass a
 * `models` array via `providerOptions.gateway` and the gateway itself
 * retries against the next model on a failure, automatically.
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
  resolveLlmProvider(provider);
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
  const model = modelOverride || GATEWAY_MODEL;
  return `${provider}/${model}`;
}

/**
 * Rough per-provider $/token rate for the agent test-chat sandbox's cost
 * estimate (routes.ts, app/routes.ts) — NOT used for real billing, just a
 * "is this roughly cheap or expensive" signal shown next to each test
 * message. A rough gpt-4o-mini-class placeholder since AI_GATEWAY_MODEL can
 * be swapped to anything — update if pricing drifts or the gateway default
 * model changes.
 */
const LLM_PRICE_PER_MILLION_TOKENS: Record<LlmProvider, { input: number; output: number }> = {
  gateway: { input: 0.15, output: 0.6 },
};

export function estimateLlmCost(provider: LlmProvider, inputTokens: number, outputTokens: number): number {
  const rate = LLM_PRICE_PER_MILLION_TOKENS[provider];
  return (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;
}
