import z from "zod";

/**
 * The agent "frame" — the fixed, structured set of fields a user (or
 * later, an AI agent-builder prompt) configures per agent. This is the
 * contract: a future "describe the agent you want" flow plugs values into
 * exactly this shape rather than inventing new fields, new tables, or new
 * prompt-assembly code. Keep this file as the single source of truth for
 * what's configurable — the dashboard form, the API validation, and any
 * future AI builder should all import from here, not redefine the shape.
 */

/** Every tool a call can be given — see voice/tools/. `hangUp` is always
 * available regardless of what's selected here (see agent.ts) — ending a
 * call gracefully is a safety default, not an optional feature. */
export const AVAILABLE_TOOL_NAMES = [
  "lookupInfo",
  "bookAppointment",
  "setDisposition",
  "setIntent",
  "crmSync",
  "captureField",
  "hangUp",
  "transferToHuman",
  "flagGuardrailEvent",
  "sendSms",
  "sendDtmf",
  "confirmCodOrder",
  "offerCartRecoveryDiscount",
] as const;

export type AvailableToolName = (typeof AVAILABLE_TOOL_NAMES)[number];

/** Curated starting points, not an exhaustive/enforced list — llmModel and
 * voiceId both accept free text too, so a new gateway model or a new
 * provider voice doesn't need a code change to use. */
export const RECOMMENDED_LLM_MODELS = [
  { provider: "gateway" as const, model: "openai/gpt-5.4-mini", label: "GPT-5.4 Mini (balanced, gateway)" },
  { provider: "gateway" as const, model: "google/gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite (cheapest/fastest, gateway)" },
  { provider: "gateway" as const, model: "openai/gpt-5.4", label: "GPT-5.4 (strongest, gateway)" },
  { provider: "groq" as const, model: "llama-3.3-70b-versatile", label: "Llama 3.3 70B (fastest overall, Groq)" },
];

export const TONE_STYLES = ["friendly", "formal", "playful", "empathetic", "concise"] as const;
export type ToneStyle = (typeof TONE_STYLES)[number];

/** Curated starting points for `language`, not an exhaustive/enforced list —
 * the field accepts free text too, so a language neither provider has
 * explicit support for yet doesn't need a code change to try. Codes are
 * plain ISO 639-1 (no region suffix) — each provider adapter (see
 * stt/deepgram.ts, stt/sarvam.ts, tts/sarvam.ts) normalizes into whatever
 * format it actually needs, so the frame itself stays provider-agnostic.
 * India-first list since that's the primary market; "multi" is Deepgram's
 * English+one-other code-switching mode (STT only — Sarvam has no
 * equivalent single "auto" TTS voice, so pick a specific language for TTS
 * even when STT is set to "multi"). */
export const RECOMMENDED_LANGUAGES = [
  { code: "en", label: "English" },
  { code: "hi", label: "Hindi" },
  { code: "mr", label: "Marathi" },
  { code: "ta", label: "Tamil" },
  { code: "te", label: "Telugu" },
  { code: "kn", label: "Kannada" },
  { code: "ml", label: "Malayalam" },
  { code: "bn", label: "Bengali" },
  { code: "gu", label: "Gujarati" },
  { code: "pa", label: "Punjabi" },
  { code: "hinglish", label: "Hinglish (Hindi-English code-mix)" },
  { code: "multi", label: "Multi (English + auto-detected other, Deepgram STT only)" },
] as const;

/** Languages for which Sarvam (India-specialized STT/TTS) is the smart default
 * provider when the agent hasn't explicitly picked one. The platform-wide
 * defaults are English-first — Deepgram for STT, Cartesia for TTS — and weaker
 * on Indic speech recognition and natural Indic voices, so picking one of these
 * languages alone (without also choosing a provider) used to leave the call on
 * an English-first provider that may fumble it. `prefersSarvam()` closes that
 * gap: an Indic-language agent with no explicit provider routes to Sarvam, but
 * only when a SARVAM_API_KEY is actually configured (see resolveSttProvider /
 * resolveTtsProvider) so self-hosted setups without one fall back cleanly.
 * Mirrors RECOMMENDED_LANGUAGES minus "en" (English) and "multi" (code-switching,
 * handled by each provider's own multi/codemix mode, not a fixed language). */
