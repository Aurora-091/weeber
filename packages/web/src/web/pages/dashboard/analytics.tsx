import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { BarChart3, Phone, Clock, Wrench, ShieldAlert } from "lucide-react";
import { api, apiFetch } from "../../lib/api";
import { adminHeaders } from "../../lib/admin-key";
import { useSelectedOrgId } from "../../lib/org-id";

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

export function AnalyticsPage() {
  const [orgId, setOrgId] = useSelectedOrgId();

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
    queryKey: ["analytics", orgId],
    enabled: Boolean(orgId),
    queryFn: async () => {
      // Raw fetch, not the typed RPC client — same reason as agents.tsx's
      // save mutation (path param + query string, no validator middleware
      // declared, so hc doesn't infer a combined input type here).
      const res = await apiFetch(`/api/voice/orgs/${encodeURIComponent(orgId)}/analytics?days=30`, { headers: adminHeaders() });
      return res.json();
    },
    refetchInterval: 15000,
  });
  const data = analytics.data && "totalCalls" in analytics.data ? analytics.data : null;

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <BarChart3 className="size-5 text-primary" />
          Analytics
        </h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-xl">Last 30 days across every agent for this org.</p>
      </div>

      <div className="mb-6 max-w-xs">
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

      {!orgId && <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">Select an org to see its analytics.</div>}

      {orgId && analytics.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}

      {data && (
        <div className="space-y-6">
          <div className="grid sm:grid-cols-4 gap-4">
            <StatCard label="Total calls" value={String(data.totalCalls)} icon={Phone} />
            <StatCard label="Total minutes" value={String(data.totalMinutes)} icon={Clock} />
            <StatCard label="Avg LLM TTFT" value={fmtMs(data.avgLatency.llmTtftMs)} icon={Clock} />
            <StatCard label="Avg TTS first byte" value={fmtMs(data.avgLatency.ttsFirstByteMs)} icon={Clock} />
          </div>

          <div className="grid sm:grid-cols-2 gap-4">
            <BreakdownList title="Call outcomes" counts={data.dispositionBreakdown} />
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
