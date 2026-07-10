import { useQuery } from "@tanstack/react-query";
import { Phone, Clock, Wrench, ShieldAlert } from "lucide-react";
import { appFetch } from "../../lib/merchant-session";
import { useMerchant } from "../../components/app/merchant-shell";
import { PageHeader } from "../../components/shell/page-header";
import { EmptyState } from "../../components/shell/empty-state";
import { SkeletonCards } from "../../components/shell/skeletons";

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

export function MerchantAnalyticsPage() {
  const { me } = useMerchant();

  const analytics = useQuery({
    queryKey: ["app-analytics", me.org.id],
    queryFn: async () => {
      const res = await appFetch(`/api/app/analytics?days=30`);
      if (!res.ok) throw new Error(`analytics failed (${res.status})`);
      return res.json();
    },
    refetchInterval: 15000,
  });

  const data = analytics.data && "totalCalls" in analytics.data ? analytics.data : null;

  return (
    <div>
      <PageHeader
        title="Analytics"
        description="Performance, latency, tool usage, and compliance flags for your voice agents over the last 30 days."
      />

      {analytics.isLoading && <SkeletonCards count={4} lines={3} />}

      {analytics.isError && (
        <EmptyState title="Couldn't load analytics" description="Something went wrong — refresh to try again." />
      )}

      {data && (
        <div className="space-y-6 content-fade-in">
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
