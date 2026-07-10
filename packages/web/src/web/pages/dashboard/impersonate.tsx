import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftRight, Clock, UserCheck, ShieldAlert, StopCircle } from "lucide-react";
import { apiFetch } from "../../lib/api";
import { adminHeaders } from "../../lib/admin-key";

type ImpersonationAudit = {
  id: number;
  orgId: string;
  adminActor: string;
  startedAt: string;
  endedAt: string | null;
  endedReason: string | null;
};

type ImpersonationResponse = {
  audit: ImpersonationAudit[];
  active: ImpersonationAudit[];
};

function formatWhen(iso: string | null | undefined) {
  if (!iso) return "never";
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function calculateDuration(start: string, end: string | null): string {
  const startTime = new Date(start).getTime();
  const endTime = end ? new Date(end).getTime() : Date.now();
  const diffSec = Math.floor((endTime - startTime) / 1000);
  if (diffSec < 60) return `${diffSec}s`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHour = Math.floor(diffMin / 60);
  return `${diffHour}h ${diffMin % 60}m`;
}

export function ImpersonatePage() {
  const queryClient = useQueryClient();

  const auditData = useQuery<ImpersonationResponse>({
    queryKey: ["admin-impersonation-audit"],
    queryFn: async () => {
      const res = await apiFetch("/api/voice/impersonation/audit", { headers: adminHeaders() });
      if (!res.ok) throw new Error("Failed to load audit logs");
      return res.json();
    },
    refetchInterval: 10000,
  });

  const stop = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiFetch(`/api/voice/impersonation/${id}/stop`, {
        method: "POST",
        headers: adminHeaders(),
      });
      if (!res.ok) throw new Error("Failed to stop session");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-impersonation-audit"] });
    },
  });

  const active = auditData.data?.active ?? [];
  const audit = auditData.data?.audit ?? [];

  return (
    <div className="space-y-8 font-sans">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <ArrowLeftRight className="size-5 text-primary" />
          Impersonation Audit & Control
        </h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-xl">
          Non-negotiable append-only audit trail and active kill switches for admin impersonation logs.
        </p>
      </div>

      {auditData.isLoading && (
        <div className="rounded-lg border border-border p-6 text-center text-sm text-muted-foreground">
          Loading audit trails…
        </div>
      )}

      {auditData.isError && (
        <div className="rounded-lg border border-destructive/20 bg-destructive/10 p-4 text-sm text-destructive">
          Failed to load audit trails.
        </div>
      )}

      {auditData.data && (
        <div className="space-y-6 content-fade-in">
          {/* Active Impersonation Sessions */}
          <div className="rounded-lg border border-warning/30 bg-warning/5 p-5">
            <h2 className="text-base font-semibold flex items-center gap-2 text-warning mb-4">
              <ShieldAlert className="size-5" />
              Active Impersonation Sessions ({active.length})
            </h2>
            {active.length === 0 ? (
              <p className="text-xs text-muted-foreground">No administrators are currently impersonating any merchant.</p>
            ) : (
              <div className="space-y-3">
                {active.map((session) => (
                  <div key={session.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 rounded-md border border-warning/20 bg-card p-4 text-xs">
                    <div>
                      <div className="font-semibold text-sm">Target Workspace: {session.orgId}</div>
                      <div className="text-muted-foreground mt-1 flex flex-wrap gap-x-4 gap-y-1">
                        <span className="flex items-center gap-1">
                          <UserCheck className="size-3.5 text-primary" />
                          Actor: <strong>{session.adminActor}</strong>
                        </span>
                        <span className="flex items-center gap-1">
                          <Clock className="size-3.5" />
                          Started: {formatWhen(session.startedAt)} ({calculateDuration(session.startedAt, null)} ago)
                        </span>
                      </div>
                    </div>
                    <button
                      onClick={() => stop.mutate(session.id)}
                      disabled={stop.isPending}
                      className="inline-flex items-center justify-center gap-1.5 rounded bg-destructive text-destructive-foreground px-3 py-1.5 font-medium hover:bg-destructive/90 transition-colors disabled:opacity-50"
                    >
                      <StopCircle className="size-3.5" />
                      Terminate Session
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Audit Logs History */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold">Historical Audit Log</h3>
            <div className="rounded-lg border border-border overflow-hidden bg-card">
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left text-xs">
                  <thead className="bg-muted/50 border-b border-border font-medium text-muted-foreground">
                    <tr>
                      <th className="px-4 py-3">Actor</th>
                      <th className="px-4 py-3">Target Workspace</th>
                      <th className="px-4 py-3">Start Time</th>
                      <th className="px-4 py-3">Duration</th>
                      <th className="px-4 py-3">Status / Reason</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border text-foreground">
                    {audit.map((log) => (
                      <tr key={log.id} className="hover:bg-muted/10">
                        <td className="px-4 py-3 font-semibold">{log.adminActor}</td>
                        <td className="px-4 py-3 font-mono">{log.orgId}</td>
                        <td className="px-4 py-3">{formatWhen(log.startedAt)}</td>
                        <td className="px-4 py-3 font-mono">{calculateDuration(log.startedAt, log.endedAt)}</td>
                        <td className="px-4 py-3">
                          {log.endedAt ? (
                            <span className="rounded bg-muted px-2 py-0.5 text-muted-foreground">
                              Ended ({log.endedReason || "logout"})
                            </span>
                          ) : (
                            <span className="rounded bg-success-soft px-2 py-0.5 text-success font-medium">
                              Active
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                    {audit.length === 0 && (
                      <tr>
                        <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                          No impersonation audits recorded.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
