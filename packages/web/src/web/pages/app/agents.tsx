import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, Play, Loader as Loader2, Settings2 } from "lucide-react";
import { toast } from "sonner";
import { appFetch } from "../../lib/user-session";
import { VoicePicker } from "../../components/voice/VoicePicker";
import { useUser } from "../../components/app/user-shell";
import { PageHeader } from "../../components/shell/page-header";
import { EmptyState } from "../../components/shell/empty-state";
import { SkeletonCards } from "../../components/shell/skeletons";
import { Switch } from "../../components/ui/switch";
import { PreviewButton } from "../../components/agent-preview/PreviewButton";
import { PreviewDrawer } from "../../components/agent-preview/PreviewDrawer";

/**
 * User agent config — the same "frame" form as the admin panel's
 * /dashboard/agents (voice/agent-frame.ts is the shared schema), re-scoped
 * to the session's own org: no org picker, /api/app endpoints, and the
 * model/provider knobs tucked behind an Advanced disclosure since users
 * shouldn't need to pick LLMs to get value.
 */

const TONE_STYLES = ["friendly", "formal", "playful", "empathetic", "concise"] as const;
const STRICTNESS_LEVELS = ["low", "medium", "high"] as const;
const AVAILABLE_TOOL_NAMES = [
  "lookupInfo",
  "bookAppointment",
  "setDisposition",
  "crmSync",
  "captureField",
  "hangUp",
  "transferToHuman",
  "flagGuardrailEvent",
] as const;
const RECOMMENDED_LLM_MODELS = [
  { provider: "gateway", model: "openai/gpt-5.4-mini", label: "GPT-5.4 Mini (balanced, gateway)" },
  { provider: "gateway", model: "google/gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite (cheapest/fastest, gateway)" },
  { provider: "gateway", model: "openai/gpt-5.4", label: "GPT-5.4 (strongest, gateway)" },
  { provider: "groq", model: "llama-3.3-70b-versatile", label: "Llama 3.3 70B (fastest overall, Groq)" },
] as const;
const RECOMMENDED_LANGUAGES = [
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

type AgentConfigRow = {
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
    guardrails: { topicBoundaryStrictness?: string; injectionSensitivity?: string; abuseHandlingEnabled?: boolean } | null;
    enabled: boolean;
    firstCallDelayMinutes: number | null;
    retryDelayMinutes: number | null;
    maxAttempts: number | null;
  } | null;
};

type FormState = {
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
  /** Empty string = "use the platform default" — kept as strings since these
   * are plain number inputs; parsed to number|undefined at submit time in
   * formToAgentFrame. */
  firstCallDelayMinutes: string;
  retryDelayMinutes: string;
  maxAttempts: string;
};

function toFormState(row: AgentConfigRow): FormState {
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

const fieldClass =
  "rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring/40 w-full transition-colors";
const labelClass = "block text-xs font-medium text-muted-foreground mb-1";

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-t border-border pt-5 pb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/60 first:border-t-0 first:pt-0">
      {children}
    </div>
  );
}

/** Same shape the PUT save mutation sends — the Preview drawer's configOverride
 * uses this identical conversion so "what you're previewing" and "what Save
 * would write" never drift apart. */