// "hinglish" is included so a Hinglish agent with no explicit provider routes to
// Sarvam (its Hindi voice renders the code-mix best; toSarvamLanguageCode maps
// hinglish → hi-IN). It has no separate Sarvam language code of its own.
export const SARVAM_PREFERRED_LANGUAGES = ["hi", "hinglish", "mr", "ta", "te", "kn", "ml", "bn", "gu", "pa"] as const;

export function prefersSarvam(language?: string | null): boolean {
  return !!language && (SARVAM_PREFERRED_LANGUAGES as readonly string[]).includes(language.toLowerCase());
}

export const STRICTNESS_LEVELS = ["low", "medium", "high"] as const;
export type StrictnessLevel = (typeof STRICTNESS_LEVELS)[number];

export const GuardrailSettingsSchema = z.object({
  topicBoundaryStrictness: z.enum(STRICTNESS_LEVELS).optional(),
  injectionSensitivity: z.enum(STRICTNESS_LEVELS).optional(),
  abuseHandlingEnabled: z.boolean().optional(),
});
export type GuardrailSettings = z.infer<typeof GuardrailSettingsSchema>;

/** Every field optional/nullable — an agent with none of these set falls
 * through to template defaults + global env-configured voice/LLM, exactly
 * as it behaved before the frame existed (see agent.ts's resolveAgentConfig). */
export const AgentFrameSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  greetingLine: z.string().min(1).max(500).optional(),
  closingLine: z.string().min(1).max(500).optional(),
  toneStyle: z.enum(TONE_STYLES).optional(),
  personaPrompt: z.string().min(1).max(8000).optional(),
  voiceProvider: z.enum(["elevenlabs", "cartesia", "sarvam"]).optional(),
  voiceId: z.string().min(1).max(200).optional(),
  /** Free text (see RECOMMENDED_LANGUAGES above for curated options) — one
   * language drives both STT and TTS for the call. India has many more
   * languages than any single provider covers well, so this deliberately
   * isn't a closed enum at the schema level. */
  language: z.string().min(2).max(20).optional(),
  /** STT provider — separate from voiceProvider (TTS) since the best STT
   * and TTS choice for a given language don't have to be the same vendor,
   * e.g. Deepgram STT (fast, English-strong) + Sarvam TTS (natural Hindi
   * voice) for a Hindi-first agent. Defaults to "deepgram" when unset. */
  sttProvider: z.enum(["deepgram", "sarvam", "elevenlabs"]).optional(),
  llmProvider: z.enum(["gateway", "groq"]).optional(),
  llmModel: z.string().min(1).max(200).optional(),
  /** Cross-provider failover (2026-07-17) — per-agent override of the
   * ordered list of providers tried after sttProvider/voiceProvider above
   * hard-fails mid-call. Unset = platform default chain (see
   * voice/failover.ts). Not a closed enum here (validated/filtered at
   * resolve time in failover.ts) so an unrecognized value fails open
   * instead of rejecting the whole config save. */
  sttFallbackOrder: z.array(z.string()).max(3).optional(),
  ttsFallbackOrder: z.array(z.string()).max(3).optional(),
  /** AI Gateway model ids to add as fallbacks alongside llmModel above
   * (fed into providerOptions.gateway.models — see voice/llm/index.ts).
   * Unset = AI_GATEWAY_FALLBACK_MODELS env var (platform default). */
  llmFallbackModels: z.array(z.string()).max(5).optional(),
  toolsEnabled: z.array(z.enum(AVAILABLE_TOOL_NAMES)).optional(),
  guardrails: GuardrailSettingsSchema.optional(),
  enabled: z.boolean().optional(),
  /**
   * Per-org retry cadence overrides (issue 3 feature) — see
   * voice/retry-config.ts for the resolution logic and platform defaults.
   * Unset = use the platform default. maxAttempts capped at 20 — the
   * cap exists specifically so this can't be configured into an
   * effectively-unlimited or abusive call volume ("he can't call 100
   * times").
   */
  firstCallDelayMinutes: z.number().int().min(0).max(43200).optional(),
  retryDelayMinutes: z.number().int().min(0).max(43200).optional(),
  maxAttempts: z.number().int().min(1).max(20).optional(),
});
export type AgentFrame = z.infer<typeof AgentFrameSchema>;
