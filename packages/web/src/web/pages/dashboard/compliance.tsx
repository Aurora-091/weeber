import { useQuery } from "@tanstack/react-query";
import { ShieldCheck, Ban, AlertTriangle, ShieldAlert } from "lucide-react";
import { apiFetch } from "../../lib/api";
import { adminHeaders } from "../../lib/admin-key";

type DncRow = {
  phoneNumber: string;
  reason: string | null;
  addedAt: string;
  source: string;
};

type ComplianceOverview = {
  dncScope: "global";
  dncCount: number;
  recentDnc: DncRow[];
  guardrailEventsByOrg: Record<string, Record<string, number>>;
  completedCallsWithoutDisposition: number;
};

function formatWhen(iso: string | null | undefined) {
  if (!iso) return "never";
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function CompliancePage() {
  const compliance = useQuery<ComplianceOverview>({
    queryKey: ["admin-compliance-overview"],
    queryFn: async () => {
      const res = await apiFetch("/api/voice/compliance/overview", { headers: adminHeaders() });
      if (!res.ok) throw new Error("Failed to load compliance overview");
      return res.json();
    },
  });

  const data = compliance.data;

  return (
    <div className="space-y-8 font-sans">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <ShieldCheck className="size-5 text-primary" />
          Compliance Oversight
        </h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-xl">
          Audit global DNC opt-out records, verify disposition status, and monitor guardrail exceptions.
        </p>
      </div>

      {compliance.isLoading && (
        <div className="rounded-lg border border-border p-6 text-center text-sm text-muted-foreground">
          Loading compliance stats…
        </div>
      )}

      {compliance.isError && (
        <div className="rounded-lg border border-destructive/20 bg-destructive/10 p-4 text-sm text-destructive">
          Failed to load compliance details.
        </div>
      )}

      {data && (
        <div className="space-y-6 content-fade-in">
          {/* Stat Cards */}
          <div className="grid gap-6 sm:grid-cols-3">
            {/* Global DNC */}
            <div className="rounded-lg border border-border bg-card p-5">
              <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                <Ban className="size-3.5" />
                Global DNC List
              </div>
              <h2 className="text-2xl font-bold tracking-tight mt-1">{data.dncCount} numbers</h2>
              <p className="text-xs text-muted-foreground mt-1">
                Active phone numbers opted out globally across all tenant campaigns.
              </p>
            </div>

            {/* Scope Badge Card */}
            <div className="rounded-lg border border-border bg-card p-5">
              <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                <ShieldCheck className="size-3.5" />
                DNC Scope Level
              </div>
              <h2 className="text-2xl font-bold tracking-tight mt-1 text-primary uppercase">{data.dncScope}</h2>
              <p className="text-xs text-muted-foreground mt-1">
                Currently operating at global scope. Per-org scopes are planned.
              </p>
            </div>

            {/* Missing Dispositions */}
            <div className="rounded-lg border border-border bg-card p-5">
              <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                <AlertTriangle className="size-3.5 text-warning" />
                Undispositioned calls
              </div>
              <h2 className="text-2xl font-bold tracking-tight mt-1">{data.completedCallsWithoutDisposition}</h2>
              <p className="text-xs text-muted-foreground mt-1">
                Completed calls missing outcome tags. Recommended for audit review.
              </p>
            </div>
          </div>

          <div className="grid gap-6 sm:grid-cols-2">
            {/* Recent DNC */}
            <div className="rounded-lg border border-border p-5 bg-card">
              <h3 className="text-sm font-semibold mb-3">Recent Global DNC Additions</h3>
              {data.recentDnc.length === 0 ? (
                <p className="text-xs text-muted-foreground">No recent numbers added.</p>
              ) : (
                <div className="divide-y divide-border border-t border-border mt-3 text-xs">
                  {data.recentDnc.map((dnc) => (
                    <div key={dnc.phoneNumber} className="py-2.5 flex justify-between items-start gap-4">
                      <div>
                        <div className="font-mono text-foreground">{dnc.phoneNumber}</div>
                        <div className="text-[10px] text-muted-foreground mt-0.5">
                          via {dnc.source} · added {formatWhen(dnc.addedAt)}
                        </div>
                      </div>
                      {dnc.reason && (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">{dnc.reason}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Guardrail events */}
            <div className="rounded-lg border border-border p-5 bg-card">
              <h3 className="text-sm font-semibold flex items-center gap-1.5 mb-3">
                <ShieldAlert className="size-4 text-warning" />
                Guardrail Exceptions by Organization
              </h3>
              {Object.keys(data.guardrailEventsByOrg).length === 0 ? (
                <p className="text-xs text-muted-foreground">No guardrail events recorded in this period.</p>
              ) : (
                <div className="divide-y divide-border border-t border-border mt-3 text-xs">
                  {Object.entries(data.guardrailEventsByOrg).map(([orgId, categories]) => (
                    <div key={orgId} className="py-2.5">
                      <div className="font-medium text-foreground mb-1.5 truncate">Workspace: {orgId}</div>
                      <div className="flex flex-wrap gap-1.5">
                        {Object.entries(categories).map(([cat, count]) => (
                          <span key={cat} className="rounded bg-warning-soft px-1.5 py-0.5 text-warning font-mono text-[10px] font-medium">
                            {cat}: {count}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
