import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { adminHeaders } from "../../lib/admin-key";
import { PageHeader } from "../../components/shell/page-header";
import { EmptyState } from "../../components/shell/empty-state";
import { SkeletonTable } from "../../components/shell/skeletons";
import { DataTable, type Column } from "../../components/shell/data-table";

type LogRow = {
  id: number;
  actor: string;
  action: string;
  detail: unknown;
  createdAt: string;
};

function formatWhen(iso: string) {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/**
 * Admin action log — "who changed what," not raw process/server logs (no
 * log-shipping infra exists, and this is the more useful surface anyway).
 * Reads adminAuditLog, written from flags/broadcasts/impersonation/support
 * mutations in admin-routes.ts.
 */
export function LogsPage() {
  const logs = useQuery<{ logs: LogRow[] }>({
    queryKey: ["admin-logs"],
    queryFn: async () => {
      const res = await apiFetch("/api/voice/logs", { headers: adminHeaders() });
      if (!res.ok) throw new Error("Failed to load logs");
      return res.json();
    },
    refetchInterval: 15000,
  });

  const rows = logs.data?.logs ?? [];
  const columns: Column<LogRow>[] = [
    { key: "when", header: "When", render: (r) => formatWhen(r.createdAt) },
    { key: "actor", header: "Actor", render: (r) => r.actor },
    { key: "action", header: "Action", render: (r) => <span className="font-mono text-xs">{r.action}</span> },
    {
      key: "detail",
      header: "Detail",
      render: (r) => <span className="text-xs text-muted-foreground">{r.detail ? JSON.stringify(r.detail) : "\u2014"}</span>,
    },
  ];

  return (
    <div>
      <PageHeader title="Logs" description="Admin action audit trail — who changed what, when." />
      {logs.isLoading && <SkeletonTable columns={4} />}
      {!logs.isLoading && rows.length === 0 && (
        <EmptyState title="No admin actions logged yet" description="Every flag change, broadcast, and impersonation action shows up here." />
      )}
      {rows.length > 0 && <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />}
    </div>
  );
}
