import { useQuery } from "@tanstack/react-query";
import { DollarSign, Building2, Clock } from "lucide-react";
import { apiFetch } from "../../lib/api";
import { adminHeaders } from "../../lib/admin-key";
import { PageHeader } from "../../components/shell/page-header";
import { StatCard } from "../../components/charts/stat-card";
import { BreakdownList } from "../../components/charts/breakdown-list";
import { SkeletonCards } from "../../components/shell/skeletons";

type RevenueOverview = {
  rangeDays: number;
  note: string;
  totalOrgs: number;
  orgsByPlan: Record<string, number>;
  totalMinutesInRange: number;
  minutesByDay: Record<string, number>;
};

/**
 * Real data only — no Stripe/Razorpay integration exists yet, so this is a
 * usage-minutes proxy and plan-count breakdown, not a fabricated $ revenue
 * figure. The `note` field from the API is shown verbatim so nobody
 * mistakes this for real billing revenue.
 */
export function RevenueAnalyticsPage() {
  const revenue = useQuery<RevenueOverview>({
    queryKey: ["admin-revenue-analytics"],
    queryFn: async () => {
      const res = await apiFetch("/api/voice/revenue-analytics?days=30", { headers: adminHeaders() });
      if (!res.ok) throw new Error("Failed to load revenue analytics");
      return res.json();
    },
  });

  const data = revenue.data;

  return (
    <div>
      <PageHeader title="Revenue Analytics" description={data?.note ?? "Usage proxy \u2014 no billing integration yet."} />

      {revenue.isLoading && <SkeletonCards count={3} />}
      {data && (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label="Total orgs" value={String(data.totalOrgs)} icon={Building2} />
            <StatCard label="Usage minutes (30d)" value={String(data.totalMinutesInRange)} hint="proxy, not billed $" icon={Clock} />
            <StatCard
              label="Avg minutes / org"
              value={data.totalOrgs ? String(Math.round((data.totalMinutesInRange / data.totalOrgs) * 10) / 10) : "0"}
              icon={DollarSign}
            />
          </div>
          <BreakdownList title="Orgs by plan" counts={data.orgsByPlan} />
          <BreakdownList title="Usage minutes by day" counts={data.minutesByDay} />
        </div>
      )}
    </div>
  );
}
