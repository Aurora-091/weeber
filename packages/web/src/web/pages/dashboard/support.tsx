import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";
import { adminHeaders } from "../../lib/admin-key";
import { PageHeader } from "../../components/shell/page-header";
import { EmptyState } from "../../components/shell/empty-state";
import { SkeletonTable } from "../../components/shell/skeletons";
import { DataTable, type Column } from "../../components/shell/data-table";
import { Badge } from "../../components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../components/ui/dialog";

type TicketRow = {
  id: number;
  orgId: string | null;
  email: string;
  subject: string;
  message: string;
  status: "open" | "closed";
  createdAt: string;
};

function formatWhen(iso: string) {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function SupportPage() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [selected, setSelected] = useState<TicketRow | null>(null);

  const tickets = useQuery<{ tickets: TicketRow[] }>({
    queryKey: ["admin-support", statusFilter],
    queryFn: async () => {
      const qs = statusFilter ? `?status=${statusFilter}` : "";
      const res = await apiFetch(`/api/voice/support${qs}`, { headers: adminHeaders() });
      if (!res.ok) throw new Error("Failed to load tickets");
      return res.json();
    },
  });

  const updateStatus = useMutation({
    mutationFn: async ({ id, status }: { id: number; status: string }) => {
      const res = await apiFetch(`/api/voice/support/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error("Failed to update ticket");
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-support"] }),
  });

  const rows = tickets.data?.tickets ?? [];
  const columns: Column<TicketRow>[] = [
    { key: "subject", header: "Subject", render: (r) => r.subject },
    { key: "email", header: "From", render: (r) => r.email },
    { key: "org", header: "Org", className: "font-mono text-xs", render: (r) => r.orgId ?? "(unauthenticated)" },
    { key: "status", header: "Status", render: (r) => <Badge variant={r.status === "open" ? "outline" : "default"}>{r.status}</Badge> },
    { key: "created", header: "Received", render: (r) => formatWhen(r.createdAt) },
    {
      key: "actions",
      header: "",
      className: "text-right",
      render: (r) => (
        <button
          onClick={() => updateStatus.mutate({ id: r.id, status: r.status === "open" ? "closed" : "open" })}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          Mark {r.status === "open" ? "closed" : "open"}
        </button>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Support"
        description="Tickets submitted from the landing page or the merchant portal."
        actions={
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="rounded-md border border-border bg-card px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring/40"
          >
            <option value="">All</option>
            <option value="open">Open</option>
            <option value="closed">Closed</option>
          </select>
        }
      />
      {tickets.isLoading && <SkeletonTable columns={6} />}
      {!tickets.isLoading && rows.length === 0 && (
        <EmptyState title="No tickets" description="Support requests will show up here as merchants submit them." />
      )}
      {rows.length > 0 && <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} onRowClick={setSelected} />}

      <Dialog open={Boolean(selected)} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{selected?.subject}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">From {selected?.email}</p>
          <p className="text-sm whitespace-pre-wrap">{selected?.message}</p>
        </DialogContent>
      </Dialog>
    </div>
  );
}
