import { resolveTtsProvider } from "./tts";
import { resolveSttProvider } from "./stt";
import { resolveLlmProvider } from "./llm";
import { DEFAULT_STT_FALLBACK_ORDER, DEFAULT_TTS_FALLBACK_ORDER } from "./failover";

/** Which env var(s) let a provider connect at all. Deepgram and Cartesia are
 * TTS-or-STT-specific; ElevenLabs and Sarvam use one account key for both. */
const PROVIDER_API_KEY_ENV: Record<string, string[]> = {
  deepgram: ["DEEPGRAM_API_KEY"],
  cartesia: ["CARTESIA_API_KEY"],
  elevenlabs: ["ELEVENLABS_API_KEY"],
  sarvam: ["SARVAM_API_KEY"],
};

/**
 * Boot-time config validation — fails loudly at startup if the *active*
 * providers are missing required env vars, instead of the failure only
 * surfacing mid-call as a cryptic runtime error. Only checks what's actually
 * in use (e.g. doesn't require CARTESIA_API_KEY if TTS_PROVIDER=elevenlabs).
 */
export function assertVoiceConfig(): void {
  const problems: string[] = [];

  // Voice IDs are deliberately absent from this check: a voice is an agent
  // property (org_agent_configs.voice_provider + voice_id), with a per-provider
  // code constant underneath it — see tts/default-voices.ts. There is no
  // <PROVIDER>_VOICE_ID env var to validate, and a missing constant is a
  // typecheck failure rather than a runtime one.
  const ttsProvider = resolveTtsProvider();
  if (ttsProvider === "cartesia" && !process.env.CARTESIA_API_KEY) {
    problems.push("TTS_PROVIDER=cartesia requires CARTESIA_API_KEY");
  }
  if (ttsProvider === "elevenlabs" && !process.env.ELEVENLABS_API_KEY) {
    problems.push("TTS_PROVIDER=elevenlabs requires ELEVENLABS_API_KEY");
  }
  if (ttsProvider === "sarvam" && !process.env.SARVAM_API_KEY) {
    problems.push("TTS_PROVIDER=sarvam requires SARVAM_API_KEY");
  }

  const sttProvider = resolveSttProvider();
  if (sttProvider === "sarvam" && !process.env.SARVAM_API_KEY) {
    problems.push("STT_PROVIDER=sarvam requires SARVAM_API_KEY");
  }

  const llmProvider = resolveLlmProvider();
  if (llmProvider === "gateway" && !process.env.AI_GATEWAY_API_KEY) {
    problems.push("LLM_PROVIDER=gateway (default) requires AI_GATEWAY_API_KEY");
  }

  if (sttProvider === "deepgram" && !process.env.DEEPGRAM_API_KEY) {
    problems.push("STT_PROVIDER=deepgram (default) requires DEEPGRAM_API_KEY");
  }
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    problems.push("TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required");
  }
  if (!process.env.PUBLIC_APP_URL) problems.push("PUBLIC_APP_URL is required (Twilio needs a public URL)");

  // Dead failover legs. Every call gets DEFAULT_{STT,TTS}_FALLBACK_ORDER unless
  // its agent row overrides it, so a provider in that chain without an API key
  // is a leg that is guaranteed to fail the moment it's actually needed — i.e.
  // during an incident, which is the worst possible time to discover it. Not a
  // `problem`: the primary path still works and calls still connect, so this
  // must not read as "calls will fail".
  const deadLegs: string[] = [];
  for (const p of DEFAULT_TTS_FALLBACK_ORDER) {
    if (p !== ttsProvider && !PROVIDER_API_KEY_ENV[p].some((k) => process.env[k])) {
      deadLegs.push(`TTS failover leg "${p}" has no ${PROVIDER_API_KEY_ENV[p].join("/")} — it will fail if reached`);
    }
  }
  for (const p of DEFAULT_STT_FALLBACK_ORDER) {
    if (p !== sttProvider && !PROVIDER_API_KEY_ENV[p].some((k) => process.env[k])) {
      deadLegs.push(`STT failover leg "${p}" has no ${PROVIDER_API_KEY_ENV[p].join("/")} — it will fail if reached`);
    }
  }
  if (deadLegs.length > 0) {
    console.warn(
      `[config-check] Configured provider failover chains contain legs that cannot connect:\n` +
        deadLegs.map((p) => `  - ${p}`).join("\n") +
        `\nThe primary provider still works; these only bite during a mid-call provider failure.`,
    );
  }

  if (problems.length > 0) {
    console.error(
      `[config-check] Voice pipeline is missing required configuration:\n` +
        problems.map((p) => `  - ${p}`).join("\n") +
        `\nCalls will fail until these are set. Continuing to boot so /api/health stays reachable for diagnosis.`,
    );
  }
}
