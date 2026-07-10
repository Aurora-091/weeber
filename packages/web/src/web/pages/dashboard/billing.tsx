import { useQuery } from "@tanstack/react-query";
import { Landmark } from "lucide-react";
import { apiFetch } from "../../lib/api";
import { adminHeaders } from "../../lib/admin-key";

type OrgBillingOverview = {
  id: string;
  name: string | null;
  vertical: string;
  planName: string | null;
  currency: string | null;
  calls: number;
  minutes: number;
};

type BillingOverviewResponse = {
  rangeDays: number;
  orgs: OrgBillingOverview[];
};

export function BillingPage() {
  const billing = useQuery<BillingOverviewResponse>({
    queryKey: ["admin-billing-overview"],
    queryFn: async () => {
      const res = await apiFetch("/api/voice/billing/overview?days=30", { headers: adminHeaders() });
      if (!res.ok) throw new Error("Failed to load billing overview");
      return res.json();
    },
  });

  const rows = billing.data?.orgs ?? [];
  const rangeDays = billing.data?.rangeDays ?? 30;

  return (
    <div className="space-y-6 font-sans">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Landmark className="size-5 text-primary" />
          Billing Oversight
        </h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-xl">
          Track plan subscriptions and voice minutes consumption across every tenant organization in the last {rangeDays} days.
        </p>
      </div>

      {billing.isLoading && (
        <div className="rounded-lg border border-border p-6 text-center text-sm text-muted-foreground">
          Loading billing oversight data…
        </div>
      )}

      {billing.isError && (
        <div className="rounded-lg border border-destructive/20 bg-destructive/10 p-4 text-sm text-destructive">
          Failed to load billing metrics.
        </div>
      )}

      {rows.length > 0 && (
        <div className="rounded-lg border border-border overflow-hidden bg-card content-fade-in">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-xs">
              <thead className="bg-muted/50 border-b border-border font-medium text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Organization</th>
                  <th className="px-4 py-3">Vertical</th>
                  <th className="px-4 py-3">Plan Name</th>
                  <th className="px-4 py-3">Calls ({rangeDays}d)</th>
                  <th className="px-4 py-3">Minutes ({rangeDays}d)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border text-foreground">
                {rows.map((org) => (
                  <tr key={org.id} className="hover:bg-muted/10">
                    <td className="px-4 py-3">
                      <div className="font-medium text-sm">{org.name || org.id}</div>
                      <div className="text-[10px] text-muted-foreground font-mono mt-0.5">{org.id}</div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted-foreground">
                        {org.vertical}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-semibold text-primary">{org.planName || "Starter"}</span>
                    </td>
                    <td className="px-4 py-3 font-mono">{org.calls}</td>
                    <td className="px-4 py-3 font-mono">{org.minutes} min</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
