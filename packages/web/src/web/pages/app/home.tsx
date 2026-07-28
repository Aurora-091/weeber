import { useState, useCallback, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Phone, Clock, Wrench, ShieldAlert, Wallet, TrendingUp, TrendingDown, Sparkles, Check, X, TriangleAlert, ListFilter as Filter, ShieldCheck, MessageSquare } from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  PieChart, Pie, Cell, Legend,
} from "recharts";
import { appFetch } from "../../lib/user-session";
import { appPath } from "../../lib/route-base";
import type { VerticalDefinition } from "../../lib/verticals";
import { useUser } from "../../components/app/user-shell";
import { SetupModal } from "../../components/app/setup-modal";
import { PageHeader } from "../../components/shell/page-header";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { StatCard } from "../../components/charts/stat-card";
import { BreakdownList } from "../../components/charts/breakdown-list";
import { DateRangeSelector } from "../../components/charts/date-range-selector";
import { formatMoney, formatDateTime } from "../../lib/format";

const CHART_COLORS = [
  "var(--chart-1)", "var(--chart-2)", "var(--chart-3)",
  "var(--chart-4)", "var(--chart-5)",
];

type OnboardingState = {
  steps: Record<string, boolean>;
  dismissed: boolean;
  completedAt: string | null;
};

type Kpis = {
  recovery?: {
    cartsAbandoned: number;
    recoveredOrders: number;
    recoveredRevenue: number;
    attemptedCalls: number;
    recoveryRate: number | null;
    avgOrderValue: number | null;
  } | null;
  codConfirmation?: {
    confirmedOrders: number;
    attemptedCalls: number;
    confirmRate: number;
  } | null;
  feedback?: {
    averageRating: number;
    responses: number;
  } | null;
  insuranceRenewal?: {
    attemptedCalls: number;
    confirmedCount: number;
    confirmRate: number;
  } | null;
  insuranceLeadFollowup?: {
    attemptedCalls: number;
    qualifiedCount: number;
    qualifyRate: number;
  } | null;
};

type AnalyticsData = {
  totalCalls: number;
  totalMinutes: number;
  callsPerDay?: number[];
  minutesPerDay?: number[];
  dailyVolume?: { date: string; count: number }[];
  dispositionBreakdown: Record<string, number>;
  intentBreakdown?: Record<string, number>;
  toolUsageCounts: Record<string, number>;
  guardrailEventCounts: Record<string, number>;
  avgLatency: {
    sttConnectMs: number | null;
    llmTtftMs: number | null;
    ttsFirstByteMs: number | null;
  };
  currency?: string | null;
  kpis?: Kpis;
  reliability?: {
    callsWithFailover: number;
    totalFailoverEvents: number;
    failoverRate: number | null;
  };
  // Immediately preceding window of equal length — powers "+X% vs previous
  // period" deltas (backend: org-queries.ts computeOrgAnalytics). Only the
  // scalars the deltas need, not the full charting payload.
  comparison?: {
    rangeDays: number;
    totalCalls: number;
    totalMinutes: number;
    kpis?: Kpis;
  };
};

const STEP_LABELS: Record<string, string> = {
  pick_vertical: "Pick your business type",
  connect_tools: "Connect your store",
  create_agent: "Turn on an agent",
  setup_number: "Connect a phone number",
  test_and_golive: "Review and go live",
};


function fmtCurrency(amount: number, currency: string | null | undefined, locale?: string): string {
  return formatMoney(amount, currency, locale);
}

function fmtPercent(ratio: number | null | undefined): string {
  return ratio == null ? "—" : `${Math.round(ratio * 100)}%`;
}

/** Maps a vertical dashboard.metrics key to a resolved {value, hint} from the
 *  analytics response. Returns null when the relevant kpi block is absent. */
