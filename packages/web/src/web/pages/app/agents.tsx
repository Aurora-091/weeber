import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRoute, useLocation } from "wouter";
import { Loader as Loader2, User, Mic, Shield, PhoneCall, Info, Settings } from "lucide-react";
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
import { Breadcrumbs } from "../../components/shell/breadcrumbs";
import { PageHeader } from "../../components/shell/page-header";
import { PreviewButton } from "../../components/agent-preview/PreviewButton";
import { PreviewDrawer } from "../../components/agent-preview/PreviewDrawer";
import { ProviderFallbackOrder, ModelFallbackList, FailoverGuidanceBanner } from "../../components/agent-config/FallbackControls";
import {
  TONE_STYLES, STRICTNESS_LEVELS, AVAILABLE_TOOL_NAMES,
  RECOMMENDED_LLM_MODELS, RECOMMENDED_LANGUAGES, getRecommendedVoiceStack,
  TTS_COST_TIERS, STT_COST_TIERS,
  STT_PROVIDERS, TTS_PROVIDERS, STT_PROVIDER_LABELS, TTS_PROVIDER_LABELS,
  DEFAULT_STT_FALLBACK_ORDER, DEFAULT_TTS_FALLBACK_ORDER,
  type AgentConfigRow, type FormState,
  toFormState, formToAgentFrame, fieldCls, labelCls,
  TOOL_GROUPS, TOOL_EDITOR_META,
  GUARDRAIL_TOPIC_LINES, GUARDRAIL_INJECTION_LINES, guardrailAbuseLine,
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

// ---------------------------------------------------------------------------
// Readiness — one place that answers "is this agent actually going to work?"
//
// The detail page has always computed this inline for the single agent it
// renders. Extracted here (2026-08-01) so the overview grid can show the same
// verdict for every agent without duplicating (and eventually drifting from)
// the rule. "Live" in the DB only means the toggle is on; an agent with no
// caller ID is enabled and still cannot place a call, which is precisely the
// failure a merchant cannot see from a dropdown.
// ---------------------------------------------------------------------------

export type AgentReadiness = {
  state: "live" | "degraded" | "needs-number" | "paused";
  label: string;
  /** One merchant-readable line naming the gap, or null when there is none.
   * Shared by the card and the detail banner so the two can't describe the
   * same gap differently. The link/affordance stays with each surface. */
  detail: string | null;
  /** Semantic token classes — never raw Tailwind colours on product surfaces. */
  pillCls: string;
  dotCls: string;
};

/**
 * Capabilities the agent's own row cannot answer — they live on the org, and
 * their absence silently *narrows* the agent rather than stopping it.
 *
 * Required, not optional: an optional bag would default to "no gaps", which is
 * exactly how a new surface would quietly go back to rendering a narrowed agent
 * as fully Live. Make the caller state what it knows.
 */
export type AgentCapabilityContext = {
  /** Is `transferToHuman` in this agent's enabled tool list? */
  transferToHumanEnabled: boolean;
  /** Is `orgs.human_transfer_number` set? NULL on every production org as of
   * 2026-08-12, which is what makes this the gap worth surfacing first. */
  hasHumanTransferNumber: boolean;
};

/** The classification itself, on plain booleans. The detail page passes live
 * form state (so the banner tracks an unsaved toggle); the grid passes what's
 * saved. Both go through here so they can't disagree.
 *
 * Precedence is paused → needs-number → degraded → live, i.e. always report the
 * gap that bites first. A paused agent isn't "limited", and an agent that can't
 * dial at all shouldn't be described by what it can't do *during* a call.
 *
 * "degraded" exists because ADR-105 narrows `transferToHuman` out of the tool
 * set at call time when the org has no transfer number: the agent dials, talks,
 * qualifies a lead, and then has nowhere to send it — and the previous readiness
 * model rendered that agent as a green "Live" pill. A state that only knows
 * `enabled` + caller ID cannot describe a call that connects and then dead-ends.
 */
export function classifyReadiness(
  enabled: boolean,
  hasCallerId: boolean,
  caps: AgentCapabilityContext,
): AgentReadiness {
  if (!enabled) {
    return { state: "paused", label: "Paused", detail: null, pillCls: "bg-muted text-muted-foreground", dotCls: "bg-muted-foreground/60" };
  }
  if (!hasCallerId) {
    return {
      state: "needs-number",
      label: "Needs a number",
      detail: "Turned on, but no caller ID — it can't place calls yet.",
      pillCls: "bg-warning-soft text-warning",
      dotCls: "bg-warning",
    };
  }
  if (caps.transferToHumanEnabled && !caps.hasHumanTransferNumber) {
    // Same warning tokens as needs-number on purpose: both mean "you need to do
    // something", and reusing the pair adds no new colour combination for the
    // contrast gate to check. The label carries the difference.
    return {
      state: "degraded",
      label: "Live · limited",
      detail: "Transfer to a human is on, but no transfer number is set — qualified callers can't be handed over.",
      pillCls: "bg-warning-soft text-warning",
      dotCls: "bg-warning",
    };
  }
  return { state: "live", label: "Live", detail: null, pillCls: "bg-success-soft text-success", dotCls: "bg-success" };
}

/** True when this agent will try to transfer. Mirrors the card's own default:
 * an agent that has never been saved runs on the full tool set. */
export function agentUsesTransferToHuman(row: AgentConfigRow): boolean {
  return (row.config?.toolsEnabled ?? AVAILABLE_TOOL_NAMES).includes("transferToHuman");
}

export function agentReadiness(
  row: AgentConfigRow,
  hasOrgFallbackNumber: boolean,
  hasHumanTransferNumber: boolean,
): AgentReadiness {
  // `config` is null until the merchant saves once — an unsaved agent still
  // runs on template defaults, and toFormState defaults `enabled` to true.
  return classifyReadiness(
    row.config?.enabled ?? true,
    row.config?.phoneNumberId != null || hasOrgFallbackNumber,
    { transferToHumanEnabled: agentUsesTransferToHuman(row), hasHumanTransferNumber },
  );
}

/** True when the merchant has edited the persona away from the seeded default. */
function isPersonaCustomised(row: AgentConfigRow): boolean {
  const persona = row.config?.personaPrompt;
  if (!persona) return false;
  return persona.trim() !== (row.defaultPersonaPrompt ?? "").trim();
}

function AgentCard({ row, readiness }: { row: AgentConfigRow; readiness: AgentReadiness }) {
  const name = row.config?.name || row.templateName;
  const toolCount = (row.config?.toolsEnabled ?? AVAILABLE_TOOL_NAMES).length;

  return (
    <a
      href={appPath(`/agents/${row.templateKey}`)}
      className="card-weeber flex flex-col gap-3 p-5 no-underline text-inherit focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {/* Wraps rather than truncates: the readiness pill sits beside it, and
              at a narrow card width `truncate` clipped "COD confirmation" down to
              "COD co…" — the agent's name is the one thing on the card that must
              stay readable. */}
          <h3 className="line-clamp-2 break-words text-sm font-semibold leading-snug">{name}</h3>
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground leading-relaxed">
            {row.templateDescription ?? "No description."}
          </p>
        </div>
        <span
          className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium ${readiness.pillCls}`}
        >
          <span className={`size-1.5 rounded-full ${readiness.dotCls}`} />
          {readiness.label}
        </span>
      </div>

      {readiness.detail && (
        <p className="text-[11px] text-warning leading-relaxed">{readiness.detail}</p>
      )}

      <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-[11px] text-muted-foreground">
        <span>{toolCount} {toolCount === 1 ? "ability" : "abilities"}</span>
        {row.config?.language && <span>· {row.config.language}</span>}
        {isPersonaCustomised(row) && <span>· Edited</span>}
      </div>
    </a>
  );
}

/** Bare `/app/agents` — the overview grid.
 *
 * Until 2026-08-01 this route immediately redirected to the first agent's
 * detail page, so an org with nine provisioned agents had no screen that
 * listed them: the only way to see or switch agents was a `<Select>` in the
 * detail header, and the detail page's own "Agents" breadcrumb pointed here
 * and bounced straight back. Frontend-only change — `GET /agent-configs`
 * already returns every agent merged with its template. */
export function UserAgentsPage() {
  const { vertical, me } = useUser();
  const configs = useAgentConfigs();
  const rows = configs.data?.agentConfigs ?? [];

  // Same org-level fallback the detail page uses: an agent with no number of
  // its own still dials from the org's outbound number if one exists.
  const telephony = useQuery<{ telephony: { outboundNumber: string | null } }>({
    queryKey: ["app-telephony-status"],
    queryFn: async () => {
      const res = await appFetch("/api/app/telephony/status");
      if (!res.ok) throw new Error(`telephony failed (${res.status})`);
      return (await res.json()) as { telephony: { outboundNumber: string | null } };
    },
  });
  // Don't accuse an agent of missing a caller ID before telephony resolves —
  // assume the fallback exists until we actually know it doesn't.
  const hasOrgFallbackNumber = !telephony.isSuccess || Boolean(telephony.data?.telephony?.outboundNumber);

  if (configs.isLoading) return <SkeletonCards count={6} lines={3} />;
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

  // `me` is already loaded by the shell, so the transfer-number gap costs no
  // extra request — the reason this gap is the one the classifier learned first.
  const hasHumanTransferNumber = Boolean(me.org.humanTransferNumber);

  const readiness = rows.map((r) => ({
    row: r,
    readiness: agentReadiness(r, hasOrgFallbackNumber, hasHumanTransferNumber),
  }));
  // "live" here means fully live: a degraded agent is counted separately rather
  // than folded into the green number, otherwise the strip would report the same
  // reassuring count it did before this state existed.
  const liveCount = readiness.filter((r) => r.readiness.state === "live").length;
  const degradedCount = readiness.filter((r) => r.readiness.state === "degraded").length;
  const attentionCount = readiness.filter((r) => r.readiness.state === "needs-number").length;
  const pausedCount = readiness.filter((r) => r.readiness.state === "paused").length;

  return (
    <div className="page-enter">
      <PageHeader
        title="Agents"
        description={`Your ${vertical.integrationLabel} voice agents. Open one to change what it says, how it sounds, and what it's allowed to do.`}
      />

      <div className="mb-shell-section flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span><span className="font-medium text-foreground">{liveCount}</span> live</span>
        <span><span className="font-medium text-foreground">{pausedCount}</span> paused</span>
        {attentionCount > 0 && (
          <span className="text-warning">
            <span className="font-medium">{attentionCount}</span> need a phone number
          </span>
        )}
        {degradedCount > 0 && (
          <span className="text-warning">
            <span className="font-medium">{degradedCount}</span> can't transfer to a human —{" "}
            <a href={appPath("/settings")} className="underline underline-offset-2 hover:text-foreground">
              set a transfer number
            </a>
          </span>
        )}
      </div>

      <div className="grid gap-[var(--shell-card-gap)] @xl:grid-cols-2 @4xl:grid-cols-3">
        {readiness.map(({ row, readiness: r }) => (
          <AgentCard key={row.templateKey} row={row} readiness={r} />
        ))}
      </div>
    </div>
  );
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
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground/80">
        <User className="size-4 text-muted-foreground" /> Agent Identity
      </div>
      <div className="grid gap-6 @xl:grid-cols-2">
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
      <div className="grid gap-6 @xl:grid-cols-2">
        <div>
          <label htmlFor={`greeting-${row.templateKey}`} className={labelCls}>Greeting line</label>
          <input id={`greeting-${row.templateKey}`} value={form.greetingLine} onChange={(e) => set("greetingLine", e.target.value)} placeholder="Hi, how can I help?" className={fieldCls} />
        </div>
        <div>
          <label htmlFor={`closing-${row.templateKey}`} className={labelCls}>Closing line</label>
          <input id={`closing-${row.templateKey}`} value={form.closingLine} onChange={(e) => set("closingLine", e.target.value)} placeholder="Thanks, have a great day!" className={fieldCls} />
        </div>
      </div>
      <div className="border-t border-border/50 pt-6">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground/80 mb-3">
          <Settings className="size-4 text-muted-foreground" /> Persona Prompt
        </div>
        <label htmlFor={`persona-${row.templateKey}`} className={labelCls}>
          What should this agent say and do? <span className="text-muted-foreground/60">(leave blank for the recommended script)</span>
        </label>
        <textarea id={`persona-${row.templateKey}`} value={form.personaPrompt} onChange={(e) => set("personaPrompt", e.target.value)} rows={8} placeholder={row.defaultPersonaPrompt ?? ""} className={`${fieldCls} font-mono text-xs`} />
      </div>
    </div>
  );
}

