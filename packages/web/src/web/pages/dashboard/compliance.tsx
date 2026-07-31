import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ShieldCheck, Ban, TriangleAlert as AlertTriangle, ShieldAlert, Download, Search, FileCheck, PhoneOff, Activity } from "lucide-react";
import { apiFetch } from "../../lib/api";
import { adminHeaders } from "../../lib/admin-key";
import { blockReasonMeta } from "../../lib/block-reasons";
import { formatDateTime } from "../../lib/format";

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

type BlockedCall = {
  id: number;
  orgId: string | null;
  toNumber: string;
  workflowName: string;
  status: string;
  attempt: number;
  maxAttempts: number;
  runAt: string;
  lastBlockReason: string | null;
  lastBlockDetail: string | null;
  blockedAt: string | null;
};

type BlockedCallsResponse = {
  blockedCalls: BlockedCall[];
  byReason: Record<string, number>;
  total: number;
};

type ComplianceOverview = {
  dncScope: "global";
  dncCount: number;
  recentDnc: DncRow[];
  guardrailEventsByOrg: Record<string, Record<string, number>>;
  completedCallsWithoutDisposition: number;
  undispositionedCalls?: { id: number; fromNumber: string; toNumber: string; startedAt: string }[];
};

type GuardrailEvent = {
  id: number;
  callId: number;
  orgId: string | null;
  category: "topic-boundary" | "unauthorized-promise" | "prompt-injection" | "abuse" | "unknown";
  source: "agent-self-report" | "heuristic-detector";
  detail: string | null;
  firedAt: string;
};

type GuardrailEventsResponse = {
  events: GuardrailEvent[];
  byOrgCategory: Record<string, Record<string, number>>;
  bySource: Record<string, number>;
  total: number;
};

type CallHealthRow = {
  id: number;
  orgId: string | null;
  direction: "inbound" | "outbound";
  fromNumber: string;
  toNumber: string;
  status: string;
  disposition: string | null;
  healthStatus: "healthy" | "degraded" | "silent-failure" | null;
  healthReasons: string[] | null;
  startedAt: string | null;
  endedAt: string | null;
};

type CallHealthResponse = {
  calls: CallHealthRow[];
  byStatus: Record<string, number>;
  byReason: Record<string, number>;
  total: number;
};

