import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChartBar as BarChart3, Phone, Clock, Wrench, ShieldAlert } from "lucide-react";
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
import { api, apiFetch } from "../../lib/api";
import { adminHeaders } from "../../lib/admin-key";
import { useSelectedOrgId } from "../../lib/org-id";

const CHART_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

function selectClass() {
  return "rounded-md border border-border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring/40 w-full";
}

function StatCard({ label, value, icon: Icon }: { label: string; value: string; icon: React.ComponentType<{ className?: string }> }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1.5">
        <Icon className="size-3.5" />
        {label}
      </div>
      <div className="text-xl font-semibold">{value}</div>
    </div>
  );
}

function BreakdownList({ title, counts }: { title: string; counts: Record<string, number> }) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map(([, v]) => v));
  return (
    <div className="rounded-lg border border-border p-4">
      {title && <div className="text-sm font-medium mb-3">{title}</div>}
      {entries.length === 0 && <p className="text-xs text-muted-foreground">No data in this range.</p>}
      <div className="space-y-2">
        {entries.map(([key, count]) => (
          <div key={key} className="flex items-center gap-2">
            <span className="text-xs font-mono w-36 truncate shrink-0">{key}</span>
            <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
              <div className="h-full bg-primary/70 rounded-full" style={{ width: `${(count / max) * 100}%` }} />
            </div>
            <span className="text-xs text-muted-foreground w-6 text-right shrink-0">{count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function fmtMs(ms: number | null): string {
  return ms == null ? "—" : `${Math.round(ms)}ms`;
}

const RANGE_OPTIONS = [
  { label: "7d", value: 7 },
  { label: "30d", value: 30 },
  { label: "90d", value: 90 },
] as const;

export function AnalyticsPage() {
  const [orgId, setOrgId] = useSelectedOrgId();
  const [days, setDays] = useState(30);

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

  const analytics = useQuery({
    queryKey: ["analytics", orgId, days],
    enabled: Boolean(orgId),
    queryFn: async () => {
      const res = await apiFetch(`/api/voice/orgs/${encodeURIComponent(orgId)}/analytics?days=${days}`, { headers: adminHeaders() });
      return res.json();
    },
    refetchInterval: 15000,
  });
  const data = analytics.data && "totalCalls" in analytics.data ? analytics.data : null;

  const dailyVolume: { date: string; count: number }[] = data?.dailyVolume ?? [];
  const outcomePieData = data
    ? Object.entries(data.dispositionBreakdown as Record<string, number>).map(([name, value]) => ({ name, value }))
    : [];
  const latencyBarData = data?.avgLatency
    ? [
        { name: "STT connect", ms: data.avgLatency.sttConnectMs ?? 0 },
        { name: "LLM TTFT", ms: data.avgLatency.llmTtftMs ?? 0 },
        { name: "TTS first byte", ms: data.avgLatency.ttsFirstByteMs ?? 0 },
      ]
    : [];

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <BarChart3 className="size-5 text-primary" />
          Analytics
        </h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-xl">Operational metrics across every agent for this org.</p>
      </div>

      <div className="flex flex-wrap items-end gap-4 mb-6">
        <div className="max-w-xs flex-1">
          <label htmlFor="org-select" className="block text-xs font-medium text-muted-foreground mb-1">Org</label>
          <select id="org-select" value={orgId} onChange={(e) => setOrgId(e.target.value)} className={selectClass()}>
            <option value="">Select an org…</option>
            {orgRows.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name ?? o.id} ({o.vertical})
              </option>
            ))}
          </select>
        </div>
        <div className="flex gap-1">
          {RANGE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setDays(opt.value)}
              className={`px-3 py-2 text-xs rounded-md border transition-colors ${
                days === opt.value
                  ? "bg-primary text-primary-foreground border-primary"
                  : "border-border text-muted-foreground hover:text-foreground hover:bg-muted"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {!orgId && <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">Select an org to see its analytics.</div>}

      {orgId && analytics.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}

      {data && (
        <div className="space-y-6">
          {/* KPI stat cards */}
          <div className="grid sm:grid-cols-4 gap-4">
            <StatCard label="Total calls" value={String(data.totalCalls)} icon={Phone} />
            <StatCard label="Total minutes" value={String(data.totalMinutes)} icon={Clock} />
            <StatCard label="Avg LLM TTFT" value={fmtMs(data.avgLatency.llmTtftMs)} icon={Clock} />
            <StatCard label="Avg TTS first byte" value={fmtMs(data.avgLatency.ttsFirstByteMs)} icon={Clock} />
          </div>

          {/* Call volume time-series chart */}
          {dailyVolume.length > 0 && (
            <div className="rounded-lg border border-border bg-card p-5">
              <h3 className="text-sm font-medium mb-4">Call volume</h3>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={dailyVolume} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
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
            {outcomePieData.length > 0 && (
              <div className="rounded-lg border border-border bg-card p-5">
                <h3 className="text-sm font-medium mb-4">Call outcomes</h3>
                <ResponsiveContainer width="100%" height={240}>
                  <PieChart>
                    <Pie
                      data={outcomePieData}
                      dataKey="value"
                      nameKey="name"
                      cx="50%"
                      cy="50%"
                      innerRadius={50}
                      outerRadius={90}
                      paddingAngle={2}
                      label={({ name, percent }: { name?: string; percent?: number }) => `${name ?? ''} (${((percent ?? 0) * 100).toFixed(0)}%)`}
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

            {latencyBarData.some((d) => d.ms > 0) && (
              <div className="rounded-lg border border-border bg-card p-5">
                <h3 className="text-sm font-medium mb-4">Average latency breakdown</h3>
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={latencyBarData} layout="vertical" margin={{ top: 4, right: 20, left: 80, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                    <XAxis type="number" tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }} unit="ms" />
                    <YAxis type="category" dataKey="name" tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }} />
                    <Tooltip
                      formatter={(value) => [`${value}ms`, "Avg"]}
                      contentStyle={{
                        background: "var(--color-card)",
                        border: "1px solid var(--color-border)",
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                    />
                    <Bar dataKey="ms" fill="var(--chart-2)" radius={[0, 3, 3, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          {/* Existing breakdown lists */}
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
