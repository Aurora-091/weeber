import { useQuery } from "@tanstack/react-query";
import { Activity, Clock, CircleCheck as CheckCircle2, Circle as XCircle, Loader as Loader2 } from "lucide-react";
import { apiFetch } from "../../lib/api";
import { adminHeaders } from "../../lib/admin-key";

type WorkflowRun = {
  id: string;
  orgId: string | null;
  templateKey: string;
  currentNodeId: string;
  status: "running" | "waiting" | "completed" | "failed";
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
};

const STATUS_ICON: Record<string, typeof Activity> = {
  running: Loader2,
  waiting: Clock,
  completed: CheckCircle2,
  failed: XCircle,
};

const STATUS_STYLES: Record<string, string> = {
  running: "bg-blue-500/10 text-blue-600",
  waiting: "bg-amber-500/10 text-amber-600",
  completed: "bg-emerald-500/10 text-emerald-600",
  failed: "bg-red-500/10 text-red-600",
};

function formatDate(iso: string | null) {
  if (!iso) return "\u2014";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function WorkflowRunsPage() {
  const runs = useQuery<WorkflowRun[]>({
    queryKey: ["workflow-runs"],
    queryFn: async () => {
      const res = await apiFetch("/api/workflows/workflow-runs?limit=100", {
        headers: adminHeaders(),
      });
      if (!res.ok) throw new Error("Failed to fetch workflow runs");
      return res.json();
    },
    refetchInterval: 5000,
  });

  const rows = runs.data ?? [];

  return (
    <div>
      <div className="flex items-baseline justify-between mb-8">
        <div>
          <h1 className="text-2xl font-semibold">Workflow Runs</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Live execution state of graph-based workflows.
          </p>
        </div>
        <span className="text-xs font-mono text-muted-foreground">{rows.length} runs</span>
      </div>

      {runs.isLoading && <p className="text-sm text-muted-foreground">Loading...</p>}
      {!runs.isLoading && rows.length === 0 && (
        <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          No workflow runs yet. They appear when a Shopify webhook triggers a graph-based workflow.
        </div>
      )}

      {rows.length > 0 && (
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-muted-foreground text-xs uppercase tracking-wider">
              <tr>
                <th className="text-left px-4 py-3 font-medium">Status</th>
                <th className="text-left px-4 py-3 font-medium">Template</th>
                <th className="text-left px-4 py-3 font-medium">Org</th>
                <th className="text-left px-4 py-3 font-medium">Current Node</th>
                <th className="text-left px-4 py-3 font-medium">Next Run</th>
                <th className="text-left px-4 py-3 font-medium">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((run) => {
                const Icon = STATUS_ICON[run.status] ?? Activity;
                return (
                  <tr key={run.id} className="hover:bg-muted/20 transition-colors">
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-medium ${STATUS_STYLES[run.status] ?? ""}`}>
                        <Icon className={`w-3 h-3 ${run.status === "running" ? "animate-spin" : ""}`} />
                        {run.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">{run.templateKey}</td>
                    <td className="px-4 py-3 text-muted-foreground">{run.orgId ?? "\u2014"}</td>
                    <td className="px-4 py-3 font-mono text-xs">{run.currentNodeId}</td>
                    <td className="px-4 py-3 text-muted-foreground">{formatDate(run.nextRunAt)}</td>
                    <td className="px-4 py-3 text-muted-foreground">{formatDate(run.createdAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
