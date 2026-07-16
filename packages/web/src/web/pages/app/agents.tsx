import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRoute, useLocation, Link } from "wouter";
import { Loader as Loader2, ChevronLeft } from "lucide-react";
import { toast } from "sonner";
import { appFetch } from "../../lib/user-session";
import { appPath } from "../../lib/route-base";
import { useUnsavedChanges } from "../../hooks/useUnsavedChanges";
import { Switch } from "../../components/ui/switch";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../../components/ui/tabs";
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

const CONFIGS_QUERY_KEY = ["app-agent-configs"];

function useAgentConfigs() {
  return useQuery({
    queryKey: CONFIGS_QUERY_KEY,
    queryFn: async () => {
      const res = await appFetch("/api/app/agent-configs");
      if (!res.ok) throw new Error(`${res.status}`);
      return (await res.json()) as { agentConfigs: AgentConfigRow[] };
    },
  });
}

/** Bare `/app/agents` — no agent in the URL yet. Redirects to the first
 * agent's own page (dedicated-URL-per-agent, matching ElevenLabs/Vapi/
 * Retell's pattern) or shows an empty state if the org has none. */
export function UserAgentsPage() {
  const { vertical } = useUser();
  const [, setLocation] = useLocation();
  const configs = useAgentConfigs();
  const rows = configs.data?.agentConfigs ?? [];

  const firstKey = rows[0]?.templateKey;
  useEffect(() => {
    if (firstKey) setLocation(appPath(`/agents/${firstKey}`), { replace: true });
  }, [firstKey, setLocation]);

  if (configs.isLoading) return <SkeletonCards count={1} lines={6} />;
  if (configs.isError) {
    return <EmptyState title="Couldn't load your agents" description="Something went wrong reaching the server — try refreshing." />;
  }
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No agents available yet"
        description={`Agents appear here once your ${vertical.integrationLabel} store is connected.`}
      />
    );
  }
  return <SkeletonCards count={1} lines={6} />; // brief flash while the redirect above fires
}

// ---------------------------------------------------------------------------
// Number assignment (C2b) — which of the org's numbers this agent dials from.
// ---------------------------------------------------------------------------
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
      queryClient.invalidateQueries({ queryKey: CONFIGS_QUERY_KEY });
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

// ---------------------------------------------------------------------------
// Tab contents — one section each, always reachable by clicking a tab
// (nothing buried behind an "Advanced" disclosure anymore).
// ---------------------------------------------------------------------------

type TabProps = {
  row: AgentConfigRow;
  form: FormState;
  set: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
};

function IdentityTab({ row, form, set }: TabProps) {
  return (
    <div className="space-y-5">
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
        <textarea id={`persona-${row.templateKey}`} value={form.personaPrompt} onChange={(e) => set("personaPrompt", e.target.value)} rows={8} placeholder={row.defaultPersonaPrompt ?? ""} className={`${fieldCls} font-mono text-xs`} />
      </div>
    </div>
  );
}

function VoiceTab({ row, form, set }: TabProps) {
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor={`vp-${row.templateKey}`} className={labelCls}>Voice provider</label>
          <select id={`vp-${row.templateKey}`} value={form.voiceProvider} onChange={(e) => set("voiceProvider", e.target.value)} className={fieldCls}>
            <option value="cartesia">Cartesia</option>
            <option value="elevenlabs">ElevenLabs</option>
            <option value="sarvam">Sarvam (Indian-language)</option>
          </select>
        </div>
        <div>
          <label htmlFor={`lang-${row.templateKey}`} className={labelCls}>Language</label>
          <input id={`lang-${row.templateKey}`} value={form.language} onChange={(e) => set("language", e.target.value)} placeholder="en, hi, mr…" list={`langs-${row.templateKey}`} className={fieldCls} />
          <datalist id={`langs-${row.templateKey}`}>{RECOMMENDED_LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}</datalist>
        </div>
      </div>
      <div>
        <label className={labelCls}>Voice</label>
        <VoicePicker
          provider={form.voiceProvider}
          value={form.voiceId}
          language={form.language}
          onChange={(v) => set("voiceId", v)}
          scope="user"
          previewText={form.greetingLine || "Hi there, thanks for calling — how can I help you today?"}
        />
        <p className="mt-1.5 text-xs text-muted-foreground">
          Search the list below, click a voice to select it, or hit the play icon on any row to preview it —
          the Preview button next to the field above always replays whichever voice is currently selected.
        </p>
      </div>
      <div>
        <label htmlFor={`stt-${row.templateKey}`} className={labelCls}>Speech-to-text</label>
        <select id={`stt-${row.templateKey}`} value={form.sttProvider} onChange={(e) => set("sttProvider", e.target.value)} className={`${fieldCls} sm:max-w-xs`}>
          <option value="deepgram">Deepgram</option>
          <option value="sarvam">Sarvam (Indian-language STT)</option>
          <option value="elevenlabs">ElevenLabs Scribe (Hindi/Hinglish code-switching)</option>
        </select>
      </div>
    </div>
  );
}

