import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Play, Loader as Loader2, Settings2, ChevronDown, ChevronUp } from "lucide-react";
import { toast } from "sonner";
import { appFetch } from "../../lib/user-session";
import { useUnsavedChanges } from "../../hooks/useUnsavedChanges";
import { Switch } from "../../components/ui/switch";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import { VoicePicker } from "../../components/voice/VoicePicker";
import { useUser } from "../../components/app/user-shell";
import { EmptyState } from "../../components/shell/empty-state";
import { SkeletonCards } from "../../components/shell/skeletons";
import { PreviewButton } from "../../components/agent-preview/PreviewButton";
import { PreviewDrawer } from "../../components/agent-preview/PreviewDrawer";
import {
  TONE_STYLES, STRICTNESS_LEVELS, AVAILABLE_TOOL_NAMES,
  RECOMMENDED_LLM_MODELS, RECOMMENDED_LANGUAGES,
  type AgentConfigRow, type FormState,
  toFormState, formToAgentFrame, fieldCls, labelCls,
} from "../../lib/agent-config";

type OrgPhoneNumber = { id: number; phoneNumber: string; status: "active" | "released" };

// C2b — which of the org's numbers (bought on the Phone Numbers page) this
// agent dials out from. Separate PUT from the main agent-save mutation
// since phoneNumberId is a plain FK column on org_agent_configs, not part
// of AgentFrameSchema's jsonb config — see org-queries.ts's
// assignPhoneNumberToAgent for why.
function NumberAssignment({ row }: { row: AgentConfigRow }) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string>(row.config?.phoneNumberId != null ? String(row.config.phoneNumberId) : "");

  useEffect(() => {
    setSelected(row.config?.phoneNumberId != null ? String(row.config.phoneNumberId) : "");
  }, [row.config?.phoneNumberId]);

  const numbers = useQuery({
    queryKey: ["app-numbers"],
    queryFn: async () => {
      const res = await appFetch("/api/app/numbers");
      if (!res.ok) throw new Error(`numbers failed (${res.status})`);
      return (await res.json()) as { numbers: OrgPhoneNumber[] };
    },
  });

  const assign = useMutation({
    mutationFn: async (phoneNumberId: number | null) => {
      const res = await appFetch(`/api/app/agent-configs/${encodeURIComponent(row.templateKey)}/number`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phoneNumberId }),
      });
      const data = await res.json().catch(() => ({ error: "Failed" }));
      if (!res.ok) throw new Error(data.error ?? "Failed");
      return data;
    },
    onSuccess: () => {
      toast.success("Number assignment saved");
      queryClient.invalidateQueries({ queryKey: ["app-agent-configs"] });
    },
    onError: (err: Error) => toast.error("Failed to assign number", { description: err.message }),
  });

  const activeNumbers = (numbers.data?.numbers ?? []).filter((n) => n.status === "active");

  return (
    <div>
      <label htmlFor={`number-${row.templateKey}`} className={labelCls}>Caller ID number</label>
      <div className="flex gap-2">
        <select
          id={`number-${row.templateKey}`}
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          className={fieldCls}
        >
          <option value="">Org default (shared number)</option>
          {activeNumbers.map((n) => (
            <option key={n.id} value={n.id}>{n.phoneNumber}</option>
          ))}
        </select>
        <Button
          size="sm"
          variant="outline"
          disabled={assign.isPending}
          onClick={() => assign.mutate(selected ? Number(selected) : null)}
        >
          Save
        </Button>
      </div>
      {activeNumbers.length === 0 && (
        <p className="mt-1 text-xs text-muted-foreground">
          No numbers bought yet — buy one on the Phone Numbers page to assign it here.
        </p>
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

function AgentForm({ row }: { row: AgentConfigRow }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState>(() => toFormState(row));
  const [dirty, setDirty] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  useUnsavedChanges(dirty);
  const [previewState, setPreviewState] = useState<"idle" | "loading" | "error">("idle");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Reset form when switching agents
  useEffect(() => {
    setForm(toFormState(row));
    setDirty(false);
    setAdvancedOpen(false);
  }, [row]);

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
      setDirty(false);
      queryClient.invalidateQueries({ queryKey: ["app-agent-configs"] });
      toast.success("Agent saved");
    },
    onError: (err: Error) => toast.error("Failed to save", { description: err.message }),
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
      if (!res.ok) throw new Error(`${res.status}`);
      const blob = await res.blob();
      setPreviewUrl(URL.createObjectURL(blob));
      setPreviewState("idle");
    } catch {
      setPreviewState("error");
      toast.error("Preview failed", { description: "Try a different voice or retry in a moment." });
    }
  }

  const chatFetchFn = (messages: { role: string; content: string }[]) =>
    appFetch(`/api/app/agent-configs/${encodeURIComponent(row.templateKey)}/test-chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, configOverride: formToAgentFrame(form) }),
    });

  const testCallTokenFetchFn = () =>
    appFetch(`/api/app/agent-configs/${encodeURIComponent(row.templateKey)}/test-call-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ configOverride: formToAgentFrame(form) }),
    });

  const testCallPhoneFetchFn = (phone: string) =>
    appFetch(`/api/app/agent-configs/${encodeURIComponent(row.templateKey)}/test-call-phone`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setDirty(true);
    setForm((f) => ({ ...f, [key]: value }));
  };

  return (
    <div className="card-weeber p-6 space-y-5">
      {/* Header: name + enabled toggle + preview */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm font-medium">
            <Switch
              checked={form.enabled}
              onCheckedChange={(v) => set("enabled", v)}
              aria-label="Agent enabled"
            />
            {form.enabled ? "Live" : "Paused"}
          </label>
        </div>
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
      <div className="grid gap-4 sm:grid-cols-2">
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
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
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
        <label htmlFor={`persona-${row.templateKey}`} className={labelCls}>
          What should this agent say and do? <span className="text-muted-foreground/60">(leave blank for the recommended script)</span>
        </label>
        <textarea id={`persona-${row.templateKey}`} value={form.personaPrompt} onChange={(e) => set("personaPrompt", e.target.value)} rows={4} placeholder={row.defaultPersonaPrompt ?? ""} className={`${fieldCls} font-mono text-xs`} />
      </div>
      <NumberAssignment row={row} />

      {/* Voice */}
      <SectionDivider>Voice &amp; Sound</SectionDivider>
      <div className="grid items-end gap-4 sm:grid-cols-3">
        <div>
          <label htmlFor={`vp-${row.templateKey}`} className={labelCls}>Voice provider</label>
          <select id={`vp-${row.templateKey}`} value={form.voiceProvider} onChange={(e) => set("voiceProvider", e.target.value)} className={fieldCls}>
            <option value="cartesia">Cartesia</option>
            <option value="elevenlabs">ElevenLabs</option>
            <option value="sarvam">Sarvam (Indian-language)</option>
          </select>
        </div>
        <div>
          <label className={labelCls}>Voice</label>
          <VoicePicker provider={form.voiceProvider} value={form.voiceId} language={form.language} onChange={(v) => set("voiceId", v)} scope="user" previewText="Hi, this is Weeber. How can I help?" />
        </div>
        <div className="flex items-end gap-2">
          <button type="button" onClick={playPreview} disabled={previewState === "loading"} className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted transition-colors disabled:opacity-50">
            {previewState === "loading" ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
            Hear it
          </button>
          {previewUrl && (
            // eslint-disable-next-line jsx-a11y/media-has-caption
            <audio controls src={previewUrl} className="h-9" aria-label="Voice preview playback" />
          )}
        </div>
      </div>
      {previewState === "error" && <p className="text-xs text-destructive">Preview failed — try a different voice or retry in a moment.</p>}

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
            <div>
              <span className={labelCls}>Abilities <span className="text-muted-foreground/60">(hangUp always stays on)</span></span>
              <div className="flex flex-wrap gap-x-4 gap-y-2 mt-1">
                {AVAILABLE_TOOL_NAMES.map((name) => (
                  <label key={name} className="flex items-center gap-1.5 text-sm">
                    <input type="checkbox" aria-label={name} checked={name === "hangUp" || form.toolsEnabled.includes(name)} disabled={name === "hangUp"} onChange={() => toggleTool(name)} className="accent-primary" />
                    <span className="font-mono text-xs">{name}</span>
                  </label>
                ))}
              </div>
            </div>

            <SectionDivider>Safety Guardrails</SectionDivider>
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <label htmlFor={`ts-${row.templateKey}`} className={labelCls}>Stay-on-topic strictness</label>
                <select id={`ts-${row.templateKey}`} value={form.topicBoundaryStrictness} onChange={(e) => set("topicBoundaryStrictness", e.target.value)} className={fieldCls}>
                  {STRICTNESS_LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor={`is-${row.templateKey}`} className={labelCls}>Manipulation sensitivity</label>
                <select id={`is-${row.templateKey}`} value={form.injectionSensitivity} onChange={(e) => set("injectionSensitivity", e.target.value)} className={fieldCls}>
                  {STRICTNESS_LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
                </select>
              </div>
              <div className="flex items-end pb-2">
                <label className="flex items-center gap-2 text-sm">
                  <Switch checked={form.abuseHandlingEnabled} onCheckedChange={(v) => set("abuseHandlingEnabled", v)} aria-label="End call on sustained abuse" />
                  End call on sustained abuse
                </label>
              </div>
            </div>

            <SectionDivider>Retry cadence</SectionDivider>
            <p className="text-xs text-muted-foreground">Leave blank to use the platform default. Max attempts capped at 20.</p>
            <div className="grid gap-4 sm:grid-cols-3">
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

            <SectionDivider>Provider &amp; Model</SectionDivider>
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <label htmlFor={`lang-${row.templateKey}`} className={labelCls}>Language</label>
                <input id={`lang-${row.templateKey}`} value={form.language} onChange={(e) => set("language", e.target.value)} placeholder="en, hi, mr…" list={`langs-${row.templateKey}`} className={fieldCls} />
                <datalist id={`langs-${row.templateKey}`}>{RECOMMENDED_LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}</datalist>
              </div>
              <div>
                <label htmlFor={`stt-${row.templateKey}`} className={labelCls}>Speech-to-text</label>
                <select id={`stt-${row.templateKey}`} value={form.sttProvider} onChange={(e) => set("sttProvider", e.target.value)} className={fieldCls}>
                  <option value="deepgram">Deepgram</option>
                  <option value="sarvam">Sarvam (Indian-language STT)</option>
                </select>
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
          </div>
        )}
      </div>

      {/* Footer save */}
      <div className="flex items-center justify-end pt-2 border-t border-border">
        <Button onClick={() => save.mutate()} disabled={save.isPending || !dirty} size="sm">
          {save.isPending && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
          {!dirty && save.isSuccess ? "Saved" : "Save changes"}
        </Button>
      </div>
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
      if (!res.ok) throw new Error(`${res.status}`);
      return (await res.json()) as { agentConfigs: AgentConfigRow[] };
    },
  });

  const rows = configs.data?.agentConfigs ?? [];
  const activeKey = selectedKey ?? rows[0]?.templateKey ?? null;
  const activeRow = rows.find((r) => r.templateKey === activeKey) ?? null;

  return (
    <div className="page-enter space-y-5">
      {/* Agent tab switcher */}
      {rows.length > 1 && (
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="Select agent">
          {rows.map((r) => {
            const isActive = r.templateKey === activeKey;
            return (
              <button
                key={r.templateKey}
                role="tab"
                aria-selected={isActive}
                onClick={() => setSelectedKey(r.templateKey)}
                className={`inline-flex items-center gap-2 rounded-full border px-4 py-1.5 text-sm font-medium transition-all ${
                  isActive
                    ? "border-primary bg-primary text-primary-foreground shadow-sm"
                    : "border-border bg-card text-foreground hover:border-primary/50 hover:bg-muted"
                }`}
              >
                {r.config?.name || r.templateName}
                {r.config?.enabled === false && (
                  <Badge variant="secondary" className="text-[10px] px-1.5 py-0">Paused</Badge>
                )}
              </button>
            );
          })}
        </div>
      )}

      {configs.isLoading && <SkeletonCards count={1} lines={6} />}

      {configs.isError && (
        <EmptyState title="Couldn't load your agents" description="Something went wrong reaching the server — try refreshing." />
      )}

      {!configs.isLoading && !configs.isError && rows.length === 0 && (
        <EmptyState
          title="No agents available yet"
          description={`Agents appear here once your ${vertical.integrationLabel} store is connected.`}
        />
      )}

      {activeRow && (
        <div key={activeRow.templateKey} className="content-fade-in">
          {rows.length === 1 && (
            <div className="mb-3">
              <h2 className="text-sm font-medium">{activeRow.config?.name || activeRow.templateName}</h2>
              {activeRow.templateDescription && (
                <p className="text-xs text-muted-foreground mt-0.5">{activeRow.templateDescription}</p>
              )}
            </div>
          )}
          <AgentForm row={activeRow} />
        </div>
      )}
    </div>
  );
}
