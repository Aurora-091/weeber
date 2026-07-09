import { resolveTtsProvider } from "./tts";
import { resolveLlmProvider } from "./llm";

/**
 * Boot-time config validation — fails loudly at startup if the *active*
 * providers are missing required env vars, instead of the failure only
 * surfacing mid-call as a cryptic runtime error. Only checks what's actually
 * in use (e.g. doesn't require CARTESIA_API_KEY if TTS_PROVIDER=elevenlabs).
 */
export function assertVoiceConfig(): void {
  const problems: string[] = [];

  const ttsProvider = resolveTtsProvider();
  if (ttsProvider === "cartesia") {
    if (!process.env.CARTESIA_API_KEY) problems.push("TTS_PROVIDER=cartesia requires CARTESIA_API_KEY");
    if (!process.env.CARTESIA_VOICE_ID) problems.push("TTS_PROVIDER=cartesia requires CARTESIA_VOICE_ID");
  }
  if (ttsProvider === "elevenlabs") {
    if (!process.env.ELEVENLABS_API_KEY) problems.push("TTS_PROVIDER=elevenlabs requires ELEVENLABS_API_KEY");
    if (!process.env.ELEVENLABS_VOICE_ID) problems.push("TTS_PROVIDER=elevenlabs requires ELEVENLABS_VOICE_ID");
  }

  const llmProvider = resolveLlmProvider();
  if (llmProvider === "groq" && !process.env.GROQ_API_KEY) {
    problems.push("LLM_PROVIDER=groq requires GROQ_API_KEY");
  }
  if (llmProvider === "gateway" && !process.env.AI_GATEWAY_API_KEY) {
    problems.push("LLM_PROVIDER=gateway (default) requires AI_GATEWAY_API_KEY");
  }

  if (!process.env.DEEPGRAM_API_KEY) problems.push("DEEPGRAM_API_KEY is required (speech-to-text)");
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    problems.push("TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required");
  }
  if (!process.env.PUBLIC_APP_URL) problems.push("PUBLIC_APP_URL is required (Twilio needs a public URL)");

  if (problems.length > 0) {
    console.error(
      `[config-check] Voice pipeline is missing required configuration:\n` +
        problems.map((p) => `  - ${p}`).join("\n") +
        `\nCalls will fail until these are set. Continuing to boot so /api/health stays reachable for diagnosis.`,
    );
  }
}
