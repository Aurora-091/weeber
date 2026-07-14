import { useState, useCallback, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  Phone, Clock, Wrench, ShieldAlert, Wallet, TrendingUp, Sparkles,
  Check, X,
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  PieChart, Pie, Cell, Legend,
} from "recharts";
import { appFetch } from "../../lib/user-session";
import { appPath } from "../../lib/route-base";
import { useUser } from "../../components/app/user-shell";
import { SetupModal } from "../../components/app/setup-modal";
import { PageHeader } from "../../components/shell/page-header";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { StatCard } from "../../components/charts/stat-card";
import { BreakdownList } from "../../components/charts/breakdown-list";
import { DateRangeSelector } from "../../components/charts/date-range-selector";

const CHART_COLORS = [
  "var(--chart-1)", "var(--chart-2)", "var(--chart-3)",
  "var(--chart-4)", "var(--chart-5)",
];

type OnboardingState = {
  steps: Record<string, boolean>;
  dismissed: boolean;
  completedAt: string | null;
};

type AnalyticsData = {
  totalCalls: number;
  totalMinutes: number;
  callsPerDay?: number[];
  minutesPerDay?: number[];
  dailyVolume?: { date: string; count: number }[];
  dispositionBreakdown: Record<string, number>;
  toolUsageCounts: Record<string, number>;
  guardrailEventCounts: Record<string, number>;
  avgLatency: {
    sttConnectMs: number | null;
    llmTtftMs: number | null;
    ttsFirstByteMs: number | null;
  };
  currency?: string | null;
  kpis?: {
    recovery?: {
      recoveredOrders: number;
      recoveredRevenue: number;
      attemptedCalls: number;
      recoveryRate: number | null;
    } | null;
    codConfirmation?: {
      confirmedOrders: number;
      codAttempted: number;
      confirmRate: number;
    } | null;
    feedback?: {
      averageRating: number;
      responses: number;
    } | null;
  };
};

const STEP_LABELS: Record<string, string> = {
  pick_vertical: "Pick your business type",
  connect_tools: "Connect your store",
  create_agent: "Turn on an agent",
  test_and_golive: "Review and go live",
};

function fmtMs(ms: number | null): string {
  return ms == null ? "—" : `${Math.round(ms)}ms`;
}

function fmtCurrency(amount: number, currency: string | null | undefined): string {
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: currency || "INR",
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${currency ?? "INR"} ${amount.toFixed(0)}`;
  }
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
    case "revenue_recovered":
      return data.kpis?.recovery
        ? { value: fmtCurrency(data.kpis.recovery.recoveredRevenue, data.currency) }
        : null;
    case "cod_confirm_rate":
      return data.kpis?.codConfirmation
        ? { value: fmtPercent(data.kpis.codConfirmation.confirmRate) }
        : null;
    case "renewals_confirmed":
      return data.kpis?.recovery
        ? { value: String(data.kpis.recovery.recoveredOrders) }
        : null;
    case "leads_qualified":
      return data.kpis?.codConfirmation
        ? { value: String(data.kpis.codConfirmation.confirmedOrders) }
        : null;
    case "avg_feedback":
      return data.kpis?.feedback
        ? { value: `${data.kpis.feedback.averageRating.toFixed(1)} / 5` }
        : null;
    default:
      return null;
  }
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
  const { vertical } = useUser();
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
  }, [onboarding.data]);

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

  return (
    <div className="page-enter space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <PageHeader
          title="Dashboard"
          description={`Last ${days} days across your voice agents.`}
        />
        <DateRangeSelector value={days} onChange={setDays} options={[7, 14, 30]} />
      </div>

      {/* Onboarding checklist */}
      {onboarding.isLoading ? (
        <Skeleton className="h-28 w-full rounded-lg" />
      ) : (
        !checklistDone &&
        !onboarding.data?.dismissed && (
          <div className="card-weeber">
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <div>
                <div className="text-sm font-medium">Finish setting up Weeber</div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {stepEntries.filter(([, done]) => done).length} of{" "}
                  {stepEntries.length || 4} steps done
                </p>
              </div>
              <button
                type="button"
                onClick={dismissChecklist}
                aria-label="Dismiss checklist"
                className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
              >
                <X className="size-4" aria-hidden />
              </button>
            </div>
            <div className="px-5 py-4">
              <ul className="space-y-2.5">
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
              <Button
                size="sm"
                variant="outline"
                className="mt-4 gap-1.5"
                onClick={() => setSetupOpen(true)}
              >
                <Sparkles className="size-3.5" aria-hidden />
                Resume setup
              </Button>
            </div>
          </div>
        )
      )}

      {/* ── Universal KPIs ── */}
      {analytics.isLoading && (
        <div className="grid gap-4 sm:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="card-weeber h-20 animate-pulse bg-muted/40" />
          ))}
        </div>
      )}

      {data && (
        <>
          <div className="grid gap-4 sm:grid-cols-4">
            <StatCard
              label="Total calls"
              value={String(data.totalCalls)}
              icon={Phone}
              sparkData={data.callsPerDay}
            />
            <StatCard
              label="Total minutes"
              value={String(data.totalMinutes)}
              icon={Clock}
              sparkData={data.minutesPerDay}
            />
            <StatCard
              label="Avg LLM TTFT"
              value={fmtMs(data.avgLatency.llmTtftMs)}
              icon={Clock}
            />
            <StatCard
              label="Avg TTS first byte"
              value={fmtMs(data.avgLatency.ttsFirstByteMs)}
              icon={Clock}
            />
          </div>

          {/* ── Vertical KPIs ── */}
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

          <div className="grid sm:grid-cols-2 gap-4">
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

            <div className="card-weeber p-4 space-y-1.5">
              <div className="flex items-center gap-1.5 text-sm font-medium mb-3">
                <Clock className="size-3.5" aria-hidden />
                Latency breakdown (avg)
              </div>
              <div className="space-y-1.5 text-xs">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">STT connect</span>
                  <span className="font-mono">{fmtMs(data.avgLatency.sttConnectMs)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">LLM time-to-first-token</span>
                  <span className="font-mono">{fmtMs(data.avgLatency.llmTtftMs)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">TTS first byte</span>
                  <span className="font-mono">{fmtMs(data.avgLatency.ttsFirstByteMs)}</span>
                </div>
              </div>
            </div>
          </div>

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
