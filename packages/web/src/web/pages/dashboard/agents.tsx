import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Bot, ChevronDown, ChevronUp, Play, Loader as Loader2, Settings2 } from "lucide-react";
import { toast } from "sonner";
import { api, apiFetch } from "../../lib/api";
import { adminHeaders, getAdminKey } from "../../lib/admin-key";
import { useSelectedOrgId } from "../../lib/org-id";
import { Switch } from "../../components/ui/switch";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import { VoicePicker } from "../../components/voice/VoicePicker";
import { PageHeader } from "../../components/shell/page-header";
import { EmptyState } from "../../components/shell/empty-state";
import { SkeletonCards } from "../../components/shell/skeletons";
import { PreviewButton } from "../../components/agent-preview/PreviewButton";
import { PreviewDrawer } from "../../components/agent-preview/PreviewDrawer";
import { ProviderFallbackOrder, ModelFallbackList } from "../../components/agent-config/FallbackControls";
import {
  TONE_STYLES, STRICTNESS_LEVELS, AVAILABLE_TOOL_NAMES,
  RECOMMENDED_LLM_MODELS, RECOMMENDED_LANGUAGES, getRecommendedVoiceStack,
  TTS_COST_TIERS, STT_COST_TIERS,
  STT_PROVIDERS, TTS_PROVIDERS, STT_PROVIDER_LABELS, TTS_PROVIDER_LABELS,
  DEFAULT_STT_FALLBACK_ORDER, DEFAULT_TTS_FALLBACK_ORDER,
  type AgentConfigRow, type FormState,
  toFormState, formToAgentFrame, fieldCls, labelCls,
} from "../../lib/agent-config";

type SyntheticResult = {
  scenarioKey: string;
  transcript: { role: "caller" | "agent"; text: string }[];
  toolCallsByAgent: string[];
  endedBy: "hangup" | "max-turns";
  assertions: { assertion: { description: string }; passed: boolean }[];
  allPassed: boolean;
};

