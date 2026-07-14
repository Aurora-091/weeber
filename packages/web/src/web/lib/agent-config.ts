// Shared types, constants, and form utilities for the agent config form.
// Used by both pages/app/agents.tsx (user) and pages/dashboard/agents.tsx (admin).

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
] as const;
export const RECOMMENDED_LLM_MODELS = [
  { provider: "gateway", model: "openai/gpt-5.4-mini", label: "GPT-5.4 Mini (balanced, gateway)" },
  { provider: "gateway", model: "google/gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite (cheapest/fastest, gateway)" },
  { provider: "gateway", model: "openai/gpt-5.4", label: "GPT-5.4 (strongest, gateway)" },
  { provider: "groq", model: "llama-3.3-70b-versatile", label: "Llama 3.3 70B (fastest overall, Groq)" },
] as const;
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
  { code: "multi", label: "Multi (English + auto-detected other, Deepgram STT only)" },
] as const;

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
  "rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring/40 w-full transition-colors";
export const labelCls = "block text-xs font-medium text-muted-foreground mb-1";
