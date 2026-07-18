// Shared types, constants, and form utilities for the agent config form.
// Used by both pages/app/agents.tsx (user) and pages/dashboard/agents.tsx (admin).
//
// IMPORTANT: AVAILABLE_TOOL_NAMES here must stay in sync with the backend's own
// list (packages/api/src/voice/agent-frame.ts) — this file only renders
// checkboxes for tools listed here, so a tool present on the backend but
// missing here can never be toggled on from the UI at all. If a merchant
// then saves ANY change to their agent's tool config through this form, the
// submitted toolsEnabled array silently omits that tool going forward (the
// backend's resolveAgentConfig prefers a saved org override over the
// template default once one exists) — exactly what happened here before
// this fix: confirmCodOrder/offerCartRecoveryDiscount were added to the
// backend list (agent-frame.ts, fixed 2026-07-16) but never mirrored here,
// so saving agent settings through the UI would have silently stripped
// those two tools from any org that touched this form, undoing that fix.

export const TONE_STYLES = ["friendly", "formal", "playful", "empathetic", "concise"] as const;
export const STRICTNESS_LEVELS = ["low", "medium", "high"] as const;
export const AVAILABLE_TOOL_NAMES = [
  "lookupInfo",
  "bookAppointment",
  "setDisposition",
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
export const RECOMMENDED_LLM_MODELS = [
  { provider: "gateway", model: "openai/gpt-5.4-mini", label: "GPT-5.4 Mini (balanced, gateway)" },
  { provider: "gateway", model: "google/gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite (cheapest/fastest, gateway)" },
  { provider: "gateway", model: "openai/gpt-5.4", label: "GPT-5.4 (strongest, gateway)" },
  { provider: "groq", model: "llama-3.3-70b-versatile", label: "Llama 3.3 70B (fastest overall, Groq)" },
] as const;
export const RECOMMENDED_LANGUAGES = [
  { code: "en", label: "English" },
  { code: "hi", label: "Hindi / Hinglish" },
  { code: "mr", label: "Marathi" },
  { code: "ta", label: "Tamil" },
  { code: "te", label: "Telugu" },
  { code: "kn", label: "Kannada" },
  { code: "ml", label: "Malayalam" },
  { code: "bn", label: "Bengali" },
  { code: "gu", label: "Gujarati" },
  { code: "pa", label: "Punjabi" },
  { code: "multi", label: "Multi (English + auto-detected other, Deepgram STT only)" },
] as const;

/**
 * Hindi/Hinglish voice support (2026-07-16, docs/hindi-hinglish-voice-support.md)
 * — live-verified provider pairing for code-switched Hindi/English calls.
 * ElevenLabs Scribe (STT) keeps English words in Latin script mid-sentence
 * automatically (confirmed with real Hinglish audio, not just marketing:
 * "मुझे एक flight book करनी है" transcribed back correctly with "flight"
 * intact), and ElevenLabs TTS is the pairing this pass tested end-to-end —
 * Deepgram's own "multi" mode has a real, reported bug misdetecting Hindi as
 * Spanish, and Sarvam's STT stayed on `mode: "transcribe"` for a long time
 * (now fixed to `codemix`, see the same doc) but ElevenLabs is the
 * more-tested default for this specific language. Returns null for every
 * other language — this is a Hindi-specific recommendation, not a general
 * "always prefer ElevenLabs" rule.
 */
export function getRecommendedVoiceStack(language: string): { sttProvider: string; voiceProvider: string } | null {
  if (language.trim().toLowerCase() !== "hi") return null;
  return { sttProvider: "elevenlabs", voiceProvider: "elevenlabs" };
}

/**
 * Real per-minute cost tiers (2026-07-17, docs/agents-ux-audit-and-cogs-2026-07-17.md) — surfaced
 * in the Voice tab so a provider choice isn't a cosmetic dropdown that happens to also be a real
 * unit-economics decision with zero visibility. STT providers are all roughly the same cost
 * bracket (~$0.004-0.007/min, sourced), so a single "$" tier for all three is honest, not
 * misleading. TTS has a real, large spread: Cartesia/Sarvam are both roughly $0.02-0.04/min
 * (estimated) vs. ElevenLabs at ~$0.10-0.12/min (sourced range) — a genuine 2.5-3x difference,
 * which is why TTS gets three distinct tiers and STT doesn't. `note` values mirror the audit
 * doc's confidence flags (estimated vs. sourced) rather than presenting a false-precision number.
 */
export const TTS_COST_TIERS: Record<string, { tier: "$" | "$" | "$$"; note: string }> = {
  cartesia: { tier: "$", note: "~$0.02-0.04/min (estimated)" },
  sarvam: { tier: "$", note: "~$0.003/min (estimated)" },
  elevenlabs: { tier: "$$", note: "~$0.10-0.12/min (sourced) — roughly 3x Cartesia/Sarvam" },
};

export const STT_COST_TIERS: Record<string, { tier: "$"; note: string }> = {
  deepgram: { tier: "$", note: "~$0.005/min (sourced)" },
  sarvam: { tier: "$", note: "~$0.006/min (sourced)" },
  elevenlabs: { tier: "$", note: "~$0.004-0.007/min (sourced) — similar bracket to the others" },
};

/**
 * Cross-provider failover config (2026-07-17, Phase 1 of the Agents UI/UX audit's P0 finding —
 * docs/agents-ux-audit-and-cogs-2026-07-17.md). Mirrors voice/failover.ts's own provider lists
 * and default chains — same deliberate duplication discipline as AVAILABLE_TOOL_NAMES above,
 * since packages/web and packages/api don't share a common package today.
 */
export const STT_PROVIDERS = ["deepgram", "sarvam", "elevenlabs"] as const;
export const TTS_PROVIDERS = ["cartesia", "elevenlabs", "sarvam"] as const;
export const STT_PROVIDER_LABELS: Record<string, string> = { deepgram: "Deepgram", sarvam: "Sarvam", elevenlabs: "ElevenLabs Scribe" };
export const TTS_PROVIDER_LABELS: Record<string, string> = { cartesia: "Cartesia", elevenlabs: "ElevenLabs", sarvam: "Sarvam" };
/** Mirrors voice/failover.ts's DEFAULT_STT_FALLBACK_ORDER/DEFAULT_TTS_FALLBACK_ORDER exactly. */
export const DEFAULT_STT_FALLBACK_ORDER = ["deepgram", "elevenlabs", "sarvam"] as const;
export const DEFAULT_TTS_FALLBACK_ORDER = ["cartesia", "elevenlabs", "sarvam"] as const;

export type AgentConfigRow = {
  templateKey: string;
  templateName: string;
  templateDescription: string | null;
  defaultPersonaPrompt: string | null;
  config: {
    name: string | null;
    greetingLine: string | null;
    closingLine: string | null;
    toneStyle: string | null;
    personaPrompt: string | null;
    voiceProvider: string | null;
    voiceId: string | null;
    language: string | null;
    sttProvider: string | null;
    llmProvider: string | null;
    llmModel: string | null;
    sttFallbackOrder: string[] | null;
    ttsFallbackOrder: string[] | null;
    llmFallbackModels: string[] | null;
    toolsEnabled: string[] | null;
    guardrails: {
      topicBoundaryStrictness?: string;
      injectionSensitivity?: string;
      abuseHandlingEnabled?: boolean;
    } | null;
    enabled: boolean;
    firstCallDelayMinutes: number | null;
    retryDelayMinutes: number | null;
    maxAttempts: number | null;
    phoneNumberId: number | null;
  } | null;
};

export type FormState = {
  name: string;
  greetingLine: string;
  closingLine: string;
  toneStyle: string;
  personaPrompt: string;
  voiceProvider: string;
  voiceId: string;
  language: string;
  sttProvider: string;
  llmProvider: string;
  llmModel: string;
  sttFallbackOrder: string[];
  ttsFallbackOrder: string[];
  llmFallbackModels: string[];
  toolsEnabled: string[];
  topicBoundaryStrictness: string;
  injectionSensitivity: string;
  abuseHandlingEnabled: boolean;
  enabled: boolean;
  firstCallDelayMinutes: string;
  retryDelayMinutes: string;
  maxAttempts: string;
};

export function toFormState(row: AgentConfigRow): FormState {
  const c = row.config;
  return {
    name: c?.name ?? "",
    greetingLine: c?.greetingLine ?? "",
    closingLine: c?.closingLine ?? "",
    toneStyle: c?.toneStyle ?? "",
    personaPrompt: c?.personaPrompt ?? "",
    voiceProvider: c?.voiceProvider ?? "cartesia",
    voiceId: c?.voiceId ?? "",
    language: c?.language ?? "",
    sttProvider: c?.sttProvider ?? "deepgram",
    llmProvider: c?.llmProvider ?? "gateway",
    llmModel: c?.llmModel ?? "",
    sttFallbackOrder: c?.sttFallbackOrder ?? [],
    ttsFallbackOrder: c?.ttsFallbackOrder ?? [],
    llmFallbackModels: c?.llmFallbackModels ?? [],
    toolsEnabled: c?.toolsEnabled ?? [...AVAILABLE_TOOL_NAMES],
    topicBoundaryStrictness: c?.guardrails?.topicBoundaryStrictness ?? "medium",
    injectionSensitivity: c?.guardrails?.injectionSensitivity ?? "medium",
    abuseHandlingEnabled: c?.guardrails?.abuseHandlingEnabled ?? true,
    enabled: c?.enabled ?? true,
    firstCallDelayMinutes: c?.firstCallDelayMinutes != null ? String(c.firstCallDelayMinutes) : "",
    retryDelayMinutes: c?.retryDelayMinutes != null ? String(c.retryDelayMinutes) : "",
    maxAttempts: c?.maxAttempts != null ? String(c.maxAttempts) : "",
  };
}

export function formToAgentFrame(form: FormState) {
  return {
    name: form.name || undefined,
    greetingLine: form.greetingLine || undefined,
    closingLine: form.closingLine || undefined,
    toneStyle: form.toneStyle || undefined,
    personaPrompt: form.personaPrompt || undefined,
    voiceProvider: form.voiceProvider,
    voiceId: form.voiceId || undefined,
    language: form.language || undefined,
    sttProvider: form.sttProvider,
    llmProvider: form.llmProvider,
    llmModel: form.llmModel || undefined,
    // Empty array and undefined are handled identically by the backend's
    // resolveSttFailoverChain/resolveTtsFailoverChain (voice/failover.ts) — both mean
    // "use the platform default chain" — so sending [] when nothing's customized is safe.
    sttFallbackOrder: form.sttFallbackOrder.length > 0 ? form.sttFallbackOrder : undefined,
    ttsFallbackOrder: form.ttsFallbackOrder.length > 0 ? form.ttsFallbackOrder : undefined,
    llmFallbackModels: form.llmFallbackModels.length > 0 ? form.llmFallbackModels : undefined,
    toolsEnabled: form.toolsEnabled,
    guardrails: {
      topicBoundaryStrictness: form.topicBoundaryStrictness,
      injectionSensitivity: form.injectionSensitivity,
      abuseHandlingEnabled: form.abuseHandlingEnabled,
    },
    enabled: form.enabled,
    firstCallDelayMinutes: form.firstCallDelayMinutes.trim() ? Number(form.firstCallDelayMinutes) : undefined,
    retryDelayMinutes: form.retryDelayMinutes.trim() ? Number(form.retryDelayMinutes) : undefined,
    maxAttempts: form.maxAttempts.trim() ? Number(form.maxAttempts) : undefined,
  };
}

export const fieldCls =
  "rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary/50 w-full transition-all duration-150";
export const labelCls = "block text-xs font-medium text-muted-foreground/90 mb-1.5 tracking-wide";