function SyntheticTestPanel({ orgId, templateKey, form }: { orgId: string; templateKey: string; form: FormState }) {
  const [open, setOpen] = useState(false);
  const [scenarioKey, setScenarioKey] = useState("");
  const [result, setResult] = useState<SyntheticResult | null>(null);

  const scenarios = useQuery({
    queryKey: ["synthetic-scenarios"],
    enabled: open,
    queryFn: async () => {
      const res = await apiFetch("/api/voice/synthetic-scenarios", { headers: adminHeaders() });
      if (!res.ok) throw new Error(`${res.status}`);
      return (await res.json()) as { scenarios: { key: string; label: string }[] };
    },
  });

  const run = useMutation({
    mutationFn: async () => {
      const res = await apiFetch(
        `/api/voice/orgs/${encodeURIComponent(orgId)}/agent-configs/${encodeURIComponent(templateKey)}/synthetic-test`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...adminHeaders() },
          body: JSON.stringify({ scenarioKey, configOverride: formToAgentFrame(form) }),
        },
      );
      const data = await res.json();
      if (!res.ok) throw new Error((data as { error?: string }).error ?? `${res.status}`);
      return data as SyntheticResult;
    },
    onSuccess: setResult,
    onError: (err: Error) => toast.error("Synthetic test failed", { description: err.message }),
  });

  return (
    <div className="card-weeber overflow-hidden">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium hover:bg-muted/50 transition-colors">
        Synthetic call test (AI-to-AI)
        {open ? <ChevronUp className="size-4 text-muted-foreground" aria-hidden /> : <ChevronDown className="size-4 text-muted-foreground" aria-hidden />}
      </button>
      {open && (
        <div className="border-t border-border p-4 space-y-3">
          <p className="text-xs text-muted-foreground">A scripted LLM plays a caller and tests this exact in-progress config — real LLM cost, no telephony required.</p>
          <div className="flex gap-2">
            <select value={scenarioKey} onChange={(e) => setScenarioKey(e.target.value)} className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm outline-none">
              <option value="">Select a scenario…</option>
              {(scenarios.data?.scenarios ?? []).map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
            <Button size="sm" onClick={() => run.mutate()} disabled={!scenarioKey || run.isPending}>
              {run.isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
              Run
            </Button>
          </div>
          {result && (
            <div className="space-y-2">
              <p className={`text-sm font-medium ${result.allPassed ? "text-emerald-600" : "text-destructive"}`}>
                {result.allPassed ? "All assertions passed" : "Some assertions failed"}
                <span className="ml-2 text-xs font-normal text-muted-foreground">— ended by {result.endedBy === "hangup" ? "agent hangUp" : "max turns"}</span>
              </p>
              <ul className="space-y-1">
                {result.assertions.map((a, i) => (
                  <li key={i} className={`text-xs ${a.passed ? "text-emerald-600" : "text-destructive"}`}>
                    {a.passed ? "✓" : "✗"} {a.assertion.description}
                  </li>
                ))}
              </ul>
              <div className="max-h-48 overflow-y-auto rounded-md border border-border bg-muted/30 p-2 space-y-1 text-xs">
                {result.transcript.map((t, i) => (
                  <p key={i}><span className="font-medium">{t.role === "caller" ? "Caller" : "Agent"}:</span> {t.text}</p>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SectionDivider({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-t border-border pt-5 mt-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
      {children}
    </div>
  );
}

function AgentEditForm({ orgId, row }: { orgId: string; row: AgentConfigRow }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState>(() => toFormState(row));
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [previewState, setPreviewState] = useState<"idle" | "loading" | "error">("idle");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    setForm(toFormState(row));
    setAdvancedOpen(false);
  }, [row]);

  const save = useMutation({
    mutationFn: async () => {
      const res = await apiFetch(
        `/api/voice/orgs/${encodeURIComponent(orgId)}/agent-configs/${encodeURIComponent(row.templateKey)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json", ...adminHeaders() },
          body: JSON.stringify(formToAgentFrame(form)),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}) as { error?: string });
        throw new Error((body as { error?: string }).error ?? `Failed (${res.status})`);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agent-configs", orgId] });
      toast.success("Agent saved");
    },
    onError: (err: Error) => toast.error("Failed to save", { description: err.message }),
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
      if (!res.ok) throw new Error(`${res.status}`);
      const blob = await res.blob();
      setPreviewUrl(URL.createObjectURL(blob));
      setPreviewState("idle");
    } catch {
      setPreviewState("error");
    }
  }

  const chatFetchFn = (messages: { role: string; content: string }[]) =>
    apiFetch(`/api/voice/orgs/${encodeURIComponent(orgId)}/agent-configs/${encodeURIComponent(row.templateKey)}/test-chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...adminHeaders() },
      body: JSON.stringify({ messages, configOverride: formToAgentFrame(form) }),
    });

  const testCallTokenFetchFn = () =>
    apiFetch(`/api/voice/orgs/${encodeURIComponent(orgId)}/agent-configs/${encodeURIComponent(row.templateKey)}/test-call-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...adminHeaders() },
      body: JSON.stringify({ configOverride: formToAgentFrame(form) }),
    });

  const testCallPhoneFetchFn = (phone: string) =>
    apiFetch(`/api/voice/orgs/${encodeURIComponent(orgId)}/agent-configs/${encodeURIComponent(row.templateKey)}/test-call-phone`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...adminHeaders() },
      body: JSON.stringify({ phone, configOverride: formToAgentFrame(form) }),
    });

  function toggleTool(name: string) {
    setForm((f) => ({
      ...f,
      toolsEnabled: f.toolsEnabled.includes(name)
        ? f.toolsEnabled.filter((t) => t !== name)
        : [...f.toolsEnabled, name],
    }));
  }

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  return (
    <div className="border-t border-border p-5 bg-muted/20 space-y-5">
      {/* Synthetic test */}
      <SyntheticTestPanel orgId={orgId} templateKey={row.templateKey} form={form} />

      {/* Preview */}
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-sm font-medium">
          <Switch checked={form.enabled} onCheckedChange={(v) => set("enabled", v)} aria-label="Agent enabled" />
          {form.enabled ? "Enabled" : "Disabled"}
        </label>
        <PreviewButton onClick={() => setDrawerOpen(true)} />
      </div>

      <PreviewDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        templateName={row.config?.name || row.templateName}
        chatFetchFn={chatFetchFn}
        testCallTokenFetchFn={testCallTokenFetchFn}
        testCallPhoneFetchFn={testCallPhoneFetchFn}
        previewState={previewState}
        previewUrl={previewUrl}
        onPlayPreview={playPreview}
      />

      {/* Identity & Tone */}
      <SectionDivider>Identity &amp; Tone</SectionDivider>
      <div className="grid sm:grid-cols-2 gap-4">
        <div>
          <label htmlFor={`name-${row.templateKey}`} className={labelCls}>Agent name</label>
          <input id={`name-${row.templateKey}`} value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Aria" className={fieldCls} />
        </div>
        <div>
          <label htmlFor={`tone-${row.templateKey}`} className={labelCls}>Tone</label>
          <select id={`tone-${row.templateKey}`} value={form.toneStyle} onChange={(e) => set("toneStyle", e.target.value)} className={fieldCls}>
            <option value="">Default</option>
            {TONE_STYLES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor={`greeting-${row.templateKey}`} className={labelCls}>Greeting line</label>
          <input id={`greeting-${row.templateKey}`} value={form.greetingLine} onChange={(e) => set("greetingLine", e.target.value)} placeholder="Hi, how can I help?" className={fieldCls} />
        </div>
        <div>
          <label htmlFor={`closing-${row.templateKey}`} className={labelCls}>Closing line</label>
          <input id={`closing-${row.templateKey}`} value={form.closingLine} onChange={(e) => set("closingLine", e.target.value)} placeholder="Thanks, have a great day!" className={fieldCls} />
        </div>
      </div>
      <div>
        <label htmlFor={`persona-${row.templateKey}`} className={labelCls}>Persona prompt (leave blank to use the template default)</label>
        <textarea id={`persona-${row.templateKey}`} value={form.personaPrompt} onChange={(e) => set("personaPrompt", e.target.value)} rows={4} placeholder={row.defaultPersonaPrompt ?? ""} className={`${fieldCls} font-mono text-xs`} />
      </div>

      {/* Voice */}
      <SectionDivider>Voice</SectionDivider>
      <div className="grid sm:grid-cols-3 gap-4 items-end">
        <div>
          <label htmlFor={`vp-${row.templateKey}`} className={labelCls}>Provider</label>
          <select id={`vp-${row.templateKey}`} value={form.voiceProvider} onChange={(e) => set("voiceProvider", e.target.value)} className={fieldCls}>
            <option value="cartesia">Cartesia ({TTS_COST_TIERS.cartesia.tier})</option>
            <option value="elevenlabs">ElevenLabs ({TTS_COST_TIERS.elevenlabs.tier})</option>
            <option value="sarvam">Sarvam ({TTS_COST_TIERS.sarvam.tier})</option>
          </select>
          <p className="mt-1 text-xs text-muted-foreground">{TTS_COST_TIERS[form.voiceProvider]?.note ?? ""}</p>
        </div>
        <div>
          <label className={labelCls}>Voice</label>
          <VoicePicker provider={form.voiceProvider} value={form.voiceId} language={form.language} onChange={(v) => set("voiceId", v)} scope="admin" previewText="Hi, this is Weeber. I can help with bookings, cart recovery, and follow-ups." />
        </div>
        <div className="flex items-end gap-2">
          <button type="button" onClick={playPreview} disabled={previewState === "loading"} className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted transition-colors disabled:opacity-50">
            {previewState === "loading" ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
            Preview
          </button>
          {previewUrl && (
            // eslint-disable-next-line jsx-a11y/media-has-caption
            <audio controls src={previewUrl} className="h-9" aria-label="Voice preview playback" />
          )}
        </div>
      </div>
      {previewState === "error" && <p className="text-xs text-destructive">Preview failed — check the voice ID and provider key.</p>}

      {/* Advanced disclosure */}
      <div className="border-t border-border/50 pt-4">
        <button type="button" onClick={() => setAdvancedOpen((o) => !o)} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors" aria-expanded={advancedOpen}>
          <Settings2 className="size-3.5" aria-hidden />
          Advanced settings
          {advancedOpen ? <ChevronUp className="size-3.5" aria-hidden /> : <ChevronDown className="size-3.5" aria-hidden />}
        </button>
        {advancedOpen && (
          <div className="mt-5 space-y-5">
            <SectionDivider>Capabilities</SectionDivider>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {AVAILABLE_TOOL_NAMES.map((name) => (
                <label key={name} className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" aria-label={name} checked={name === "hangUp" || form.toolsEnabled.includes(name)} disabled={name === "hangUp"} onChange={() => toggleTool(name)} className="accent-primary" />
                  <span className="font-mono text-xs">{name}</span>
                </label>
              ))}
            </div>

            <SectionDivider>Guardrails</SectionDivider>
            <div className="grid sm:grid-cols-3 gap-4">
              <div>
                <label htmlFor={`ts-${row.templateKey}`} className={labelCls}>Topic boundary strictness</label>
                <select id={`ts-${row.templateKey}`} value={form.topicBoundaryStrictness} onChange={(e) => set("topicBoundaryStrictness", e.target.value)} className={fieldCls}>
                  {STRICTNESS_LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor={`is-${row.templateKey}`} className={labelCls}>Injection sensitivity</label>
                <select id={`is-${row.templateKey}`} value={form.injectionSensitivity} onChange={(e) => set("injectionSensitivity", e.target.value)} className={fieldCls}>
                  {STRICTNESS_LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
                </select>
              </div>
              <div className="flex items-end pb-2">
                <label className="flex items-center gap-2 text-sm">
                  <Switch checked={form.abuseHandlingEnabled} onCheckedChange={(v) => set("abuseHandlingEnabled", v)} aria-label="End call on sustained abuse" />
                  End call on abuse
                </label>
              </div>
            </div>

            <SectionDivider>Retry cadence</SectionDivider>
            <p className="text-xs text-muted-foreground">Leave blank to use the platform default.</p>
            <div className="grid sm:grid-cols-3 gap-4">
              <div>
                <label htmlFor={`fd-${row.templateKey}`} className={labelCls}>Delay before first call (min)</label>
                <input id={`fd-${row.templateKey}`} type="number" min={0} max={43200} value={form.firstCallDelayMinutes} onChange={(e) => set("firstCallDelayMinutes", e.target.value)} placeholder="Platform default" className={fieldCls} />
              </div>
              <div>
                <label htmlFor={`rd-${row.templateKey}`} className={labelCls}>Delay between retries (min)</label>
                <input id={`rd-${row.templateKey}`} type="number" min={0} max={43200} value={form.retryDelayMinutes} onChange={(e) => set("retryDelayMinutes", e.target.value)} placeholder="Platform default" className={fieldCls} />
              </div>
              <div>
                <label htmlFor={`ma-${row.templateKey}`} className={labelCls}>Max attempts (1–20)</label>
                <input id={`ma-${row.templateKey}`} type="number" min={1} max={20} value={form.maxAttempts} onChange={(e) => set("maxAttempts", e.target.value)} placeholder="Platform default" className={fieldCls} />
              </div>
            </div>

            <SectionDivider>Language &amp; Model</SectionDivider>
            <div className="grid sm:grid-cols-3 gap-4">
              <div>
                <label htmlFor={`lang-${row.templateKey}`} className={labelCls}>Language</label>
                <input id={`lang-${row.templateKey}`} value={form.language} onChange={(e) => set("language", e.target.value)} placeholder="en, hi, mr…" list={`langs-${row.templateKey}`} className={fieldCls} />
                <datalist id={`langs-${row.templateKey}`}>{RECOMMENDED_LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}</datalist>
              </div>
              <div>
                <label htmlFor={`stt-${row.templateKey}`} className={labelCls}>STT provider</label>
                <select id={`stt-${row.templateKey}`} value={form.sttProvider} onChange={(e) => set("sttProvider", e.target.value)} className={fieldCls}>
                  <option value="deepgram">Deepgram ({STT_COST_TIERS.deepgram.tier})</option>
                  <option value="sarvam">Sarvam ({STT_COST_TIERS.sarvam.tier})</option>
                  <option value="elevenlabs">ElevenLabs Scribe ({STT_COST_TIERS.elevenlabs.tier})</option>
                </select>
                <p className="mt-1 text-xs text-muted-foreground">{STT_COST_TIERS[form.sttProvider]?.note ?? ""}</p>
              </div>
              <div>
                <label htmlFor={`llmp-${row.templateKey}`} className={labelCls}>LLM provider</label>
                <select id={`llmp-${row.templateKey}`} value={form.llmProvider} onChange={(e) => set("llmProvider", e.target.value)} className={fieldCls}>
                  <option value="gateway">AI Gateway</option>
                  <option value="groq">Groq</option>
                </select>
              </div>
              <div>
                <label htmlFor={`llmm-${row.templateKey}`} className={labelCls}>Model</label>
                <input id={`llmm-${row.templateKey}`} value={form.llmModel} onChange={(e) => set("llmModel", e.target.value)} placeholder="leave blank for default" list={`models-${row.templateKey}`} className={fieldCls} />
                <datalist id={`models-${row.templateKey}`}>{RECOMMENDED_LLM_MODELS.filter((m) => m.provider === form.llmProvider).map((m) => <option key={m.model} value={m.model}>{m.label}</option>)}</datalist>
              </div>
            </div>

            <SectionDivider>Cross-provider failover</SectionDivider>
            <div className="grid sm:grid-cols-3 gap-4">
              <div>
                <span className={labelCls}>STT failover order</span>
                <ProviderFallbackOrder
                  primary={form.sttProvider}
                  allProviders={STT_PROVIDERS}
                  labels={STT_PROVIDER_LABELS}
                  value={form.sttFallbackOrder}
                  onChange={(next) => set("sttFallbackOrder", next)}
                  defaultOrder={DEFAULT_STT_FALLBACK_ORDER}
                />
              </div>
              <div>
                <span className={labelCls}>Voice (TTS) failover order</span>
                <ProviderFallbackOrder
                  primary={form.voiceProvider}
                  allProviders={TTS_PROVIDERS}
                  labels={TTS_PROVIDER_LABELS}
                  value={form.ttsFallbackOrder}
                  onChange={(next) => set("ttsFallbackOrder", next)}
                  defaultOrder={DEFAULT_TTS_FALLBACK_ORDER}
                />
              </div>
              <div>
                <span className={labelCls}>LLM failover models <span className="text-muted-foreground/60">(gateway only)</span></span>
                <ModelFallbackList
                  value={form.llmFallbackModels}
                  onChange={(next) => set("llmFallbackModels", next)}
                  suggestions={RECOMMENDED_LLM_MODELS.map((m) => m.model)}
                />
              </div>
            </div>
            {(() => {
              const recommended = getRecommendedVoiceStack(form.language);
              const matchesRecommended = recommended && form.sttProvider === recommended.sttProvider && form.voiceProvider === recommended.voiceProvider;
              if (!recommended || matchesRecommended) return null;
              return (
                <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2.5 text-xs">
                  <p className="text-foreground">
                    <span className="font-medium">Recommended for Hindi/Hinglish:</span> ElevenLabs Scribe (STT) +
                    ElevenLabs (voice) — live-tested to keep English words in Latin script mid-sentence instead of
                    transliterating them, and to avoid a known Deepgram issue misdetecting Hindi as Spanish.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      set("sttProvider", recommended.sttProvider);
                      set("voiceProvider", recommended.voiceProvider);
                    }}
                    className="mt-1.5 inline-flex items-center rounded-md border border-primary/40 bg-background px-2.5 py-1 text-xs font-medium text-primary hover:bg-primary/10 transition-colors"
                  >
                    Use recommended (ElevenLabs)
                  </button>
                </div>
              );
            })()}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-end pt-2 border-t border-border">
        <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
          {save.isSuccess ? "Saved" : "Save"}
        </Button>
      </div>
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
  const orgRows =
    orgsQuery.data && "orgs" in orgsQuery.data ? orgsQuery.data.orgs : [];

  useEffect(() => {
    if (!orgId && orgRows.length > 0) setOrgId(orgRows[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgRows.length]);

  const configs = useQuery({
    queryKey: ["agent-configs", orgId],
    enabled: Boolean(orgId),
    queryFn: async () => {
      const res = await api.voice.orgs[":orgId"]["agent-configs"].$get(
        { param: { orgId } },
        { headers: adminHeaders() },
      );
      return res.json();
    },
  });
  const rows =
    configs.data && "agentConfigs" in configs.data
      ? (configs.data.agentConfigs as AgentConfigRow[])
      : [];

  return (
    <div className="page-enter space-y-5">
      <PageHeader
        title="Agents"
        description="Configure identity, voice, model, tools, and guardrails for each agent template."
        actions={
          <div className="flex items-center gap-2">
            <Bot className="size-4 text-muted-foreground shrink-0" aria-hidden />
            <select
              aria-label="Select org"
              value={orgId}
              onChange={(e) => {
                setOrgId(e.target.value);
                setExpandedKey(null);
              }}
              className="rounded-full border border-border bg-card px-4 py-1.5 text-sm font-medium transition-colors focus:ring-2 focus:ring-ring/40 focus:outline-none cursor-pointer"
            >
              <option value="">Select an org…</option>
              {orgRows.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name ?? o.id} ({o.vertical})
                </option>
              ))}
            </select>
          </div>
        }
      />

      {!orgId && (
        <EmptyState title="No org selected" description="Pick an org above to configure its agents." />
      )}

      {orgId && configs.isLoading && <SkeletonCards count={3} lines={2} />}

      {orgId && configs.isError && (
        <EmptyState title="Couldn't load agents" description="Something went wrong — try refreshing the page." />
      )}

      {orgId && !configs.isLoading && !configs.isError && rows.length === 0 && (
        <EmptyState title="No agent templates" description="No agent templates found for this org's vertical." />
      )}

      {orgId && rows.length > 0 && (
        <div className="card-weeber overflow-hidden divide-y divide-border">
          {rows.map((row) => {
            const isExpanded = expandedKey === row.templateKey;
            const isConfigured = Boolean(row.config);
            return (
              <div key={row.templateKey}>
                <button
                  type="button"
                  onClick={() => setExpandedKey(isExpanded ? null : row.templateKey)}
                  className="w-full flex items-center justify-between gap-4 px-5 py-4 hover:bg-muted/50 transition-colors text-left"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      {row.config?.name || row.templateName}
                      {isConfigured ? (
                        <Badge variant="secondary" className="bg-emerald-500/10 text-emerald-600 border-emerald-200 text-[10px]">configured</Badge>
                      ) : (
                        <Badge variant="secondary" className="text-[10px]">default</Badge>
                      )}
                      {row.config?.enabled === false && (
                        <Badge variant="secondary" className="text-[10px]">disabled</Badge>
                      )}
                    </div>
                    {row.templateDescription && (
                      <p className="text-xs text-muted-foreground mt-0.5 truncate">{row.templateDescription}</p>
                    )}
                  </div>
                  {isExpanded
                    ? <ChevronUp className="size-4 text-muted-foreground shrink-0" aria-hidden />
                    : <ChevronDown className="size-4 text-muted-foreground shrink-0" aria-hidden />
                  }
                </button>
                {isExpanded && <AgentEditForm orgId={orgId} row={row} />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
