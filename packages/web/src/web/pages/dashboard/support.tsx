import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Send, Loader2, Mail, MailX } from "lucide-react";
import { apiFetch } from "../../lib/api";
import { adminHeaders } from "../../lib/admin-key";
import { PageHeader } from "../../components/shell/page-header";
import { EmptyState } from "../../components/shell/empty-state";
import { SkeletonTable } from "../../components/shell/skeletons";
import { DataTable, type Column } from "../../components/shell/data-table";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Textarea } from "../../components/ui/textarea";
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

type ReplyRow = {
  id: number;
  ticketId: number;
  message: string;
  sentBy: string;
  emailSent: boolean;
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

  const [replyText, setReplyText] = useState("");

  const replies = useQuery<{ replies: ReplyRow[] }>({
    queryKey: ["admin-support-replies", selected?.id],
    queryFn: async () => {
      const res = await apiFetch(`/api/voice/support/${selected!.id}/replies`, { headers: adminHeaders() });
      if (!res.ok) throw new Error("Failed to load replies");
      return res.json();
    },
    enabled: Boolean(selected),
  });

  const sendReply = useMutation({
    mutationFn: async ({ id, message }: { id: number; message: string }) => {
      const res = await apiFetch(`/api/voice/support/${id}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify({ message }),
      });
      if (!res.ok) throw new Error("Failed to send reply");
      return res.json();
    },
    onSuccess: () => {
      setReplyText("");
      queryClient.invalidateQueries({ queryKey: ["admin-support-replies", selected?.id] });
    },
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

      <Dialog
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) {
            setSelected(null);
            setReplyText("");
          }
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{selected?.subject}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">From {selected?.email}</p>
          <p className="text-sm whitespace-pre-wrap">{selected?.message}</p>

          {(replies.data?.replies?.length ?? 0) > 0 && (
            <div className="space-y-3 border-t border-border pt-3 mt-2">
              {replies.data!.replies.map((r) => (
                <div key={r.id} className="text-sm bg-card border border-border rounded-md p-3">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium text-muted-foreground">{r.sentBy}</span>
                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                      {r.emailSent ? <Mail className="size-3" /> : <MailX className="size-3" />}
                      {r.emailSent ? "Emailed" : "Not sent — no provider configured"}
                      {" \u00b7 "}
                      {formatWhen(r.createdAt)}
                    </span>
                  </div>
                  <p className="whitespace-pre-wrap">{r.message}</p>
                </div>
              ))}
            </div>
          )}

          <div className="space-y-2 border-t border-border pt-3">
            <Textarea
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              placeholder={`Reply to ${selected?.email ?? "this ticket"}...`}
              rows={3}
              className="text-sm"
            />
            {sendReply.isError && <p className="text-xs text-destructive">Failed to send reply. Try again.</p>}
            <Button
              size="sm"
              disabled={!replyText.trim() || sendReply.isPending}
              onClick={() => selected && sendReply.mutate({ id: selected.id, message: replyText })}
              className="flex items-center gap-1.5"
            >
              {sendReply.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
              Send reply
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