function formatWhen(iso: string | null | undefined) {
  if (!iso) return "never";
  return formatDateTime(iso);
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

  const blockedCalls = useQuery<BlockedCallsResponse>({
    queryKey: ["admin-blocked-calls"],
    queryFn: async () => {
      const res = await apiFetch("/api/voice/compliance/blocked-calls", { headers: adminHeaders() });
      if (!res.ok) throw new Error("Failed to load blocked calls");
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

  const guardrailEvents = useQuery<GuardrailEventsResponse>({
    queryKey: ["admin-guardrail-events"],
    queryFn: async () => {
      const res = await apiFetch("/api/voice/compliance/guardrail-events", { headers: adminHeaders() });
      if (!res.ok) throw new Error("Failed to load guardrail events");
      return res.json();
    },
  });

  // Show unhealthy calls first by default — a silent-failure/degraded call is
  // the whole point of this view; the healthy majority is available via the
  // "all" filter but isn't what an operator is scanning for.
  const [healthFilter, setHealthFilter] = useState<"unhealthy" | "silent-failure" | "degraded" | "all">("unhealthy");
  const callHealth = useQuery<CallHealthResponse>({
    queryKey: ["admin-call-health", healthFilter],
    queryFn: async () => {
      // "unhealthy" is a UI convenience (silent-failure + degraded) the API
      // doesn't model directly, so fetch unfiltered and narrow client-side;
      // the specific single-status filters hit the API's ?status= param.
      const qs = healthFilter === "silent-failure" || healthFilter === "degraded" ? `?status=${healthFilter}` : "";
      const res = await apiFetch(`/api/voice/compliance/call-health${qs}`, { headers: adminHeaders() });
      if (!res.ok) throw new Error("Failed to load call health");
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
            <div className="card-weeber p-5">
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
            <div className="card-weeber p-5">
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
            <div className="card-weeber p-5">
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
            <div className="card-weeber p-5">
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
            <div className="card-weeber p-5">
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

          {/* Guardrail Event Log (Phase I, 2026-07-31) — per-event detail from the
              dedicated guardrail_events table: category, source, the triggering
              detail, and the call it belongs to. This is the exportable compliance
              artifact; the by-org counts panel above is the at-a-glance rollup. */}
          <div className="card-weeber p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <ShieldAlert className="size-4 text-warning" />
                <h3 className="text-sm font-semibold">Guardrail Event Log</h3>
              </div>
              {guardrailEvents.data && guardrailEvents.data.events.length > 0 && (
                <button
                  onClick={() =>
                    downloadCsv(
                      "guardrail-events.csv",
                      ["Event ID", "Call ID", "Org", "Category", "Source", "Detail", "Fired At"],
                      guardrailEvents.data!.events.map((e) => [
                        String(e.id),
                        String(e.callId),
                        e.orgId ?? "",
                        e.category,
                        e.source,
                        e.detail ?? "",
                        e.firedAt,
                      ]),
                    )
                  }
                  className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                >
                  <Download className="size-3" />
                  Export CSV
                </button>
              )}
            </div>
            <p className="text-xs text-muted-foreground max-w-2xl">
              Every moment an agent held a boundary — flagged by the agent itself (self-report) or by the
              independent prompt-injection detector — as a durable, exportable record. Distinct from the raw
              tool-call log: this is the compliance evidence trail.
            </p>

            {guardrailEvents.data && Object.keys(guardrailEvents.data.bySource).length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(guardrailEvents.data.bySource).map(([source, count]) => (
                  <span key={source} className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground font-mono text-[10px] font-medium">
                    {source}: {count}
                  </span>
                ))}
              </div>
            )}

            {guardrailEvents.isLoading && <p className="text-xs text-muted-foreground">Loading guardrail events…</p>}
            {guardrailEvents.isError && <p className="text-xs text-destructive">Failed to load guardrail events.</p>}

            {guardrailEvents.data && guardrailEvents.data.events.length === 0 ? (
              <p className="text-xs text-muted-foreground">No guardrail events recorded yet.</p>
            ) : (
              guardrailEvents.data && (
                <div className="divide-y divide-border border-t border-border text-xs">
                  {guardrailEvents.data.events.map((e) => (
                    <div key={e.id} className="py-2.5 flex justify-between items-start gap-4">
                      <div className="min-w-0">
                        <div className="text-foreground">
                          <span className="font-mono">{e.category}</span>
                          <span className="text-muted-foreground"> · call #{e.callId}</span>
                        </div>
                        <div className="text-[10px] text-muted-foreground mt-0.5 truncate">
                          org {e.orgId ?? "—"} · {e.source} · {formatWhen(e.firedAt)}
                        </div>
                        {e.detail && <div className="text-[10px] text-muted-foreground mt-1">{e.detail}</div>}
                      </div>
                      <span
                        className={`shrink-0 rounded px-1.5 py-0.5 font-medium ${
                          e.source === "heuristic-detector" ? "bg-destructive/10 text-destructive" : "bg-warning-soft text-warning"
                        }`}
                      >
                        {e.source === "heuristic-detector" ? "auto" : "agent"}
                      </span>
                    </div>
                  ))}
                </div>
              )
            )}
          </div>

          {/* Call Health / silent-failure log (Phase II, 2026-07-31) — the
              calls whose pipeline verdict is degraded or silent-failure: the
              caller-visible failures that `status` counts as "completed". Reads
              the health columns written at finalizeCall. This is the evidence
              Phase V (semantic turn-detection) is gated on. */}
          <div className="card-weeber p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <Activity className="size-4 text-warning" />
                <h3 className="text-sm font-semibold">Call Health</h3>
              </div>
              {callHealth.data && callHealth.data.calls.length > 0 && (
                <button
                  onClick={() =>
                    downloadCsv(
                      "call-health.csv",
                      ["Call ID", "Org", "Direction", "From", "To", "Status", "Health", "Reasons", "Ended At"],
                      callHealth.data!.calls.map((c) => [
                        String(c.id),
                        c.orgId ?? "",
                        c.direction,
                        c.fromNumber,
                        c.toNumber,
                        c.status,
                        c.healthStatus ?? "",
                        (c.healthReasons ?? []).join("; "),
                        c.endedAt ?? "",
                      ]),
                    )
                  }
                  className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                >
                  <Download className="size-3" />
                  Export CSV
                </button>
              )}
            </div>
            <p className="text-xs text-muted-foreground max-w-2xl">
              A call's <span className="font-mono">status</span> only says how it ended for the carrier — it counts a
              call where the caller heard dead air as "completed" all the same. This verdict, derived at call end from
              latency, turn and transcript signals, surfaces the calls where the caller never got a working agent.
            </p>

            <div className="flex flex-wrap items-center gap-1.5">
              {(["unhealthy", "silent-failure", "degraded", "all"] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setHealthFilter(f)}
                  className={`rounded-md border px-2 py-1 text-[11px] font-medium transition-colors ${
                    healthFilter === f
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:text-foreground hover:bg-muted"
                  }`}
                >
                  {f === "unhealthy" ? "degraded + silent" : f}
                </button>
              ))}
              {callHealth.data && (
                <span className="ml-auto text-[10px] text-muted-foreground font-mono">
                  {Object.entries(callHealth.data.byStatus)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join(" · ") || "no verdicts yet"}
                </span>
              )}
            </div>

            {callHealth.isLoading && <p className="text-xs text-muted-foreground">Loading call health…</p>}
            {callHealth.isError && <p className="text-xs text-destructive">Failed to load call health.</p>}

            {callHealth.data &&
              (() => {
                // "unhealthy" = client-side narrow to non-healthy; the other
                // filters are already scoped by the API query.
                const rows =
                  healthFilter === "unhealthy"
                    ? callHealth.data.calls.filter((c) => c.healthStatus !== "healthy")
                    : callHealth.data.calls;
                if (rows.length === 0) {
                  return (
                    <p className="text-xs text-muted-foreground">
                      No calls match this filter yet. Verdicts appear once calls finalize after the migration is applied.
                    </p>
                  );
                }
                return (
                  <div className="divide-y divide-border border-t border-border text-xs">
                    {rows.map((c) => (
                      <div key={c.id} className="py-2.5 flex justify-between items-start gap-4">
                        <div className="min-w-0">
                          <div className="text-foreground">
                            <span className="font-mono">call #{c.id}</span>
                            <span className="text-muted-foreground">
                              {" "}
                              · {c.direction} · {c.fromNumber} → {c.toNumber}
                            </span>
                          </div>
                          <div className="text-[10px] text-muted-foreground mt-0.5">
                            org {c.orgId ?? "—"} · status {c.status}
                            {c.disposition ? ` · ${c.disposition}` : ""} · ended {formatWhen(c.endedAt)}
                          </div>
                          {c.healthReasons && c.healthReasons.length > 0 && (
                            <ul className="text-[10px] text-muted-foreground mt-1 list-disc pl-4 space-y-0.5">
                              {c.healthReasons.map((r, i) => (
                                <li key={i}>{r}</li>
                              ))}
                            </ul>
                          )}
                        </div>
                        <span
                          className={`shrink-0 rounded px-1.5 py-0.5 font-medium ${
                            c.healthStatus === "silent-failure"
                              ? "bg-destructive/10 text-destructive"
                              : c.healthStatus === "degraded"
                                ? "bg-warning-soft text-warning"
                                : "bg-primary/10 text-primary"
                          }`}
                        >
                          {c.healthStatus ?? "unknown"}
                        </span>
                      </div>
                    ))}
                  </div>
                );
              })()}
          </div>

          {/* Blocked scheduled calls (2026-07-19) — cross-org view of calls a
              compliance gate stopped, with the persisted reason + detail. */}
          <div className="card-weeber p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <PhoneOff className="size-4 text-warning" />
                <h3 className="text-sm font-semibold">Blocked Scheduled Calls</h3>
              </div>
              {blockedCalls.data && blockedCalls.data.blockedCalls.length > 0 && (
                <button
                  onClick={() =>
                    downloadCsv(
                      "blocked-scheduled-calls.csv",
                      ["Org", "To", "Workflow", "Status", "Reason", "Detail", "Blocked At"],
                      blockedCalls.data!.blockedCalls.map((b) => [
                        b.orgId ?? "",
                        b.toNumber,
                        b.workflowName,
                        b.status,
                        b.lastBlockReason ?? "",
                        b.lastBlockDetail ?? "",
                        b.blockedAt ?? "",
                      ]),
                    )
                  }
                  className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                >
                  <Download className="size-3" />
                  Export CSV
                </button>
              )}
            </div>
            <p className="text-xs text-muted-foreground max-w-2xl">
              Every scheduled / workflow call a compliance gate stopped before it dialed, across all tenants —
              the reason it was blocked and the exact detail the gate produced. Merchants see their own rows on
              their Orders page; this is the platform-wide oversight view.
            </p>

            {blockedCalls.isLoading && <p className="text-xs text-muted-foreground">Loading blocked calls…</p>}
            {blockedCalls.isError && <p className="text-xs text-destructive">Failed to load blocked calls.</p>}

            {blockedCalls.data && blockedCalls.data.byReason && Object.keys(blockedCalls.data.byReason).length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(blockedCalls.data.byReason).map(([reason, count]) => (
                  <span key={reason} className="rounded bg-warning-soft px-1.5 py-0.5 text-warning font-mono text-[10px] font-medium">
                    {blockReasonMeta(reason).label}: {count}
                  </span>
                ))}
              </div>
            )}

            {blockedCalls.data && blockedCalls.data.blockedCalls.length === 0 ? (
              <p className="text-xs text-muted-foreground">No scheduled calls have been blocked.</p>
            ) : (
              blockedCalls.data && (
                <div className="divide-y divide-border border-t border-border text-xs">
                  {blockedCalls.data.blockedCalls.map((b) => {
                    const meta = blockReasonMeta(b.lastBlockReason);
                    return (
                      <div key={b.id} className="py-2.5 flex justify-between items-start gap-4">
                        <div className="min-w-0">
                          <div className="font-mono text-foreground">
                            {b.toNumber} <span className="text-muted-foreground">· {b.workflowName}</span>
                          </div>
                          <div className="text-[10px] text-muted-foreground mt-0.5 truncate">
                            org {b.orgId ?? "—"} · status {b.status} · attempt {b.attempt}/{b.maxAttempts} · blocked {formatWhen(b.blockedAt)}
                          </div>
                          {(b.lastBlockDetail || meta.description) && (
                            <div className="text-[10px] text-muted-foreground mt-1">{b.lastBlockDetail || meta.description}</div>
                          )}
                        </div>
                        <span className="shrink-0 rounded bg-warning-soft px-1.5 py-0.5 font-medium text-warning">{meta.label}</span>
                      </div>
                    );
                  })}
                </div>
              )
            )}
          </div>

          {/* Consent Ledger (Marketing + Consent UI plan, 2026-07-16, Part B) */}
          <div className="card-weeber p-5 space-y-4">
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