function resolveMetric(
  key: string,
  data: AnalyticsData,
): { value: string; hint?: string } | null {
  switch (key) {
    case "carts_recovered":
      return data.kpis?.recovery
        ? { value: String(data.kpis.recovery.recoveredOrders) }
        : null;
    case "carts_abandoned":
      return data.kpis?.recovery
        ? { value: String(data.kpis.recovery.cartsAbandoned) }
        : null;
    case "revenue_recovered":
      return data.kpis?.recovery
        ? { value: fmtCurrency(data.kpis.recovery.recoveredRevenue, data.currency) }
        : null;
    case "avg_order_value":
      return data.kpis?.recovery?.avgOrderValue != null
        ? { value: fmtCurrency(data.kpis.recovery.avgOrderValue, data.currency) }
        : null;
    case "recovery_rate":
      return data.kpis?.recovery?.recoveryRate != null
        ? { value: fmtPercent(data.kpis.recovery.recoveryRate), hint: "Recovered vs. calls attempted" }
        : null;
    case "calls_per_day": {
      const days = data.dailyVolume;
      if (!days || days.length === 0) return null;
      const avg = days.reduce((sum, d) => sum + d.count, 0) / days.length;
      return { value: avg.toFixed(1) };
    }
    case "cod_confirm_rate":
      return data.kpis?.codConfirmation
        ? { value: fmtPercent(data.kpis.codConfirmation.confirmRate), hint: "Confirmed vs. calls attempted" }
        : null;
    case "cod_confirmed":
      return data.kpis?.codConfirmation
        ? { value: String(data.kpis.codConfirmation.confirmedOrders) }
        : null;
    // Fix (2026-07-18): these two used to read data.kpis.recovery/codConfirmation — Shopify
    // cart-recovery and COD-confirmation numbers — mislabeled as insurance metrics. Now backed
    // by real insurance KPIs computed in org-queries.ts's computeKpis (insuranceRenewal /
    // insuranceLeadFollowup), following the same "null when attempted=0" no-fabricated-metrics
    // rule as every other block here.
    case "renewals_confirmed":
      return data.kpis?.insuranceRenewal
        ? { value: String(data.kpis.insuranceRenewal.confirmedCount), hint: "Confirmed vs. calls attempted" }
        : null;
    case "leads_qualified":
      return data.kpis?.insuranceLeadFollowup
        ? { value: String(data.kpis.insuranceLeadFollowup.qualifiedCount), hint: "Booked an advisor callback" }
        : null;
    case "avg_feedback":
      return data.kpis?.feedback
        ? { value: `${data.kpis.feedback.averageRating.toFixed(1)} / 5` }
        : null;
    default:
      return null;
  }
}

/** The raw number behind a metric key — used for funnel stage bars, the hero
 *  band, and period-over-period deltas (where a formatted string won't do).
 *  Same keys as resolveMetric, plus the funnel-only "*_attempted" stages.
 *  Returns null under the same no-fabricated-metrics rule (absent kpi block
 *  or a genuinely unknowable ratio). */
function metricNumber(key: string, kpis: Kpis | undefined): number | null {
  const r = kpis?.recovery;
  const cod = kpis?.codConfirmation;
  const fb = kpis?.feedback;
  const ren = kpis?.insuranceRenewal;
  const lead = kpis?.insuranceLeadFollowup;
  switch (key) {
    case "carts_recovered":
      return r ? r.recoveredOrders : null;
    case "carts_abandoned":
      return r ? r.cartsAbandoned : null;
    case "revenue_recovered":
      return r ? r.recoveredRevenue : null;
    case "avg_order_value":
      return r?.avgOrderValue ?? null;
    case "recovery_rate":
      return r?.recoveryRate ?? null;
    case "recovery_attempted":
      return r ? r.attemptedCalls : null;
    case "cod_confirmed":
      return cod ? cod.confirmedOrders : null;
    case "cod_confirm_rate":
      return cod ? cod.confirmRate : null;
    case "renewals_confirmed":
      return ren ? ren.confirmedCount : null;
    case "renewal_attempted":
      return ren ? ren.attemptedCalls : null;
    case "leads_qualified":
      return lead ? lead.qualifiedCount : null;
    case "lead_attempted":
      return lead ? lead.attemptedCalls : null;
    case "avg_feedback":
      return fb ? fb.averageRating : null;
    default:
      return null;
  }
}

/** Period-over-period percentage change. Null (no delta shown) when either
 *  side is missing or the previous value is 0 — a "+∞%" jump off a zero
 *  baseline isn't an honest number, matching the file's no-fabricated rule. */