function ToolsGuardrailsTab({ row, form, set }: TabProps) {
  function toggleTool(name: string) {
    set(
      "toolsEnabled",
      form.toolsEnabled.includes(name)
        ? form.toolsEnabled.filter((t) => t !== name)
        : [...form.toolsEnabled, name],
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <span className={labelCls}>Abilities <span className="text-muted-foreground/60">(hangUp always stays on)</span></span>
        <p className="mb-2 text-xs text-muted-foreground">
          Only tools checked here are available to this agent — the instructions it's given never reference
          a tool that isn't checked, so unchecking one doesn't cause a broken turn mid-call.
        </p>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {AVAILABLE_TOOL_NAMES.map((name) => (
            <label key={name} className="flex items-center gap-1.5 text-sm">
              <input type="checkbox" aria-label={name} checked={name === "hangUp" || form.toolsEnabled.includes(name)} disabled={name === "hangUp"} onChange={() => toggleTool(name)} className="accent-primary" />
              <span className="font-mono text-xs">{name}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="border-t border-border pt-5">
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
      </div>
    </div>
  );
}

function CallingModelTab({ row, form, set }: TabProps) {
  return (
    <div className="space-y-5">
      <NumberAssignment row={row} />

      <div className="border-t border-border pt-5">
        <p className="mb-3 text-xs text-muted-foreground">Retry cadence — leave blank to use the platform default. Max attempts capped at 20.</p>
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
      </div>

      <div className="border-t border-border pt-5">
        <div className="grid gap-4 sm:grid-cols-2">
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
    </div>
  );
}

// ---------------------------------------------------------------------------
// The full-page agent editor: header (title, live toggle, agent switcher,
// save, preview) + tabs. Replaces the old single accordion card.
// ---------------------------------------------------------------------------
const TABS = [
  { key: "identity", label: "Identity & Behavior" },
  { key: "voice", label: "Voice" },
  { key: "tools", label: "Tools & Guardrails" },
  { key: "calling", label: "Calling & Model" },
] as const;

function AgentEditor({ row, allRows }: { row: AgentConfigRow; allRows: AgentConfigRow[] }) {
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const [form, setForm] = useState<FormState>(() => toFormState(row));
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState<(typeof TABS)[number]["key"]>("identity");
  const [drawerOpen, setDrawerOpen] = useState(false);
  useUnsavedChanges(dirty);

  // Reset form when switching agents
  useEffect(() => {
    setForm(toFormState(row));
    setDirty(false);
    setTab("identity");
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
      queryClient.invalidateQueries({ queryKey: CONFIGS_QUERY_KEY });
      toast.success("Agent saved");
    },
    onError: (err: Error) => toast.error("Failed to save", { description: err.message }),
  });

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

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setDirty(true);
    setForm((f) => ({ ...f, [key]: value }));
  };

  const tabProps: TabProps = { row, form, set };

  return (
    <div className="page-enter space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <Link href={appPath("/agents")} className="text-muted-foreground hover:text-foreground" aria-label="Back to agents">
            <ChevronLeft className="size-4" />
          </Link>
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold leading-tight">{row.config?.name || row.templateName}</h1>
            <p className="truncate text-xs text-muted-foreground">{row.templateDescription}</p>
          </div>
          <label className="ml-2 flex shrink-0 items-center gap-2 text-sm font-medium">
            <Switch checked={form.enabled} onCheckedChange={(v) => set("enabled", v)} aria-label="Agent enabled" />
            {form.enabled ? "Live" : "Paused"}
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {allRows.length > 1 && (
            <Select value={row.templateKey} onValueChange={(key) => setLocation(appPath(`/agents/${key}`))}>
              <SelectTrigger className="w-[220px]" aria-label="Switch agent">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {allRows.map((r) => (
                  <SelectItem key={r.templateKey} value={r.templateKey}>
                    <span className="flex items-center gap-2">
                      {r.config?.name || r.templateName}
                      {r.config?.enabled === false && <Badge variant="secondary" className="text-[10px] px-1.5 py-0">Paused</Badge>}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <PreviewButton onClick={() => setDrawerOpen(true)} />
          <Button onClick={() => save.mutate()} disabled={save.isPending || !dirty} size="sm">
            {save.isPending && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
            {!dirty && save.isSuccess ? "Saved" : "Save changes"}
          </Button>
        </div>
      </div>

      <PreviewDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        templateName={row.config?.name || row.templateName}
        chatFetchFn={chatFetchFn}
        testCallTokenFetchFn={testCallTokenFetchFn}
        testCallPhoneFetchFn={testCallPhoneFetchFn}
      />

      {/* Tabs — everything reachable by one click, nothing behind "Advanced" */}
      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
        <TabsList className="grid w-full grid-cols-2 sm:grid-cols-4">
          {TABS.map((t) => (
            <TabsTrigger key={t.key} value={t.key}>{t.label}</TabsTrigger>
          ))}
        </TabsList>

        <div className="card-weeber mt-4 p-6">
          <TabsContent value="identity"><IdentityTab {...tabProps} /></TabsContent>
          <TabsContent value="voice"><VoiceTab {...tabProps} /></TabsContent>
          <TabsContent value="tools"><ToolsGuardrailsTab {...tabProps} /></TabsContent>
          <TabsContent value="calling"><CallingModelTab {...tabProps} /></TabsContent>
        </div>
      </Tabs>

      {/* Bottom save, mirrored for long tab content so you don't have to
       * scroll back up — same mutation/state as the header's button. */}
      <div className="flex items-center justify-end border-t border-border pt-4">
        <Button onClick={() => save.mutate()} disabled={save.isPending || !dirty} size="sm">
          {save.isPending && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
          {!dirty && save.isSuccess ? "Saved" : "Save changes"}
        </Button>
      </div>
    </div>
  );
}

/** `/app/agents/:agentKey` — the real page. */
export function UserAgentDetailPage() {
  const [, setLocation] = useLocation();
  const [, params] = useRoute<{ agentKey: string }>(appPath("/agents/:agentKey"));
  const agentKey = params?.agentKey;
  const configs = useAgentConfigs();
  const rows = configs.data?.agentConfigs ?? [];
  const activeRow = rows.find((r) => r.templateKey === agentKey) ?? null;

  // Bad/stale agentKey (e.g. deleted template) once configs have loaded —
  // fall back to the first real agent instead of a dead end.
  const firstKey = rows[0]?.templateKey;
  useEffect(() => {
    if (!configs.isLoading && !configs.isError && firstKey && !activeRow) {
      setLocation(appPath(`/agents/${firstKey}`), { replace: true });
    }
  }, [configs.isLoading, configs.isError, firstKey, activeRow, setLocation]);

  if (configs.isLoading) return <SkeletonCards count={1} lines={6} />;
  if (configs.isError) {
    return <EmptyState title="Couldn't load your agents" description="Something went wrong reaching the server — try refreshing." />;
  }
  if (!activeRow) return <SkeletonCards count={1} lines={6} />;

  return <AgentEditor key={activeRow.templateKey} row={activeRow} allRows={rows} />;
}