function VoiceTab({ row, form, set }: TabProps) {
  const recommended = getRecommendedVoiceStack(form.language);
  const matchesRecommended = recommended && form.sttProvider === recommended.sttProvider && form.voiceProvider === recommended.voiceProvider;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground/80">
        <Mic className="size-4 text-muted-foreground" /> Voice Provider & Language
      </div>
      <div className="grid gap-6 @xl:grid-cols-2">
        <div>
          <label htmlFor={`vp-${row.templateKey}`} className={labelCls}>Voice provider</label>
          <select id={`vp-${row.templateKey}`} value={form.voiceProvider} onChange={(e) => set("voiceProvider", e.target.value)} className={fieldCls}>
            <option value="cartesia">Cartesia ({TTS_COST_TIERS.cartesia.tier})</option>
            <option value="elevenlabs">ElevenLabs ({TTS_COST_TIERS.elevenlabs.tier})</option>
            <option value="sarvam">Sarvam — Indian-language ({TTS_COST_TIERS.sarvam.tier})</option>
          </select>
          <p className="mt-1.5 text-xs text-muted-foreground">
            {TTS_COST_TIERS[form.voiceProvider]?.note ?? ""}
          </p>
        </div>
        <div>
          <label htmlFor={`lang-${row.templateKey}`} className={labelCls}>Language</label>
          <input id={`lang-${row.templateKey}`} value={form.language} onChange={(e) => set("language", e.target.value)} placeholder="en, hi, mr…" list={`langs-${row.templateKey}`} className={fieldCls} />
          <datalist id={`langs-${row.templateKey}`}>{RECOMMENDED_LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}</datalist>
        </div>
      </div>
      <FailoverGuidanceBanner />
      <div>
        <span className={labelCls}>Voice failover order <span className="text-muted-foreground/60">(if the voice provider above fails mid-call)</span></span>
        <ProviderFallbackOrder
          primary={form.voiceProvider}
          allProviders={TTS_PROVIDERS}
          labels={TTS_PROVIDER_LABELS}
          value={form.ttsFallbackOrder}
          onChange={(next) => set("ttsFallbackOrder", next)}
          defaultOrder={DEFAULT_TTS_FALLBACK_ORDER}
        />
      </div>
      {recommended && !matchesRecommended && (
        <div className="rounded-lg border border-primary/20 border-l-2 border-l-primary bg-primary/5 px-4 py-3 text-xs">
          <div className="flex items-start gap-2.5">
            <Info className="size-4 mt-0.5 shrink-0 text-primary" />
            <div>
              <p className="text-foreground">
                <span className="font-medium">Recommended for Hindi/Hinglish:</span> ElevenLabs Scribe (speech-to-text) +
                ElevenLabs (voice) — live-tested to keep English words like "flight" or "order" in Latin script
                mid-sentence instead of transliterating them, and to avoid a known Deepgram issue misdetecting
                Hindi as Spanish.
              </p>
              <p className="mt-1.5 text-foreground/80">
                <span className="font-medium text-weeber-warning">Cost note:</span> ElevenLabs is the {TTS_COST_TIERS.elevenlabs.tier} voice
                tier — roughly 3-4x the per-minute cost of Cartesia/Sarvam ({TTS_COST_TIERS.elevenlabs.note}). This can
                use up a plan's included minutes noticeably faster; worth confirming it's accounted for before turning
                it on for a high-volume agent.
              </p>
              <button
                type="button"
                onClick={() => {
                  set("sttProvider", recommended.sttProvider);
                  set("voiceProvider", recommended.voiceProvider);
                }}
                className="mt-2 inline-flex items-center rounded-lg border border-primary/40 bg-background px-2.5 py-1 text-xs font-medium text-primary hover:bg-primary/10 transition-colors duration-150"
              >
                Use recommended (ElevenLabs)
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="border-t border-border/50 pt-6">
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
      <div className="border-t border-border/50 pt-6">
        <label htmlFor={`stt-${row.templateKey}`} className={labelCls}>Speech-to-text</label>
        <select id={`stt-${row.templateKey}`} value={form.sttProvider} onChange={(e) => set("sttProvider", e.target.value)} className={`${fieldCls} sm:max-w-xs`}>
          <option value="deepgram">Deepgram ({STT_COST_TIERS.deepgram.tier})</option>
          <option value="sarvam">Sarvam — Indian-language STT ({STT_COST_TIERS.sarvam.tier})</option>
          <option value="elevenlabs">ElevenLabs Scribe — Hindi/Hinglish code-switching ({STT_COST_TIERS.elevenlabs.tier})</option>
        </select>
        <p className="mt-1.5 text-xs text-muted-foreground">
          {STT_COST_TIERS[form.sttProvider]?.note ?? ""} — STT cost is similar across all three providers, unlike voice/TTS.
        </p>
      </div>
      <div>
        <span className={labelCls}>Speech-to-text failover order <span className="text-muted-foreground/60">(if the STT provider above fails mid-call)</span></span>
        <ProviderFallbackOrder
          primary={form.sttProvider}
          allProviders={STT_PROVIDERS}
          labels={STT_PROVIDER_LABELS}
          value={form.sttFallbackOrder}
          onChange={(next) => set("sttFallbackOrder", next)}
          defaultOrder={DEFAULT_STT_FALLBACK_ORDER}
        />
      </div>
    </div>
  );
}

/** The literal instruction line a guardrail control produces, rendered under it.
 * Mono because it is a technical string that ships verbatim to the model — the
 * design brief reserves JetBrains Mono for exactly this. */
function GuardrailConsequence({ text }: { text: string }) {
  return (
    <p className="mt-2 border-l-2 border-border pl-2.5 font-mono text-[11px] leading-snug text-muted-foreground">
      {text}
    </p>
  );
}

/** Exported only so the DEV-only preview harness (`pages/__preview.tsx`) can
 * mount this tab with local state — the real agents page needs a loaded org and
 * agent row, which the harness has no backend for. Not used in production code
 * outside this file. */
export function ToolsGuardrailsTab({ row, form, set }: TabProps) {
  function toggleTool(name: string) {
    set(
      "toolsEnabled",
      form.toolsEnabled.includes(name)
        ? form.toolsEnabled.filter((t) => t !== name)
        : [...form.toolsEnabled, name],
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2 text-sm font-medium text-foreground/80 mb-2">
          <Settings className="size-4 text-muted-foreground" /> Abilities
        </div>
        <p className="mb-4 text-xs text-muted-foreground">
          Only abilities switched on here are available to this agent — the instructions it's given never
          reference one that's off, so turning something off doesn't cause a broken turn mid-call.
          <span className="text-muted-foreground/60"> (Ending the call always stays on.)</span>
        </p>

        {/* D4: grouped by consequence, not alphabetically — the three tools
            that spend money or change an order state should not sit in the
            same undifferentiated grid as "record the caller's intent". */}
        <div className="space-y-5">
          {TOOL_GROUPS.map((group) => {
            const members = AVAILABLE_TOOL_NAMES.filter((n) => TOOL_EDITOR_META[n].group === group.key);
            if (members.length === 0) return null;
            const heavy = group.key === "side-effects";
            return (
              <div key={group.key}>
                <div className="mb-2 flex items-baseline gap-2">
                  <span className={`text-xs font-medium ${heavy ? "text-warning" : "text-foreground/70"}`}>
                    {group.label}
                  </span>
                  <span className="text-[11px] text-muted-foreground">{group.hint}</span>
                </div>
                <div className="grid gap-2 @xl:grid-cols-2">
                  {members.map((name) => {
                    const meta = TOOL_EDITOR_META[name];
                    const checked = name === "hangUp" || form.toolsEnabled.includes(name);
                    const disabled = name === "hangUp";
                    return (
                      <label
                        key={name}
                        // Raw identifier kept reachable on hover — it's what
                        // appears in call logs and API payloads, so hiding it
                        // outright would break the trail from UI to timeline.
                        title={name}
                        className={`flex items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-all duration-150 select-none ${
                          disabled ? "cursor-not-allowed opacity-70" : "cursor-pointer"
                        } ${
                          checked
                            ? heavy
                              ? "border-warning/40 bg-warning/10"
                              : "border-primary/50 bg-primary/10"
                            : "border-border bg-muted/30 hover:border-primary/30 hover:bg-muted/50"
                        }`}
                      >
                        <input
                          type="checkbox"
                          aria-label={meta.label}
                          checked={checked}
                          disabled={disabled}
                          onChange={() => toggleTool(name)}
                          className="mt-0.5 size-3.5 shrink-0 accent-primary"
                        />
                        <span className="min-w-0">
                          <span className={`block text-xs font-medium ${checked ? "text-foreground" : "text-foreground/70"}`}>
                            {meta.label}
                          </span>
                          <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
                            {meta.description}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="border-t border-border/50 pt-6">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground/80 mb-1">
          <Shield className="size-4 text-muted-foreground" /> Guardrails
        </div>
        {/* D3: each dial shows the sentence it actually writes into the prompt,
            live. A "low / medium / high" select with no consequence text is a
            control a merchant can only set by superstition. */}
        <p className="mb-4 text-xs text-muted-foreground">
          Each setting rewrites one line of your agent's instructions. The exact line it sends is shown
          underneath.
        </p>
        <div className="space-y-5">
          <div>
            <label htmlFor={`ts-${row.templateKey}`} className={labelCls}>Stay-on-topic strictness</label>
            <select id={`ts-${row.templateKey}`} value={form.topicBoundaryStrictness} onChange={(e) => set("topicBoundaryStrictness", e.target.value)} className={`${fieldCls} sm:max-w-xs`}>
              {STRICTNESS_LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
            <GuardrailConsequence text={GUARDRAIL_TOPIC_LINES[form.topicBoundaryStrictness] ?? ""} />
          </div>
          <div>
            <label htmlFor={`is-${row.templateKey}`} className={labelCls}>Manipulation sensitivity</label>
            <select id={`is-${row.templateKey}`} value={form.injectionSensitivity} onChange={(e) => set("injectionSensitivity", e.target.value)} className={`${fieldCls} sm:max-w-xs`}>
              {STRICTNESS_LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
            <GuardrailConsequence text={GUARDRAIL_INJECTION_LINES[form.injectionSensitivity] ?? ""} />
            {/* Stated plainly because the name implies more than the code does:
                the runtime injection detector is not wired to this dial and
                behaves identically at all three levels. */}
            <p className="mt-1.5 text-[11px] text-muted-foreground/80">
              This changes the wording your agent is given. It does not change the separate
              injection detector that runs on every call — that is always on, at full sensitivity.
            </p>
          </div>
          <div>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={form.abuseHandlingEnabled} onCheckedChange={(v) => set("abuseHandlingEnabled", v)} aria-label="End call on sustained abuse" />
              End call on sustained abuse
            </label>
            <GuardrailConsequence
              text={guardrailAbuseLine(
                form.abuseHandlingEnabled,
                form.toolsEnabled.includes("flagGuardrailEvent"),
              )}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function CallingModelTab({ row, form, set }: TabProps) {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground/80 mb-2">
        <PhoneCall className="size-4 text-muted-foreground" /> Caller ID
      </div>
      <NumberAssignment row={row} />

      <div className="border-t border-border/50 pt-6">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground/80 mb-3">
          <Settings className="size-4 text-muted-foreground" /> Retry Cadence
        </div>
        <p className="mb-3 text-xs text-muted-foreground">Leave blank to use the platform default. Max attempts capped at 20.</p>
        <div className="grid gap-6 @xl:grid-cols-2 @4xl:grid-cols-3">
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

      <div className="border-t border-border/50 pt-6">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground/80 mb-4">
          <Settings className="size-4 text-muted-foreground" /> LLM Provider
        </div>
        <div className="grid gap-6 @xl:grid-cols-2">
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
        {form.llmProvider === "groq" && ["hi", "hinglish"].includes(form.language.trim().toLowerCase()) && (
          <div className="mt-3 rounded-md border border-warning/30 bg-warning-soft px-3 py-2.5 text-xs">
            <p className="text-foreground">
              <span className="font-medium">Groq + Hindi/Hinglish — not yet live-verified for this platform.</span>{" "}
              Groq's fastest model (Llama 3.3 70B) officially supports Hindi, but that's tested on
              formal-language benchmarks, not the Hindi/English code-switching (Hinglish) real callers
              actually use — the exact gap that made Deepgram's "multi" STT mode unreliable for Hindi
              despite being marketed for code-switching (see the Voice tab's own recommendation). AI
              Gateway (Gemini) is the safer choice for a Hindi/Hinglish agent until Groq's conversational
              quality here has been tested the same way — Groq is a strong pick for English-language
              agents specifically, where this risk doesn't apply.
            </p>
          </div>
        )}
      </div>

      <div className="border-t border-border pt-5">
        <span className={labelCls}>LLM failover models <span className="text-muted-foreground/60">(only active when LLM provider is AI Gateway, not Groq)</span></span>
        <p className="mb-2 text-xs text-muted-foreground">
          If the model above fails, the AI Gateway tries these next, in order — its own native failover, not a custom retry.
        </p>
        <ModelFallbackList
          value={form.llmFallbackModels}
          onChange={(next) => set("llmFallbackModels", next)}
          suggestions={RECOMMENDED_LLM_MODELS.map((m) => m.model)}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The full-page agent editor: header (title, live toggle, agent switcher,
// save, preview) + tabs. Replaces the old single accordion card.
// ---------------------------------------------------------------------------
const TABS = [
  { key: "identity", label: "Identity & Behavior", icon: User },
  { key: "voice", label: "Voice", icon: Mic },
  { key: "tools", label: "Tools & Guardrails", icon: Shield },
  { key: "calling", label: "Calling & Model", icon: PhoneCall },
] as const;

function AgentEditor({ row, allRows }: { row: AgentConfigRow; allRows: AgentConfigRow[] }) {
  const queryClient = useQueryClient();
  const { me } = useUser();
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

  const testCallTokenFetchFn = (simulateFailover?: boolean) =>
    appFetch(`/api/app/agent-configs/${encodeURIComponent(row.templateKey)}/test-call-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ configOverride: formToAgentFrame(form), simulateFailover }),
    });

  const testCallPhoneFetchFn = (phone: string) =>
    appFetch(`/api/app/agent-configs/${encodeURIComponent(row.templateKey)}/test-call-phone`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, configOverride: formToAgentFrame(form) }),
    });

  // Phase III / D2: the compiled-prompt panel re-compiles whenever this key
  // changes, so it always reflects the unsaved form rather than the saved row.
  const configKey = JSON.stringify(formToAgentFrame(form));
  const compiledPromptFetchFn = () =>
    appFetch(`/api/app/agent-configs/${encodeURIComponent(row.templateKey)}/compiled-prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ configOverride: formToAgentFrame(form) }),
    });

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setDirty(true);
    setForm((f) => ({ ...f, [key]: value }));
  };

  // Readiness: "enabled" (the dispatch gate) is necessary but not sufficient —
  // an enabled agent with no caller ID to dial from still can't place a call.
  // Surface that gap here so "Live" never silently means "does nothing".
  const telephony = useQuery<{ telephony: { outboundNumber: string | null } }>({
    queryKey: ["app-telephony-status"],
    queryFn: async () => {
      const res = await appFetch("/api/app/telephony/status");
      if (!res.ok) throw new Error(`telephony failed (${res.status})`);
      return res.json();
    },
  });
  // Only trust the "no caller ID" state once telephony has actually loaded, so
  // we don't flash a false warning before the query resolves.
  const hasOrgFallbackNumber = !telephony.isSuccess || Boolean(telephony.data?.telephony?.outboundNumber);
  // Classified by the same helper the overview grid uses, so the two surfaces
  // can never disagree about when an agent is really callable. `form.enabled`
  // (not `row.config.enabled`) so the banner tracks the unsaved toggle.
  const hasCallerId = row.config?.phoneNumberId != null || hasOrgFallbackNumber;
  // `form.toolsEnabled`, not the saved row: tick transferToHuman on the Tools
  // tab and the banner should warn before you save, not after the first call
  // dead-ends.
  const readiness = classifyReadiness(form.enabled, hasCallerId, {
    transferToHumanEnabled: form.toolsEnabled.includes("transferToHuman"),
    hasHumanTransferNumber: Boolean(me.org.humanTransferNumber),
  });

  const tabProps: TabProps = { row, form, set };

  return (
    <div className="page-enter space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 pb-5">
        <div className="flex items-center gap-3 min-w-0">
          <div className="min-w-0">
            <Breadcrumbs
              className="mb-2"
              items={[
                { label: "Agents", href: appPath("/agents") },
                { label: row.config?.name || row.templateName },
              ]}
            />
            <h1 className="truncate text-xl font-bold leading-snug">{row.config?.name || row.templateName}</h1>
            <p className="truncate text-xs text-muted-foreground leading-relaxed">{row.templateDescription}</p>
          </div>
          <label className="ml-2 flex shrink-0 items-center gap-2 text-sm font-medium">
            <Switch checked={form.enabled} onCheckedChange={(v) => set("enabled", v)} aria-label="Agent enabled" />
            {/* Was a hand-rolled two-state pill on raw `emerald-*`/`zinc-*`
                values: it said "Live" whenever the toggle was on, disagreeing
                with the grid's own pill, and its dark-only colours were a
                design:guard violation. Now the shared classifier drives it. */}
            <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors duration-150 ${readiness.pillCls}`}>
              <span className={`size-1.5 rounded-full ${readiness.dotCls}`} />
              {readiness.label}
            </span>
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {allRows.length > 1 && (
            <Select value={row.templateKey} onValueChange={(key) => setLocation(appPath(`/agents/${key}`))}>
              <SelectTrigger className="h-9 w-[220px] rounded-lg" aria-label="Switch agent">
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
          <Button onClick={() => save.mutate()} disabled={save.isPending || !dirty} size="sm" className="h-9 rounded-lg shadow-sm hover:brightness-110 transition-all duration-150">
            {save.isPending && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
            {!dirty && save.isSuccess ? "Saved" : "Save changes"}
          </Button>
        </div>
      </div>

      {/* Readiness — why an agent may not actually be running even when toggled on. */}
      {readiness.state === "paused" ? (
        <div className="flex items-start gap-2.5 rounded-lg border border-border/60 bg-muted/40 px-4 py-3 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <p>
            <span className="font-medium text-foreground/80">Paused.</span> This agent won't place or receive any
            calls until you turn it on with the toggle above.
          </p>
        </div>
      ) : readiness.state === "needs-number" ? (
        // Semantic warning tokens, not raw Tailwind `amber-*`. This banner used
        // to hardcode dark-mode-only values (`text-amber-200/90` on
        // `bg-amber-500/10`), which rendered as near-white text on a pale
        // background in the light theme — effectively invisible in the mode
        // most merchants use. Found 2026-08-01 while verifying Phase III.
        <div className="flex items-start gap-2.5 rounded-lg border border-warning/30 bg-warning-soft px-4 py-3 text-xs">
          <PhoneCall className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          <p className="text-foreground/80">
            <span className="font-medium text-foreground">Live, but no phone number to call from.</span> Assign a
            caller ID on the <button type="button" onClick={() => setTab("calling")} className="underline underline-offset-2 hover:text-foreground">Calling &amp; Model</button> tab
            (or buy one on the Phone Numbers page) — until then this agent can't actually place calls.
          </p>
        </div>
      ) : readiness.state === "degraded" ? (
        // ADR-105: the backend drops `transferToHuman` from the tool set when the
        // org has no transfer number, so the agent runs a full call and then has
        // nowhere to send a qualified lead. It is not a refusal and not an error,
        // which is why it needs its own banner rather than a toast at call time.
        <div className="flex items-start gap-2.5 rounded-lg border border-warning/30 bg-warning-soft px-4 py-3 text-xs">
          <PhoneCall className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          <p className="text-foreground/80">
            <span className="font-medium text-foreground">Live, but it can't hand anyone over.</span>{" "}
            "Transfer to a human" is switched on, but your org has no transfer number, so the agent
            quietly loses that ability on every call — it ends the call politely instead of connecting
            a person.{" "}
            <a href={appPath("/settings")} className="underline underline-offset-2 hover:text-foreground">Set a transfer number in Settings</a>,
            or switch the ability off on the Tools &amp; Guardrails tab so the agent stops implying a
            handover it can't do.
          </p>
        </div>
      ) : null}

      <PreviewDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        templateName={row.config?.name || row.templateName}
        chatFetchFn={chatFetchFn}
        testCallTokenFetchFn={testCallTokenFetchFn}
        testCallPhoneFetchFn={testCallPhoneFetchFn}
        compiledPromptFetchFn={compiledPromptFetchFn}
        configKey={configKey}
      />

      {/* Tabs — everything reachable by one click, nothing behind "Advanced" */}
      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
        <TabsList className="grid w-full grid-cols-2 @2xl:grid-cols-4 rounded-full bg-muted/40 p-1 h-auto">
          {TABS.map((t) => (
            <TabsTrigger key={t.key} value={t.key} className="rounded-full data-[state=active]:bg-background data-[state=active]:shadow-sm transition-all duration-200">
              <t.icon className="size-3.5" />
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <div className="card-weeber card-weeber--editor mt-6 p-6 md:p-8">
          <TabsContent value="identity"><IdentityTab {...tabProps} /></TabsContent>
          <TabsContent value="voice"><VoiceTab {...tabProps} /></TabsContent>
          <TabsContent value="tools"><ToolsGuardrailsTab {...tabProps} /></TabsContent>
          <TabsContent value="calling"><CallingModelTab {...tabProps} /></TabsContent>
        </div>
      </Tabs>

      {/* Bottom save, mirrored for long tab content so you don't have to
       * scroll back up — same mutation/state as the header's button. */}
      <div className="flex items-center justify-end border-t border-border/60 pt-6">
        <Button onClick={() => save.mutate()} disabled={save.isPending || !dirty} size="sm" className="h-9 rounded-lg shadow-sm hover:brightness-110 transition-all duration-150">
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
