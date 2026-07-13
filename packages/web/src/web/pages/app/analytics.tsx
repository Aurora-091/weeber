import { useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { Phone, Clock, Wrench, ShieldAlert, TrendingUp, TrendingDown, ChartBar as BarChart3, PhoneOff } from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  PieChart,
  Pie,
  Cell,
  Legend,
} from "recharts";
import { appFetch } from "../../lib/user-session";
import { useUser } from "../../components/app/user-shell";
import { PageHeader } from "../../components/shell/page-header";
import { EmptyState } from "../../components/shell/empty-state";
import { SkeletonCards } from "../../components/shell/skeletons";

const CHART_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

/* ─── Date Range Selector ─── */

const DATE_RANGES = [
  { label: "7d", days: 7 },
  { label: "14d", days: 14 },
  { label: "30d", days: 30 },
] as const;

function DateRangeSelector({ value, onChange }: { value: number; onChange: (days: number) => void }) {
  return (
    <div className="flex items-center gap-1 rounded-lg border border-border bg-muted/40 p-0.5">
      {DATE_RANGES.map(({ label, days }) => (
        <button
          key={days}
          onClick={() => onChange(days)}
          className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${
            value === days
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/* ─── Mini Bar Chart ─── */

function MiniBarChart({ data, className = "" }: { data: number[]; className?: string }) {
  if (!data || data.length === 0) return null;
  const max = Math.max(1, ...data);
  return (
    <div className={`flex items-end gap-[2px] h-6 ${className}`}>
      {data.map((value, i) => (
        <div
          key={i}
          className="flex-1 min-w-[3px] max-w-[6px] rounded-sm bg-primary/60 transition-all hover:bg-primary"
          style={{ height: `${Math.max(8, (value / max) * 100)}%` }}
        />
      ))}
    </div>
  );
}

/* ─── Trend Indicator ─── */

function TrendIndicator({ trend }: { trend?: number | null }) {
  if (trend == null) {
    return <span className="text-[10px] text-muted-foreground ml-1">—</span>;
  }
  const isPositive = trend >= 0;
  const Icon = isPositive ? TrendingUp : TrendingDown;
  const color = isPositive ? "text-emerald-600" : "text-amber-600";
  return (
    <span className={`inline-flex items-center gap-0.5 text-[10px] font-medium ${color} ml-1.5`}>
      <Icon className="size-3" />
      {isPositive ? "+" : ""}
      {trend.toFixed(1)}%
    </span>
  );
}

/* ─── Stat Card ─── */

function StatCard({
  label,
  value,
  icon: Icon,
  trend,
  sparkData,
}: {
  label: string;
  value: string;
  icon: React.ComponentType<{ className?: string }>;
  trend?: number | null;
  sparkData?: number[];
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 hover:shadow-sm transition-shadow">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1.5">
        <Icon className="size-3.5" />
        {label}
      </div>
      <div className="flex items-baseline gap-1">
        <div className="text-xl font-semibold">{value}</div>
        <TrendIndicator trend={trend} />
      </div>
      {sparkData && sparkData.length > 0 && (
        <MiniBarChart data={sparkData} className="mt-2" />
      )}
    </div>
  );
}

/* ─── Breakdown List ─── */

function BreakdownList({ title, counts }: { title: string; counts: Record<string, number> }) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map(([, v]) => v));
  const total = entries.reduce((sum, [, v]) => sum + v, 0);
  return (
    <div className="rounded-lg border border-border p-4">
      {title && <div className="text-sm font-medium mb-3">{title}</div>}
      {entries.length === 0 && <p className="text-xs text-muted-foreground">No data in this range.</p>}
      <div className="space-y-2">
        {entries.map(([key, count]) => {
          const pct = total > 0 ? ((count / total) * 100).toFixed(1) : "0.0";
          return (
            <div key={key} className="group flex items-center gap-2 relative">
              <span className="text-xs font-mono w-36 truncate shrink-0">{key}</span>
              <div className="flex-1 h-2.5 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full transition-all group-hover:bg-primary/90"
                  style={{ width: `${(count / max) * 100}%` }}
                />
              </div>
              <span className="text-xs text-muted-foreground w-6 text-right shrink-0">{count}</span>
              {/* Tooltip-like percentage on hover */}
              <span className="absolute right-0 -top-5 hidden group-hover:inline-block text-[10px] font-medium bg-foreground text-background px-1.5 py-0.5 rounded shadow-sm whitespace-nowrap">
                {pct}%
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─── Empty State for Zero Calls ─── */

function AnalyticsEmptyState() {
  return (
    <div className="rounded-lg border border-border px-6 py-16 text-center content-fade-in">
      <div className="mx-auto mb-5 flex items-center justify-center gap-3">
        <div className="rounded-full bg-muted p-3">
          <PhoneOff className="size-6 text-muted-foreground" />
        </div>
        <div className="rounded-full bg-muted p-2.5">
          <BarChart3 className="size-5 text-muted-foreground/70" />
        </div>
        <div className="rounded-full bg-muted p-3">
          <Clock className="size-6 text-muted-foreground" />
        </div>
      </div>
      <h3 className="text-lg font-medium">No calls yet</h3>
      <p className="mx-auto mt-1.5 max-w-sm text-sm text-muted-foreground">
        Your agents will start showing data here once they make their first call.
      </p>
    </div>
  );
}

/* ─── Helpers ─── */

function fmtMs(ms: number | null): string {
  return ms == null ? "—" : `${Math.round(ms)}ms`;
}

/* ─── Main Page ─── */

function useDaysParam(defaultDays = 30): [number, (d: number) => void] {
  const params = new URLSearchParams(window.location.search);
  const initial = Number(params.get("days")) || defaultDays;
  const [days, _setDays] = useState(initial);
  const setDays = useCallback((d: number) => {
    _setDays(d);
    const url = new URL(window.location.href);
    url.searchParams.set("days", String(d));
    window.history.replaceState(null, "", url.toString());
  }, []);
  return [days, setDays];
}

export function UserAnalyticsPage() {
  const { me } = useUser();
  const [days, setDays] = useDaysParam(30);

  const analytics = useQuery({
    queryKey: ["app-analytics", me.org.id, days],
    queryFn: async () => {
      const res = await appFetch(`/api/app/analytics?days=${days}`);
      if (!res.ok) throw new Error(`analytics failed (${res.status})`);
      return res.json();
    },
    refetchInterval: 15000,
  });

  const data = analytics.data && "totalCalls" in analytics.data ? analytics.data : null;

  return (
    <div className="page-enter">
      <PageHeader
        title="Analytics"
        description={`Performance, latency, tool usage, and compliance flags for your voice agents over the last ${days} days.`}
      />

      {/* Date Range Selector */}
      <div className="flex items-center justify-between mb-5">
        <DateRangeSelector value={days} onChange={setDays} />
      </div>

      {analytics.isLoading && <SkeletonCards count={4} lines={3} />}

      {analytics.isError && (
        <EmptyState title="Couldn't load analytics" description="Something went wrong — refresh to try again." />
      )}

      {data && data.totalCalls === 0 && <AnalyticsEmptyState />}

      {data && data.totalCalls > 0 && (
        <div className="space-y-6 content-fade-in">
          <div className="grid sm:grid-cols-4 gap-4">
            <StatCard
              label="Total calls"
              value={String(data.totalCalls)}
              icon={Phone}
              trend={null}
              sparkData={data.callsPerDay}
            />
            <StatCard
              label="Total minutes"
              value={String(data.totalMinutes)}
              icon={Clock}
              trend={null}
              sparkData={data.minutesPerDay}
            />
            <StatCard
              label="Avg LLM TTFT"
              value={fmtMs(data.avgLatency.llmTtftMs)}
              icon={Clock}
              trend={null}
            />
            <StatCard
              label="Avg TTS first byte"
              value={fmtMs(data.avgLatency.ttsFirstByteMs)}
              icon={Clock}
              trend={null}
            />
          </div>

          {/* Call volume time-series chart */}
          {data.dailyVolume && data.dailyVolume.length > 0 && (
            <div className="rounded-lg border border-border bg-card p-5">
              <h3 className="text-sm font-medium mb-4">Call volume</h3>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={data.dailyVolume} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
                    tickFormatter={(v: string) => v.slice(5)}
                  />
                  <YAxis tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }} allowDecimals={false} />
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

          {/* Outcomes donut + Latency bar */}
          <div className="grid sm:grid-cols-2 gap-4">
            {Object.keys(data.dispositionBreakdown).length > 0 && (
              <div className="rounded-lg border border-border bg-card p-5">
                <h3 className="text-sm font-medium mb-4">Call outcomes</h3>
                <ResponsiveContainer width="100%" height={220}>
                  <PieChart>
                    <Pie
                      data={Object.entries(data.dispositionBreakdown).map(([name, value]: [string, unknown]) => ({ name, value: value as number }))}
                      dataKey="value"
                      nameKey="name"
                      cx="50%"
                      cy="50%"
                      innerRadius={45}
                      outerRadius={80}
                      paddingAngle={2}
                      label={({ name, percent }: { name?: string; percent?: number }) => `${name ?? ''} (${((percent ?? 0) * 100).toFixed(0)}%)`}
                      labelLine={false}
                    >
                      {Object.keys(data.dispositionBreakdown).map((_, i) => (
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
            <div className="space-y-4">
              <div className="rounded-lg border border-border p-4">
                <div className="flex items-center gap-1.5 text-sm font-medium mb-3">
                  <Clock className="size-3.5" />
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
          </div>

          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <div className="flex items-center gap-1.5 text-sm font-medium mb-3">
                <Wrench className="size-3.5" />
                Tool usage
              </div>
              <BreakdownList title="" counts={data.toolUsageCounts} />
            </div>
            <div>
              <div className="flex items-center gap-1.5 text-sm font-medium mb-3">
                <ShieldAlert className="size-3.5" />
                Guardrail events
              </div>
              <BreakdownList title="" counts={data.guardrailEventCounts} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
