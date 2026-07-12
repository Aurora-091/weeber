import { createGroq } from "@ai-sdk/groq";
import { gateway, VOICE_AGENT_MODEL as GATEWAY_MODEL } from "../gateway";

export type LlmProvider = "gateway" | "groq";

/**
 * LLM provider registry, mirroring the TTS provider split (see ../tts/).
 * Swap the active provider via LLM_PROVIDER — no code changes needed.
 * Groq's LPU inference is dramatically faster than typical GPU-hosted models,
 * and since LLM inference is usually the single biggest latency contributor
 * in a voice pipeline, this is the highest-leverage latency lever available.
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
const GROQ_MODEL = process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile";

/** Returns the active model instance to pass to `streamText`. `modelOverride`
 * (agent-frame.ts's llmModel) bypasses the env-configured default model id
 * for the resolved provider — e.g. a specific agent using `openai/gpt-5.4`
 * on the gateway while every other agent still defaults to the mini model. */
export function resolveVoiceModel(override?: LlmProvider, modelOverride?: string) {
  const provider = resolveLlmProvider(override);
  if (provider === "groq") return groq(modelOverride || GROQ_MODEL);
  return gateway(modelOverride || GATEWAY_MODEL);
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
 * Groq (this env's actual default — see /api/health). Groq rate is real
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