function pctDelta(current: number | null, previous: number | null): number | null {
  if (current == null || previous == null || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

function DeltaPill({ delta }: { delta: number | null }) {
  if (delta == null) return null;
  const up = delta >= 0;
  const Icon = up ? TrendingUp : TrendingDown;
  return (
    <span
      className={`inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs font-medium ${
        up ? "bg-emerald-500/10 text-emerald-600" : "bg-amber-500/10 text-amber-600"
      }`}
    >
      <Icon className="size-3" aria-hidden />
      {up ? "+" : ""}
      {delta.toFixed(1)}%
    </span>
  );
}

/** Big single headline number for the vertical (config: dashboard.hero).
 *  Hidden entirely when the KPI hasn't been earned yet (resolveMetric null). */
function HeroBand({
  hero,
  data,
  days,
}: {
  hero: NonNullable<VerticalDefinition["dashboard"]["hero"]>;
  data: AnalyticsData;
  days: number;
}) {
  const resolved = resolveMetric(hero.key, data);
  if (!resolved) return null;
  const delta = pctDelta(metricNumber(hero.key, data.kpis), metricNumber(hero.key, data.comparison?.kpis));
  return (
    <div className="card-weeber flex items-start justify-between gap-4 p-6">
      <div>
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{hero.label}</div>
        <div className="mt-2 flex items-baseline gap-3">
          <span className="text-4xl font-semibold tracking-tight">{resolved.value}</span>
          <DeltaPill delta={delta} />
        </div>
        {hero.sublabel && <p className="mt-1.5 text-sm text-muted-foreground">{hero.sublabel}</p>}
        {delta != null && <p className="mt-0.5 text-xs text-muted-foreground">vs. previous {days} days</p>}
      </div>
      <div className="shrink-0 rounded-full bg-primary/10 p-3 text-primary">
        <TrendingUp className="size-5" aria-hidden />
      </div>
    </div>
  );
}

/** Ordered conversion funnel (config: dashboard.funnel). Each stage shows its
 *  raw count and the stage-over-stage conversion %. Hidden when no stage
 *  resolves a number. */
function FunnelCard({
  funnel,
  data,
}: {
  funnel: NonNullable<VerticalDefinition["dashboard"]["funnel"]>;
  data: AnalyticsData;
}) {
  const stages = funnel.stages
    .map((s) => ({ ...s, value: metricNumber(s.key, data.kpis) }))
    .filter((s): s is { key: string; label: string; value: number } => s.value != null);
  if (stages.length === 0) return null;
  const max = Math.max(1, ...stages.map((s) => s.value));
  return (
    <div className="card-weeber p-5">
      <div className="mb-4 flex items-center gap-1.5 text-sm font-medium">
        <Filter className="size-3.5" aria-hidden />
        {funnel.title}
      </div>
      <div className="space-y-3">
        {stages.map((s, i) => {
          const prev = i > 0 ? stages[i - 1].value : null;
          const conv = prev != null && prev > 0 ? (s.value / prev) * 100 : null;
          return (
            <div key={s.key}>
              <div className="mb-1 flex items-baseline justify-between text-xs">
                <span className="text-muted-foreground">{s.label}</span>
                <span className="font-medium tabular-nums">
                  {s.value.toLocaleString("en-IN")}
                  {conv != null && <span className="ml-2 font-normal text-muted-foreground">{conv.toFixed(0)}%</span>}
                </span>
              </div>
              <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary/70 transition-all"
                  style={{ width: `${Math.max(4, (s.value / max) * 100)}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Provider reliability — how often calls stayed on their primary STT/TTS
 *  provider vs. failing over to a backup. Universal (call-level fact, not a
 *  per-vertical business metric). Hidden when there are no calls in range. */
function ReliabilityCard({ reliability }: { reliability: AnalyticsData["reliability"] }) {
  if (!reliability || reliability.failoverRate == null) return null;
  const onPrimaryPct = Math.round((1 - reliability.failoverRate) * 100);
  return (
    <div className="card-weeber p-5">
      <div className="mb-3 flex items-center gap-1.5 text-sm font-medium">
        <ShieldCheck className="size-3.5" aria-hidden />
        Call reliability
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-semibold tracking-tight">{onPrimaryPct}%</span>
        <span className="text-xs text-muted-foreground">of calls stayed on the primary provider</span>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {reliability.callsWithFailover} call{reliability.callsWithFailover === 1 ? "" : "s"} switched to a backup provider
        mid-call ({reliability.totalFailoverEvents} failover event{reliability.totalFailoverEvents === 1 ? "" : "s"}).
      </p>
    </div>
  );
}

function useDays(defaultDays = 30): [number, (d: number) => void] {
  const params = new URLSearchParams(window.location.search);
  const initial = Number(params.get("days")) || defaultDays;
  const [days, _set] = useState(initial);
  const set = useCallback((d: number) => {
    _set(d);
    const url = new URL(window.location.href);
    url.searchParams.set("days", String(d));
    window.history.replaceState(null, "", url.toString());
  }, []);
  return [days, set];
}

export function UserHomePage() {
  const { vertical, me } = useUser();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const [setupOpen, setSetupOpen] = useState(false);
  const [days, setDays] = useDays(30);

  const forceSetup = new URLSearchParams(window.location.search).get("setup") === "1";

  const onboarding = useQuery<OnboardingState>({
    queryKey: ["app-onboarding"],
    queryFn: async () => {
      const res = await appFetch("/api/app/onboarding");
      if (!res.ok) throw new Error(`${res.status}`);
      return res.json();
    },
  });

  const analytics = useQuery<AnalyticsData>({
    queryKey: ["app-analytics", days],
    queryFn: async () => {
      const res = await appFetch(`/api/app/analytics?days=${days}`);
      if (!res.ok) throw new Error(`${res.status}`);
      return res.json();
    },
    refetchInterval: 15000,
  });

  useEffect(() => {
    // A brand-new org with no business name yet must set one before anything
    // goes live — force setup open regardless of the dismissed flag.
    if (me.needsOnboarding) {
      setSetupOpen(true);
      return;
    }
    if (!onboarding.data) return;
    const steps = onboarding.data.steps ?? {};
    const incomplete = !Object.values(steps).every(Boolean) || Object.keys(steps).length === 0;
    if (forceSetup || (incomplete && !onboarding.data.dismissed)) {
      setSetupOpen(true);
    }
    if (forceSetup) {
      const url = new URL(window.location.href);
      url.searchParams.delete("setup");
      window.history.replaceState(null, "", url.toString());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onboarding.data, me.needsOnboarding]);

  const steps = onboarding.data?.steps ?? {};
  const stepEntries = Object.entries(steps);
  const checklistDone =
    stepEntries.length > 0 && stepEntries.every(([, done]) => done);

  function dismissChecklist() {
    appFetch("/api/app/onboarding", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dismissed: true }),
    }).then(() => queryClient.invalidateQueries({ queryKey: ["app-onboarding"] }));
  }

  const data = analytics.data && "totalCalls" in analytics.data ? analytics.data : null;
  const hasData = data != null && data.totalCalls > 0;

  const outcomePieData = data
    ? Object.entries(data.dispositionBreakdown).map(([name, value]) => ({ name, value }))
    : [];

  const testModeUntil = me.org.callingWindowTestModeUntil ? new Date(me.org.callingWindowTestModeUntil) : null;
  const testModeActive = Boolean(testModeUntil && testModeUntil.getTime() > Date.now());

  return (
    <div className="page-enter space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <PageHeader
          title="Dashboard"
          description={`Last ${days} days across your voice agents.`}
        />
        <div className="flex items-center gap-2">
          {testModeActive && (
            <span
              className="inline-flex items-center gap-1.5 rounded-full border border-warning/40 bg-warning/10 px-3 py-1 text-xs font-medium text-warning"
              title={`Calling-window compliance is bypassed until ${formatDateTime(testModeUntil!)}. Turn off on the Settings page.`}
            >
              <TriangleAlert className="size-3 shrink-0" aria-hidden />
              Compliance test mode — calling window OFF
            </span>
          )}
          <DateRangeSelector value={days} onChange={setDays} options={[7, 14, 30]} />
        </div>
      </div>

      {/* Onboarding checklist */}
      {onboarding.isLoading ? (
        <Skeleton className="h-28 w-full rounded-lg" />
      ) : (
        !checklistDone &&
        !onboarding.data?.dismissed && (() => {
          const doneCount = stepEntries.filter(([, d]) => d).length;
          const total = stepEntries.length || 4;
          const pct = Math.round((doneCount / total) * 100);
          const nextStep = stepEntries.find(([, d]) => !d);
          const nextLabel = nextStep ? STEP_LABELS[nextStep[0]] || nextStep[0] : null;
          return (
            <div className="card-weeber overflow-hidden">
              <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <div className="text-sm font-medium">Finish setting up Weeber</div>
                    <span className="rounded-full bg-primary/10 px-2 py-0.5 font-mono text-[10px] font-medium text-primary tabular-nums">
                      {pct}%
                    </span>
                  </div>
                  {nextLabel && (
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      Up next: <span className="text-foreground">{nextLabel}</span>
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    size="sm"
                    className="gap-1.5"
                    onClick={() => setSetupOpen(true)}
                  >
                    <Sparkles className="size-3.5" aria-hidden />
                    Resume
                  </Button>
                  <button
                    type="button"
                    onClick={dismissChecklist}
                    aria-label="Dismiss checklist"
                    className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <X className="size-4" aria-hidden />
                  </button>
                </div>
              </div>
              <div
                className="h-1 w-full bg-muted"
                role="progressbar"
                aria-valuenow={pct}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Setup progress"
              >
                <div
                  className="h-full bg-primary transition-[width] duration-500 ease-out"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <div className="px-5 py-4">
                <ul className="grid gap-2.5 sm:grid-cols-2">
                  {stepEntries.map(([key, done]) => (
                    <li key={key} className="flex items-center gap-3">
                      <span
                        className={`flex size-5 shrink-0 items-center justify-center rounded-full transition-colors ${
                          done
                            ? "bg-success/15 text-success"
                            : "border border-border text-transparent"
                        }`}
                      >
                        {done && <Check className="size-3" aria-hidden />}
                      </span>
                      <span
                        className={`text-sm ${
                          done ? "text-muted-foreground line-through" : "text-foreground"
                        }`}
                      >
                        {STEP_LABELS[key] || key}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          );
        })()
      )}

      {/* ── KPIs ── */}
      {analytics.isLoading && (
        <div className="grid gap-4 sm:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="card-weeber h-20 animate-pulse bg-muted/40" />
          ))}
        </div>
      )}

      {data && (
        <>
          {/* Hero band — the one headline number this vertical opens the
           * dashboard for (config: dashboard.hero). Vertical-specific by
           * construction, honors the null rule. */}
          {vertical.dashboard.hero && <HeroBand hero={vertical.dashboard.hero} data={data} days={days} />}

          {/* Business/revenue metrics first — this is what a merchant
           * actually opens the dashboard to check (cart recovery, revenue,
           * abandonment), not raw call-volume/latency numbers. Those moved
           * below as secondary "usage" stats (2026-07-16, explicit user
           * decision — was previously "Universal KPIs" shown first, mixing
           * ops-facing AI-pipeline latency numbers in with them). */}
          {(() => {
            const resolved = vertical.dashboard.metrics
              .map((m) => ({ ...m, resolved: resolveMetric(m.key, data) }))
              .filter((m) => m.resolved != null);
            if (resolved.length === 0) return null;
            return (
              <div className="grid gap-4 sm:grid-cols-4">
                {resolved.map((m) => (
                  <StatCard
                    key={m.key}
                    label={m.label}
                    value={m.resolved!.value}
                    hint={m.hint ?? m.resolved!.hint}
                    trend={pctDelta(metricNumber(m.key, data.kpis), metricNumber(m.key, data.comparison?.kpis))}
                    icon={
                      m.key.includes("revenue")
                        ? Wallet
                        : m.key.includes("rate") || m.key.includes("confirm")
                          ? TrendingUp
                          : m.key.includes("feedback") || m.key.includes("avg")
                            ? Sparkles
                            : Phone
                    }
                  />
                ))}
              </div>
            );
          })()}

          {/* Vertical funnel (config: dashboard.funnel) + universal call
           * reliability, side by side. Each hides itself when it has no data,
           * so a fresh org sees neither rather than empty shells. */}
          {(vertical.dashboard.funnel || data.reliability?.failoverRate != null) && (
            <div className="grid gap-4 sm:grid-cols-2">
              {vertical.dashboard.funnel && <FunnelCard funnel={vertical.dashboard.funnel} data={data} />}
              <ReliabilityCard reliability={data.reliability} />
            </div>
          )}

          {/* Usage stats, secondary. Avg LLM TTFT / Avg TTS first byte
           * removed entirely from here (2026-07-16) — those are raw
           * AI-pipeline latency numbers, an ops/engineering concern, not a
           * merchant-facing metric. They still exist on the admin
           * dashboard (pages/dashboard/analytics.tsx), unchanged. */}
          <div className="grid gap-4 sm:grid-cols-4">
            <StatCard
              label="Total calls"
              value={String(data.totalCalls)}
              icon={Phone}
              trend={pctDelta(data.totalCalls, data.comparison?.totalCalls ?? null)}
              sparkData={data.callsPerDay}
            />
            <StatCard
              label="Total minutes"
              value={String(data.totalMinutes)}
              icon={Clock}
              trend={pctDelta(data.totalMinutes, data.comparison?.totalMinutes ?? null)}
              sparkData={data.minutesPerDay}
            />
          </div>
        </>
      )}

      {/* ── Empty state ── */}
      {data && !hasData && (
        <div className="card-weeber px-6 py-16 text-center">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-muted">
            <Phone className="size-5 text-muted-foreground" aria-hidden />
          </div>
          <h3 className="text-base font-medium">
            {vertical.dashboard.emptyState.title}
          </h3>
          <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
            {vertical.dashboard.emptyState.body}
          </p>
        </div>
      )}

      {/* ── Charts ── */}
      {hasData && (
        <div className="space-y-6 content-fade-in">
          {data.dailyVolume && data.dailyVolume.length > 0 && (
            <div className="card-weeber p-5">
              <h3 className="text-sm font-medium mb-4">Call volume</h3>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart
                  data={data.dailyVolume}
                  margin={{ top: 4, right: 12, left: 0, bottom: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
                    tickFormatter={(v: string) => v.slice(5)}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
                    allowDecimals={false}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "var(--color-card)",
                      border: "1px solid var(--color-border)",
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                  />
                  <Bar dataKey="count" fill="var(--chart-1)" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* "Latency breakdown (avg)" card (STT connect/LLM TTFT/TTS first
           * byte) removed from here 2026-07-16 — same ops/engineering
           * latency metrics as the StatCards removed above, just further
           * down the page. Still on the admin dashboard, unchanged. */}
          {outcomePieData.length > 0 && (
            <div className="card-weeber p-5">
              <h3 className="text-sm font-medium mb-4">Call outcomes</h3>
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie
                    data={outcomePieData}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    innerRadius={45}
                    outerRadius={80}
                    paddingAngle={2}
                    label={({ name, percent }: { name?: string; percent?: number }) =>
                      `${name ?? ""} (${((percent ?? 0) * 100).toFixed(0)}%)`
                    }
                    labelLine={false}
                  >
                    {outcomePieData.map((_, i) => (
                      <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{
                      background: "var(--color-card)",
                      border: "1px solid var(--color-border)",
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Why customers called — intent (WHY they called), distinct from
           * outcomes (HOW the call ended). Drops the "no-intent" bucket and
           * hides entirely if nothing else is left, so it never shows a card
           * that's just "no-intent: N". */}
          {(() => {
            const intents = Object.fromEntries(
              Object.entries(data.intentBreakdown ?? {}).filter(([k]) => k !== "no-intent"),
            );
            if (Object.keys(intents).length === 0) return null;
            return (
              <div>
                <div className="flex items-center gap-1.5 text-sm font-medium mb-3">
                  <MessageSquare className="size-3.5" aria-hidden />
                  Why customers called
                </div>
                <BreakdownList counts={intents} />
              </div>
            );
          })()}

          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <div className="flex items-center gap-1.5 text-sm font-medium mb-3">
                <Wrench className="size-3.5" aria-hidden />
                Tool usage
              </div>
              <BreakdownList counts={data.toolUsageCounts} />
            </div>
            <div>
              <div className="flex items-center gap-1.5 text-sm font-medium mb-3">
                <ShieldAlert className="size-3.5" aria-hidden />
                Guardrail events
              </div>
              <BreakdownList counts={data.guardrailEventCounts} />
            </div>
          </div>
        </div>
      )}

      <SetupModal
        open={setupOpen}
        onOpenChange={setSetupOpen}
        onFinished={() => {
          queryClient.invalidateQueries({ queryKey: ["app-onboarding"] });
          queryClient.invalidateQueries({ queryKey: ["app-analytics"] });
          navigate(appPath());
        }}
      />
    </div>
  );
}
