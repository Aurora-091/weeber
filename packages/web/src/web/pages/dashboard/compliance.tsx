import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ShieldCheck, Ban, TriangleAlert as AlertTriangle, ShieldAlert, Download, Search, FileCheck } from "lucide-react";
import { apiFetch } from "../../lib/api";
import { adminHeaders } from "../../lib/admin-key";

type DncRow = {
  phoneNumber: string;
  reason: string | null;
  addedAt: string;
  source: string;
};

type ConsentRecord = {
  orgId: string;
  dataPrincipal: string;
  purpose: "service" | "transactional" | "marketing" | "underwriting" | "feedback";
  granted: boolean;
  grantedAt: string;
  expiresAt: string | null;
  version: string;
  channel: string;
  source: string;
  withdrawnAt: string | null;
};

type ConsentSummary = {
  activeByOrgPurpose: Record<string, Record<string, number>>;
  withdrawnByOrgPurpose: Record<string, Record<string, number>>;
  totalRecords: number;
};

type ComplianceOverview = {
  dncScope: "global";
  dncCount: number;
  recentDnc: DncRow[];
  guardrailEventsByOrg: Record<string, Record<string, number>>;
  completedCallsWithoutDisposition: number;
  undispositionedCalls?: { id: number; fromNumber: string; toNumber: string; startedAt: string }[];
};

function formatWhen(iso: string | null | undefined) {
  if (!iso) return "never";
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function downloadCsv(filename: string, headers: string[], rows: string[][]) {
  const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const lines = [headers.map(escape).join(","), ...rows.map((r) => r.map(escape).join(","))];
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
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

  const consentSummary = useQuery<ConsentSummary>({
    queryKey: ["admin-consent-summary"],
    queryFn: async () => {
      const res = await apiFetch("/api/voice/compliance/consent/summary", { headers: adminHeaders() });
      if (!res.ok) throw new Error("Failed to load consent summary");
      return res.json();
    },
  });

  const [principalQuery, setPrincipalQuery] = useState("");
  const [searchedPrincipal, setSearchedPrincipal] = useState<string | null>(null);
  const consentSearch = useQuery<{ principal: string; records: ConsentRecord[] }>({
    queryKey: ["admin-consent-search", searchedPrincipal],
    queryFn: async () => {
      const res = await apiFetch(`/api/voice/compliance/consent?principal=${encodeURIComponent(searchedPrincipal!)}`, {
        headers: adminHeaders(),
      });
      if (!res.ok) throw new Error("Failed to load consent records");
      return res.json();
    },
    enabled: Boolean(searchedPrincipal),
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
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                  <AlertTriangle className="size-3.5 text-warning" />
                  Undispositioned calls
                </div>
                {data.undispositionedCalls && data.undispositionedCalls.length > 0 && (
                  <button
                    onClick={() =>
                      downloadCsv(
                        "undispositioned-calls.csv",
                        ["Call ID", "From", "To", "Started At"],
                        data.undispositionedCalls!.map((c) => [String(c.id), c.fromNumber, c.toNumber, c.startedAt]),
                      )
                    }
                    className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                  >
                    <Download className="size-3" />
                    Export CSV
                  </button>
                )}
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
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold">Recent Global DNC Additions</h3>
                {data.recentDnc.length > 0 && (
                  <button
                    onClick={() =>
                      downloadCsv(
                        "dnc-list.csv",
                        ["Phone Number", "Reason", "Source", "Added At"],
                        data.recentDnc.map((d) => [d.phoneNumber, d.reason ?? "", d.source, d.addedAt]),
                      )
                    }
                    className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                  >
                    <Download className="size-3" />
                    Export CSV
                  </button>
                )}
              </div>
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

          {/* Consent Ledger (Marketing + Consent UI plan, 2026-07-16, Part B) */}
          <div className="rounded-lg border border-border p-5 bg-card space-y-4">
            <div className="flex items-center gap-1.5">
              <FileCheck className="size-4 text-primary" />
              <h3 className="text-sm font-semibold">Consent Ledger</h3>
            </div>
            <p className="text-xs text-muted-foreground max-w-2xl">
              Purpose-scoped consent records (service / transactional / marketing / underwriting / feedback) —
              consent for one purpose never satisfies a check for another. This is separate from the global
              DNC list above.
            </p>

            {consentSummary.data && (
              <div className="flex flex-wrap gap-4 text-xs">
                {Object.entries(consentSummary.data.activeByOrgPurpose).length === 0 ? (
                  <p className="text-muted-foreground">No active consent records on file yet.</p>
                ) : (
                  Object.entries(consentSummary.data.activeByOrgPurpose).map(([orgId, purposes]) => (
                    <div key={orgId} className="rounded-md border border-border px-3 py-2">
                      <div className="font-medium text-foreground mb-1 truncate max-w-[200px]">Workspace: {orgId}</div>
                      <div className="flex flex-wrap gap-1.5">
                        {Object.entries(purposes).map(([purpose, count]) => (
                          <span key={purpose} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                            {purpose}: {count}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}

            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                setSearchedPrincipal(principalQuery.trim() || null);
              }}
            >
              <input
                type="text"
                value={principalQuery}
                onChange={(e) => setPrincipalQuery(e.target.value)}
                placeholder="Search by phone number (e.g. +15551234567)"
                className="flex-1 max-w-sm rounded-md border border-border bg-background px-3 py-1.5 text-xs"
              />
              <button
                type="submit"
                className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                <Search className="size-3" />
                Search
              </button>
            </form>

            {searchedPrincipal && (
              <div className="text-xs">
                {consentSearch.isLoading && <p className="text-muted-foreground">Loading…</p>}
                {consentSearch.isError && <p className="text-destructive">Failed to load consent records.</p>}
                {consentSearch.data && consentSearch.data.records.length === 0 && (
                  <p className="text-muted-foreground">No consent records found for {searchedPrincipal}.</p>
                )}
                {consentSearch.data && consentSearch.data.records.length > 0 && (
                  <div className="divide-y divide-border border-t border-border">
                    {consentSearch.data.records.map((r, i) => {
                      const isActive = r.granted && !r.withdrawnAt && (!r.expiresAt || new Date(r.expiresAt).getTime() > Date.now());
                      return (
                        <div key={`${r.orgId}-${r.purpose}-${i}`} className="py-2.5 flex justify-between items-start gap-4">
                          <div>
                            <div className="font-mono text-foreground">
                              {r.purpose} <span className="text-muted-foreground">· org {r.orgId}</span>
                            </div>
                            <div className="text-[10px] text-muted-foreground mt-0.5">
                              via {r.channel} ({r.source}) · granted {formatWhen(r.grantedAt)} · version {r.version}
                              {r.withdrawnAt && ` · withdrawn ${formatWhen(r.withdrawnAt)}`}
                              {r.expiresAt && ` · expires ${formatWhen(r.expiresAt)}`}
                            </div>
                          </div>
                          <span
                            className={`rounded px-1.5 py-0.5 font-medium ${
                              isActive ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
                            }`}
                          >
                            {isActive ? "active" : r.withdrawnAt ? "withdrawn" : "expired"}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