function formToAgentFrame(form: FormState) {
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

function AgentEditForm({ row }: { row: AgentConfigRow }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState>(() => toFormState(row));
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [previewState, setPreviewState] = useState<"idle" | "loading" | "error">("idle");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [previewDrawerOpen, setPreviewDrawerOpen] = useState(false);

  const save = useMutation({
    mutationFn: async () => {
      const res = await appFetch(`/api/app/agent-configs/${encodeURIComponent(row.templateKey)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formToAgentFrame(form)),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}) as { error?: string });
        throw new Error(body.error ?? `Failed (${res.status})`);
      }
      return res.json();
    },
    onSuccess: () => {
      setSaveError(null);
      queryClient.invalidateQueries({ queryKey: ["app-agent-configs"] });
      toast.success("Agent saved");
    },
    onError: (err: Error) => {
      setSaveError(err.message);
      toast.error("Failed to save", { description: err.message });
    },
  });

  async function playPreview() {
    setPreviewState("loading");
    setPreviewUrl(null);
    try {
      const text = form.greetingLine || "Hi there, thanks for calling — how can I help you today?";
      const res = await appFetch("/api/app/voice-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, voiceProvider: form.voiceProvider, voiceId: form.voiceId || undefined, language: form.language || undefined }),
      });
      if (!res.ok) throw new Error(`Preview failed (${res.status})`);
      const blob = await res.blob();
      setPreviewUrl(URL.createObjectURL(blob));
      setPreviewState("idle");
    } catch {
      setPreviewState("error");
      toast.error("Preview failed", { description: "Try a different voice, or try again in a minute." });
    }
  }

  /** Sends the current, in-progress form as configOverride — the backend
   * (buildPreviewAgentConfig, voice/agent.ts) builds the system prompt/voice/
   * LLM/tools straight from it instead of the saved DB row, so this really
   * tests what's on screen right now. */
  async function chatFetchFn(messages: { role: string; content: string }[]) {
    return appFetch(`/api/app/agent-configs/${encodeURIComponent(row.templateKey)}/test-chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, configOverride: formToAgentFrame(form) }),
    });
  }

  /** Issues a short-lived token for the Voice tab's live test call — same
   * configOverride contract as chatFetchFn, see test-call-tokens.ts. */
  async function testCallTokenFetchFn() {
    return appFetch(`/api/app/agent-configs/${encodeURIComponent(row.templateKey)}/test-call-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ configOverride: formToAgentFrame(form) }),
    });
  }

  function toggleTool(name: string) {
    setForm((f) => ({
      ...f,
      toolsEnabled: f.toolsEnabled.includes(name) ? f.toolsEnabled.filter((t) => t !== name) : [...f.toolsEnabled, name],
    }));
  }

  return (
    <div className="card-weeber space-y-5 p-6">
      <div className="flex justify-end">
        <PreviewButton onClick={() => setPreviewDrawerOpen(true)} />
      </div>
      <PreviewDrawer
        open={previewDrawerOpen}
        onOpenChange={setPreviewDrawerOpen}
        templateName={row.config?.name || row.templateName}
        chatFetchFn={chatFetchFn}
        testCallTokenFetchFn={testCallTokenFetchFn}
        previewState={previewState}
        previewUrl={previewUrl}
        onPlayPreview={playPreview}
      />

      {/* Identity & Tone */}
      <SectionHeader>Identity &amp; Tone</SectionHeader>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor={`name-${row.templateKey}`} className={labelClass}>Agent name</label>
          <input
            id={`name-${row.templateKey}`}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="e.g. Aria"
            className={fieldClass}
          />
        </div>
        <div>
          <label htmlFor={`tone-${row.templateKey}`} className={labelClass}>Tone</label>
          <select
            id={`tone-${row.templateKey}`}
            value={form.toneStyle}
            onChange={(e) => setForm({ ...form, toneStyle: e.target.value })}
            className={fieldClass}
          >
            <option value="">Default</option>
            {TONE_STYLES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor={`greeting-${row.templateKey}`} className={labelClass}>Greeting line</label>
          <input
            id={`greeting-${row.templateKey}`}
            value={form.greetingLine}
            onChange={(e) => setForm({ ...form, greetingLine: e.target.value })}
            placeholder="Hi, thanks for calling — how can I help?"
            className={fieldClass}
          />
        </div>
        <div>
          <label htmlFor={`closing-${row.templateKey}`} className={labelClass}>Closing line</label>
          <input
            id={`closing-${row.templateKey}`}
            value={form.closingLine}
            onChange={(e) => setForm({ ...form, closingLine: e.target.value })}
            placeholder="Thanks for calling, have a great day!"
            className={fieldClass}
          />
        </div>
      </div>

      <div>
        <label htmlFor={`persona-${row.templateKey}`} className={labelClass}>
          What should this agent say and do? (leave blank for the recommended script)
        </label>
        <textarea
          id={`persona-${row.templateKey}`}
          value={form.personaPrompt}
          onChange={(e) => setForm({ ...form, personaPrompt: e.target.value })}
          rows={4}
          placeholder={row.defaultPersonaPrompt ?? ""}
          className={`${fieldClass} font-mono text-xs`}
        />
      </div>

      {/* Voice & Sound */}
      <SectionHeader>Voice &amp; Sound</SectionHeader>

      <div className="grid items-end gap-4 sm:grid-cols-3">
        <div>
          <label htmlFor={`voice-provider-${row.templateKey}`} className={labelClass}>Voice provider</label>
          <select
            id={`voice-provider-${row.templateKey}`}
            value={form.voiceProvider}
            onChange={(e) => setForm({ ...form, voiceProvider: e.target.value })}
            className={fieldClass}
          >
            <option value="cartesia">Cartesia</option>
            <option value="elevenlabs">ElevenLabs</option>
            <option value="sarvam">Sarvam (Indian-language voices)</option>
          </select>
        </div>
        <div>
          <label className={labelClass}>Voice</label>
          <VoicePicker
            provider={form.voiceProvider}
            value={form.voiceId}
            language={form.language}
            onChange={(voiceId) => setForm({ ...form, voiceId })}
            scope="user"
            previewText="Hi, this is Weeber. I can help with bookings, cart recovery, and follow-ups."
          />
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={playPreview}
            disabled={previewState === "loading"}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm transition-colors hover:bg-muted disabled:opacity-50"
          >
            {previewState === "loading" ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
            Hear it
          </button>
          {previewUrl && (
            // eslint-disable-next-line jsx-a11y/media-has-caption -- synthesized TTS preview, no source track to caption
            <audio controls src={previewUrl} className="h-9" aria-label="Voice preview playback" />
          )}
        </div>
      </div>
      {previewState === "error" && (
        <p className="text-xs text-destructive">Preview failed — try a different voice, or try again in a minute.</p>
      )}

      <div>
        <button
          type="button"
          onClick={() => setAdvancedOpen(!advancedOpen)}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
          aria-expanded={advancedOpen}
        >
          <Settings2 className="size-3.5" aria-hidden />
          Advanced settings
          {advancedOpen ? <ChevronUp className="size-3.5" aria-hidden /> : <ChevronDown className="size-3.5" aria-hidden />}
        </button>
        {advancedOpen && (
          <div className="mt-4 space-y-5 border-t border-border/50 pt-4">
            {/* Capabilities */}
            <SectionHeader>Capabilities</SectionHeader>
            <div>
              <span className={labelClass}>Abilities (hangUp always stays available)</span>
              <div className="flex flex-wrap gap-3">
                {AVAILABLE_TOOL_NAMES.map((name) => (
                  <label key={name} className="flex items-center gap-1.5 text-sm">
                    <input
                      type="checkbox"
                      aria-label={name}
                      checked={name === "hangUp" || form.toolsEnabled.includes(name)}
                      disabled={name === "hangUp"}
                      onChange={() => toggleTool(name)}
                      className="accent-primary"
                    />
                    <span className="font-mono text-xs">{name}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* Safety Guardrails */}
            <SectionHeader>Safety Guardrails</SectionHeader>
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <label htmlFor={`topic-strictness-${row.templateKey}`} className={labelClass}>Stay-on-topic strictness</label>
                <select
                  id={`topic-strictness-${row.templateKey}`}
                  value={form.topicBoundaryStrictness}
                  onChange={(e) => setForm({ ...form, topicBoundaryStrictness: e.target.value })}
                  className={fieldClass}
                >
                  {STRICTNESS_LEVELS.map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor={`injection-sensitivity-${row.templateKey}`} className={labelClass}>Manipulation sensitivity</label>
                <select
                  id={`injection-sensitivity-${row.templateKey}`}
                  value={form.injectionSensitivity}
                  onChange={(e) => setForm({ ...form, injectionSensitivity: e.target.value })}
                  className={fieldClass}
                >
                  {STRICTNESS_LEVELS.map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-end pb-2">
                <label className="flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    aria-label="End call on sustained abuse"
                    checked={form.abuseHandlingEnabled}
                    onChange={(e) => setForm({ ...form, abuseHandlingEnabled: e.target.checked })}
                    className="accent-primary"
                  />
                  End call on sustained abuse
                </label>
              </div>
            </div>

            {/* Retry cadence — per-org override, empty = platform default */}
            <SectionHeader>Retry cadence</SectionHeader>
            <p className="text-xs text-muted-foreground -mt-1">
              Leave any field blank to use the platform default. Max attempts is capped at 20 either way.
            </p>
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <label htmlFor={`first-call-delay-${row.templateKey}`} className={labelClass}>
                  Delay before first call (minutes)
                </label>
                <input
                  id={`first-call-delay-${row.templateKey}`}
                  type="number"
                  min={0}
                  max={43200}
                  value={form.firstCallDelayMinutes}
                  onChange={(e) => setForm({ ...form, firstCallDelayMinutes: e.target.value })}
                  placeholder="Platform default"
                  className={fieldClass}
                />
              </div>
              <div>
                <label htmlFor={`retry-delay-${row.templateKey}`} className={labelClass}>
                  Delay between retries (minutes)
                </label>
                <input
                  id={`retry-delay-${row.templateKey}`}
                  type="number"
                  min={0}
                  max={43200}
                  value={form.retryDelayMinutes}
                  onChange={(e) => setForm({ ...form, retryDelayMinutes: e.target.value })}
                  placeholder="Platform default"
                  className={fieldClass}
                />
              </div>
              <div>
                <label htmlFor={`max-attempts-${row.templateKey}`} className={labelClass}>
                  Max attempts (1–20)
                </label>
                <input
                  id={`max-attempts-${row.templateKey}`}
                  type="number"
                  min={1}
                  max={20}
                  value={form.maxAttempts}
                  onChange={(e) => setForm({ ...form, maxAttempts: e.target.value })}
                  placeholder="Platform default"
                  className={fieldClass}
                />
              </div>
            </div>

            {/* Provider / Model */}
            <SectionHeader>Provider &amp; Model</SectionHeader>
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <label htmlFor={`language-${row.templateKey}`} className={labelClass}>Language</label>
                <input
                  id={`language-${row.templateKey}`}
                  value={form.language}
                  onChange={(e) => setForm({ ...form, language: e.target.value })}
                  placeholder="en, hi, mr, ta…"
                  list={`languages-${row.templateKey}`}
                  className={fieldClass}
                />
                <datalist id={`languages-${row.templateKey}`}>
                  {RECOMMENDED_LANGUAGES.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.label}
                    </option>
                  ))}
                </datalist>
              </div>
              <div>
                <label htmlFor={`stt-provider-${row.templateKey}`} className={labelClass}>Speech-to-text provider</label>
                <select
                  id={`stt-provider-${row.templateKey}`}
                  value={form.sttProvider}
                  onChange={(e) => setForm({ ...form, sttProvider: e.target.value })}
                  className={fieldClass}
                >
                  <option value="deepgram">Deepgram</option>
                  <option value="sarvam">Sarvam (Indian-language STT)</option>
                </select>
              </div>
              <div>
                <label htmlFor={`llm-provider-${row.templateKey}`} className={labelClass}>LLM provider</label>
                <select
                  id={`llm-provider-${row.templateKey}`}
                  value={form.llmProvider}
                  onChange={(e) => setForm({ ...form, llmProvider: e.target.value })}
                  className={fieldClass}
                >
                  <option value="gateway">AI Gateway</option>
                  <option value="groq">Groq</option>
                </select>
              </div>
              <div>
                <label htmlFor={`llm-model-${row.templateKey}`} className={labelClass}>Model</label>
                <input
                  id={`llm-model-${row.templateKey}`}
                  value={form.llmModel}
                  onChange={(e) => setForm({ ...form, llmModel: e.target.value })}
                  placeholder="leave blank for the default"
                  list={`models-${row.templateKey}`}
                  className={fieldClass}
                />
                <datalist id={`models-${row.templateKey}`}>
                  {RECOMMENDED_LLM_MODELS.filter((m) => m.provider === form.llmProvider).map((m) => (
                    <option key={m.model} value={m.model}>
                      {m.label}
                    </option>
                  ))}
                </datalist>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center gap-3 pt-2">
        <label className="flex items-center gap-2 text-sm">
          <Switch
            checked={form.enabled}
            onCheckedChange={(checked) => setForm({ ...form, enabled: !!checked })}
            aria-label="Agent enabled"
          />
          Agent enabled
        </label>
        <button
          onClick={() => save.mutate()}
          disabled={save.isPending}
          className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-all hover:bg-primary/90 disabled:opacity-50 active:scale-[0.97]"
        >
          {save.isPending ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : save.isSuccess && !saveError ? (
            <svg className="size-3.5 text-success" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 8l3.5 3.5L13 4.5"/></svg>
          ) : null}
          {save.isSuccess && !saveError ? "Saved" : "Save"}
        </button>
      </div>
      {saveError && <p className="mt-1 text-xs text-destructive">{saveError}</p>}
    </div>
  );
}

export function UserAgentsPage() {
  const { vertical } = useUser();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const configs = useQuery({
    queryKey: ["app-agent-configs"],
    queryFn: async () => {
      const res = await appFetch("/api/app/agent-configs");
      if (!res.ok) throw new Error(`configs failed (${res.status})`);
      return (await res.json()) as { agentConfigs: AgentConfigRow[] };
    },
  });
  const rows = configs.data?.agentConfigs ?? [];
  const activeRow = rows.find((r) => r.templateKey === selectedKey) ?? rows[0] ?? null;

  const firstKey = rows[0]?.templateKey ?? null;
  useEffect(() => {
    if (!selectedKey && firstKey) {
      setSelectedKey(firstKey);
    }
  }, [selectedKey, firstKey]);

  return (
    <div className="page-enter">
      {/* Agent switcher pill — only when multiple agents exist */}
      {rows.length > 1 && activeRow && (
        <div className="mb-5 flex items-center gap-3 flex-wrap">
          <select
            value={activeRow.templateKey}
            onChange={(e) => setSelectedKey(e.target.value)}
            className="rounded-full border border-border bg-card px-4 py-1.5 text-sm font-medium shadow-xs transition-colors focus:ring-2 focus:ring-ring/40 focus:outline-none cursor-pointer"
          >
            {rows.map((r) => (
              <option key={r.templateKey} value={r.templateKey}>
                {r.config?.name || r.templateName}
              </option>
            ))}
          </select>
          {activeRow.templateDescription && (
            <span className="text-xs text-muted-foreground">
              {activeRow.templateDescription}
            </span>
          )}
        </div>
      )}

      <PageHeader
        title={rows.length === 1 && activeRow ? (activeRow.config?.name || activeRow.templateName) : "Agents"}
        description={rows.length === 1 && activeRow
          ? (activeRow.templateDescription || "Tune how this agent sounds and what it says.")
          : "Tune how each agent sounds and what it says. Changes apply from the next call."}
      />

      {configs.isLoading && <SkeletonCards count={3} lines={2} />}

      {!configs.isLoading && rows.length === 0 && (
        <EmptyState
          title="No agents available yet"
          description={`Agents appear here once your ${vertical.integrationLabel} store is connected.`}
        />
      )}

      {activeRow && (
        <div key={activeRow.templateKey} className="content-fade-in">
          <AgentEditForm row={activeRow} />
        </div>
      )}
    </div>
  );
}
