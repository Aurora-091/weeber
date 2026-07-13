import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Bot, ChevronDown, ChevronUp, Play, Loader as Loader2 } from "lucide-react";
import { api, apiFetch } from "../../lib/api";
import { adminHeaders, getAdminKey } from "../../lib/admin-key";
import { VoicePicker } from "../../components/voice/VoicePicker";
import { useSelectedOrgId } from "../../lib/org-id";
import { PreviewButton } from "../../components/agent-preview/PreviewButton";
import { PreviewDrawer } from "../../components/agent-preview/PreviewDrawer";

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
  "sendSms",
  "sendDtmf",
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

function selectClass() {
  return "rounded-md border border-border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring/40 w-full";
}
function inputClass() {
  return "rounded-md border border-border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring/40 w-full";
}
function labelClass() {
  return "block text-xs font-medium text-muted-foreground mb-1";
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

function AgentEditForm({ orgId, row }: { orgId: string; row: AgentConfigRow }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState>(() => toFormState(row));
  const [previewState, setPreviewState] = useState<"idle" | "loading" | "error">("idle");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [previewDrawerOpen, setPreviewDrawerOpen] = useState(false);

  const save = useMutation({
    mutationFn: async () => {
      const res = await apiFetch(`/api/voice/orgs/${encodeURIComponent(orgId)}/agent-configs/${encodeURIComponent(row.templateKey)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...adminHeaders() },
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
      queryClient.invalidateQueries({ queryKey: ["agent-configs", orgId] });
    },
    onError: (err: Error) => setSaveError(err.message),
  });

  async function playPreview() {
    setPreviewState("loading");
    setPreviewUrl(null);
    try {
      const text = form.greetingLine || "Hi there, thanks for calling — how can I help you today?";
      const res = await apiFetch("/api/voice/voice-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenVent-Admin-Key": getAdminKey() },
        body: JSON.stringify({ text, voiceProvider: form.voiceProvider, voiceId: form.voiceId || undefined, language: form.language || undefined }),
      });
      if (!res.ok) throw new Error(`Preview failed (${res.status})`);
      const blob = await res.blob();
      setPreviewUrl(URL.createObjectURL(blob));
      setPreviewState("idle");
    } catch {
      setPreviewState("error");
    }
  }

  function toggleTool(name: string) {
    setForm((f) => ({
      ...f,
      toolsEnabled: f.toolsEnabled.includes(name) ? f.toolsEnabled.filter((t) => t !== name) : [...f.toolsEnabled, name],
    }));
  }

  /** Sends the current, in-progress form as configOverride — the backend
   * (buildPreviewAgentConfig, voice/agent.ts) builds the system prompt/voice/
   * LLM/tools straight from it instead of the saved DB row, so this really
   * tests what's on screen right now, not just the last saved version. */
  const testChatFetch = async (messages: { role: string; content: string }[]) => {
    return apiFetch(
      `/api/voice/orgs/${encodeURIComponent(orgId)}/agent-configs/${encodeURIComponent(row.templateKey)}/test-chat`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify({ messages, configOverride: formToAgentFrame(form) }),
      },
    );
  };

  /** Issues a short-lived token for the Voice tab's live test call — same
   * configOverride contract as testChatFetch, see test-call-tokens.ts. */
  const testCallTokenFetch = async () => {
    return apiFetch(
      `/api/voice/orgs/${encodeURIComponent(orgId)}/agent-configs/${encodeURIComponent(row.templateKey)}/test-call-token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify({ configOverride: formToAgentFrame(form) }),
      },
    );
  };

  /** Misc-1: real PSTN callback — admin-side mirror of the merchant
   * test-call-phone route, same configOverride contract. */
  const testCallPhoneFetch = async (phone: string) => {
    return apiFetch(
      `/api/voice/orgs/${encodeURIComponent(orgId)}/agent-configs/${encodeURIComponent(row.templateKey)}/test-call-phone`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify({ phone, configOverride: formToAgentFrame(form) }),
      },
    );
  };

  return (
    <div className="border-t border-border bg-muted/40 p-5">
      <div className="flex justify-end mb-5">
        <PreviewButton onClick={() => setPreviewDrawerOpen(true)} />
      </div>
      <PreviewDrawer
        open={previewDrawerOpen}
        onOpenChange={setPreviewDrawerOpen}
        templateName={row.config?.name || row.templateName}
        chatFetchFn={testChatFetch}
        testCallTokenFetchFn={testCallTokenFetch}
        testCallPhoneFetchFn={testCallPhoneFetch}
        previewState={previewState}
        previewUrl={previewUrl}
        onPlayPreview={playPreview}
      />

      {(
        <div className="space-y-5">
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor={`name-${row.templateKey}`} className={labelClass()}>Agent name</label>
              <input
                id={`name-${row.templateKey}`}
                aria-label="Agent name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. Aria"
                className={inputClass()}
              />
            </div>
            <div>
              <label htmlFor={`tone-${row.templateKey}`} className={labelClass()}>Tone</label>
              <select
                id={`tone-${row.templateKey}`}
                value={form.toneStyle}
                onChange={(e) => setForm({ ...form, toneStyle: e.target.value })}
                className={selectClass()}
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

          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor={`greeting-${row.templateKey}`} className={labelClass()}>Greeting line</label>
              <input
                id={`greeting-${row.templateKey}`}
                aria-label="Greeting line"
                value={form.greetingLine}
                onChange={(e) => setForm({ ...form, greetingLine: e.target.value })}
                placeholder="Hi, thanks for calling — how can I help?"
                className={inputClass()}
              />
            </div>
            <div>
              <label htmlFor={`closing-${row.templateKey}`} className={labelClass()}>Closing line</label>
              <input
                id={`closing-${row.templateKey}`}
                aria-label="Closing line"
                value={form.closingLine}
                onChange={(e) => setForm({ ...form, closingLine: e.target.value })}
                placeholder="Thanks for calling, have a great day!"
                className={inputClass()}
              />
            </div>
          </div>

          <div>
            <label htmlFor={`persona-${row.templateKey}`} className={labelClass()}>
              Job description / persona prompt (leave blank to use the template default)
            </label>
            <textarea
              id={`persona-${row.templateKey}`}
              aria-label="Job description / persona prompt"
              value={form.personaPrompt}
              onChange={(e) => setForm({ ...form, personaPrompt: e.target.value })}
              rows={4}
              placeholder={row.defaultPersonaPrompt ?? ""}
              className={inputClass() + " font-mono text-xs"}
            />
          </div>

          <div className="grid sm:grid-cols-3 gap-4 items-end">
            <div>
              <label htmlFor={`voice-provider-${row.templateKey}`} className={labelClass()}>Voice provider</label>
              <select
                id={`voice-provider-${row.templateKey}`}
                value={form.voiceProvider}
                onChange={(e) => setForm({ ...form, voiceProvider: e.target.value })}
                className={selectClass()}
              >
                <option value="cartesia">Cartesia</option>
                <option value="elevenlabs">ElevenLabs</option>
                <option value="sarvam">Sarvam (Indian-language voices)</option>
              </select>
            </div>
            <div>
              <label className={labelClass()}>Voice</label>
              <VoicePicker
                provider={form.voiceProvider}
                value={form.voiceId}
                language={form.language}
                onChange={(voiceId) => setForm({ ...form, voiceId })}
                scope="admin"
                previewText="Hi, this is Weeber. I can help with bookings, cart recovery, and follow-ups."
              />
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={playPreview}
                disabled={previewState === "loading"}
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted transition-colors disabled:opacity-50"
              >
                {previewState === "loading" ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
                Preview
              </button>
              {previewUrl && (
                // eslint-disable-next-line jsx-a11y/media-has-caption -- synthesized TTS preview, no source track to caption
                <audio controls src={previewUrl} className="h-9" aria-label="Voice preview playback" />
              )}
            </div>
          </div>
          {previewState === "error" && <p className="text-xs text-destructive">Preview failed — check the voice ID and provider key.</p>}

          <div className="grid sm:grid-cols-3 gap-4">
            <div>
              <label htmlFor={`language-${row.templateKey}`} className={labelClass()}>Language</label>
              <input
                id={`language-${row.templateKey}`}
                aria-label="Language"
                value={form.language}
                onChange={(e) => setForm({ ...form, language: e.target.value })}
                placeholder="en, hi, mr, ta…"
                list={`languages-${row.templateKey}`}
                className={inputClass()}
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
              <label htmlFor={`stt-provider-${row.templateKey}`} className={labelClass()}>Speech-to-text provider</label>
              <select
                id={`stt-provider-${row.templateKey}`}
                value={form.sttProvider}
                onChange={(e) => setForm({ ...form, sttProvider: e.target.value })}
                className={selectClass()}
              >
                <option value="deepgram">Deepgram</option>
                <option value="sarvam">Sarvam (Indian-language STT)</option>
              </select>
            </div>
            <div>
              <label htmlFor={`llm-provider-${row.templateKey}`} className={labelClass()}>LLM provider</label>
              <select
                id={`llm-provider-${row.templateKey}`}
                value={form.llmProvider}
                onChange={(e) => setForm({ ...form, llmProvider: e.target.value })}
                className={selectClass()}
              >
                <option value="gateway">AI Gateway</option>
                <option value="groq">Groq</option>
              </select>
            </div>
            <div>
              <label htmlFor={`llm-model-${row.templateKey}`} className={labelClass()}>Model</label>
              <input
                id={`llm-model-${row.templateKey}`}
                aria-label="Model"
                value={form.llmModel}
                onChange={(e) => setForm({ ...form, llmModel: e.target.value })}
                placeholder="leave blank for the default"
                list={`models-${row.templateKey}`}
                className={inputClass()}
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

          <div>
            <span className={labelClass()}>Tools enabled (hangUp always stays available)</span>
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

          <div className="grid sm:grid-cols-3 gap-4">
            <div>
              <label htmlFor={`topic-strictness-${row.templateKey}`} className={labelClass()}>Topic boundary strictness</label>
              <select
                id={`topic-strictness-${row.templateKey}`}
                value={form.topicBoundaryStrictness}
                onChange={(e) => setForm({ ...form, topicBoundaryStrictness: e.target.value })}
                className={selectClass()}
              >
                {STRICTNESS_LEVELS.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor={`injection-sensitivity-${row.templateKey}`} className={labelClass()}>Injection sensitivity</label>
              <select
                id={`injection-sensitivity-${row.templateKey}`}
                value={form.injectionSensitivity}
                onChange={(e) => setForm({ ...form, injectionSensitivity: e.target.value })}
                className={selectClass()}
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
          <div className="text-xs font-semibold uppercase tracking-widest text-muted-foreground/70 pt-3 pb-1">
            Retry cadence
          </div>
          <p className="text-xs text-muted-foreground -mt-1">
            Leave any field blank to use the platform default. Max attempts is capped at 20 either way.
          </p>
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label htmlFor={`first-call-delay-${row.templateKey}`} className={labelClass()}>
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
                className={inputClass()}
              />
            </div>
            <div>
              <label htmlFor={`retry-delay-${row.templateKey}`} className={labelClass()}>
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
                className={inputClass()}
              />
            </div>
            <div>
              <label htmlFor={`max-attempts-${row.templateKey}`} className={labelClass()}>
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
                className={inputClass()}
              />
            </div>
          </div>

          <div className="flex items-center gap-3 pt-2">
            <label className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                aria-label="Agent enabled"
                checked={form.enabled}
                onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                className="accent-primary"
              />
              Agent enabled
            </label>
            <button
              onClick={() => save.mutate()}
              disabled={save.isPending}
              className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {save.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null}
              Save
            </button>
          </div>
          {saveError && <p className="text-xs text-destructive">{saveError}</p>}
          {save.isSuccess && !saveError && <p className="text-xs text-muted-foreground">Saved.</p>}
        </div>
      )}
    </div>
  );
}

export function AgentsPage() {
  const [orgId, setOrgId] = useSelectedOrgId();
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  const orgsQuery = useQuery({
    queryKey: ["orgs"],
    queryFn: async () => {
      const res = await api.voice.orgs.$get({}, { headers: adminHeaders() });
      return res.json();
    },
  });
  const orgRows = orgsQuery.data && "orgs" in orgsQuery.data ? orgsQuery.data.orgs : [];

  useEffect(() => {
    if (!orgId && orgRows.length > 0) setOrgId(orgRows[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgRows.length]);

  const configs = useQuery({
    queryKey: ["agent-configs", orgId],
    enabled: Boolean(orgId),
    queryFn: async () => {
      const res = await api.voice.orgs[":orgId"]["agent-configs"].$get({ param: { orgId } }, { headers: adminHeaders() });
      return res.json();
    },
  });
  const rows = configs.data && "agentConfigs" in configs.data ? (configs.data.agentConfigs as AgentConfigRow[]) : [];

  return (
    <div className="flex h-full flex-col">
      {/* Slim top bar — org picker as a pill, consistent with the merchant
       * agent console's full-window layout, instead of a large title block
       * eating vertical space. */}
      <div className="flex shrink-0 items-center gap-3 flex-wrap border-b border-border pb-4">
        <Bot className="size-4 text-primary shrink-0" aria-hidden />
        <select
          aria-label="Select org"
          value={orgId}
          onChange={(e) => setOrgId(e.target.value)}
          className="rounded-full border border-border bg-card px-4 py-1.5 text-sm font-medium shadow-xs transition-colors focus:ring-2 focus:ring-ring/40 focus:outline-none cursor-pointer"
        >
          <option value="">Select an org…</option>
          {orgRows.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name ?? o.id} ({o.vertical})
            </option>
          ))}
        </select>
        <span className="text-xs text-muted-foreground">
          Configure identity, voice, model, tools, and guardrails per agent.
        </span>
      </div>

      <div className="flex-1 overflow-y-auto pt-5">
        {!orgId && <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">Select an org to configure its agents.</div>}

        {orgId && configs.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {orgId && configs.isError && (
          <div className="rounded-lg border border-dashed border-destructive/40 p-10 text-center text-sm text-destructive">
            Couldn't load agents for this org — try refreshing the page.
          </div>
        )}
        {orgId && !configs.isLoading && !configs.isError && rows.length === 0 && (
          <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
            No agent templates found for this org's vertical.
          </div>
        )}

        {orgId && rows.length > 0 && (
      <div className="rounded-lg border border-border divide-y divide-border">
        {rows.map((row) => {
          const isExpanded = expandedKey === row.templateKey;
          const isConfigured = Boolean(row.config);
          return (
            <div key={row.templateKey}>
              <button
                onClick={() => setExpandedKey(isExpanded ? null : row.templateKey)}
                className="w-full flex items-center justify-between gap-4 px-5 py-4 hover:bg-muted/60 transition-colors text-left"
              >
                <div>
                  <div className="text-sm font-medium flex items-center gap-2">
                    {row.config?.name || row.templateName}
                    {isConfigured ? (
                      <span className="text-[10px] font-mono uppercase tracking-wider text-success bg-success-soft px-1.5 py-0.5 rounded">
                        configured
                      </span>
                    ) : (
                      <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                        default
                      </span>
                    )}
                  </div>
                  {row.templateDescription && <div className="text-xs text-muted-foreground mt-0.5">{row.templateDescription}</div>}
                </div>
                {isExpanded ? <ChevronUp className="size-4 text-muted-foreground shrink-0" /> : <ChevronDown className="size-4 text-muted-foreground shrink-0" />}
              </button>
              {isExpanded && <AgentEditForm orgId={orgId} row={row} />}
            </div>
          );
        })}
      </div>
        )}
      </div>
    </div>
  );
}
