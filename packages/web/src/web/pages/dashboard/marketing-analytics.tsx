import { useQuery } from "@tanstack/react-query";
import { Users, TrendingUp, CheckCircle2 } from "lucide-react";
import { apiFetch } from "../../lib/api";
import { adminHeaders } from "../../lib/admin-key";
import { PageHeader } from "../../components/shell/page-header";
import { StatTile } from "../../components/charts/stat-tile";
import { BarMeterList } from "../../components/charts/bar-meter";
import { SkeletonCards } from "../../components/shell/skeletons";

type MarketingSummary = {
  rangeDays: number;
  totalSignups: number;
  signupsInRange: number;
  converted: number;
  signupsByDay: Record<string, number>;
  signupsBySource: Record<string, number>;
};

/**
 * Real data only — the waitlist table is the only acquisition signal this
 * codebase actually records (no traffic/funnel tracking beyond a GTM
 * container id). Signups over time + source breakdown, nothing fabricated.
 */
export function MarketingAnalyticsPage() {
  const marketing = useQuery<MarketingSummary>({
    queryKey: ["admin-marketing-analytics"],
    queryFn: async () => {
      const res = await apiFetch("/api/voice/marketing-analytics?days=30", { headers: adminHeaders() });
      if (!res.ok) throw new Error("Failed to load marketing analytics");
      return res.json();
    },
  });

  const data = marketing.data;

  return (
    <div>
      <PageHeader
        title="Marketing Analytics"
        description="Waitlist signups \u2014 the only acquisition signal tracked today (no traffic/funnel data source is wired up yet)."
      />

      {marketing.isLoading && <SkeletonCards count={3} />}
      {data && (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-3">
            <StatTile label="Total signups" value={String(data.totalSignups)} icon={Users} />
            <StatTile label={`Signups (${data.rangeDays}d)`} value={String(data.signupsInRange)} icon={TrendingUp} />
            <StatTile label="Converted to org" value={String(data.converted)} icon={CheckCircle2} />
          </div>
          <BarMeterList title="Signups by day" counts={data.signupsByDay} />
          <BarMeterList title="Signups by source" counts={data.signupsBySource} />
        </div>
      )}
    </div>
  );
}
