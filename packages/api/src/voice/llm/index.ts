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

/** Returns the active model instance to pass to `streamText`. */
export function resolveVoiceModel(override?: LlmProvider) {
  const provider = resolveLlmProvider(override);
  if (provider === "groq") return groq(GROQ_MODEL);
  return gateway(GATEWAY_MODEL);
}

export function getActiveModelLabel(override?: LlmProvider): string {
  const provider = resolveLlmProvider(override);
  return provider === "groq" ? `groq/${GROQ_MODEL}` : `gateway/${GATEWAY_MODEL}`;
}
