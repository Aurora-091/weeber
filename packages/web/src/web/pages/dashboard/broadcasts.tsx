import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Send, Loader2 } from "lucide-react";
import { apiFetch } from "../../lib/api";
import { adminHeaders } from "../../lib/admin-key";
import { PageHeader } from "../../components/shell/page-header";
import { EmptyState } from "../../components/shell/empty-state";
import { SkeletonTable } from "../../components/shell/skeletons";
import { DataTable, type Column } from "../../components/shell/data-table";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";

type BroadcastRow = {
  id: number;
  title: string;
  body: string;
  audience: string;
  status: "draft" | "queued" | "sent" | "failed";
  createdAt: string;
  sentAt: string | null;
};

function formatWhen(iso: string | null) {
  if (!iso) return "\u2014";
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const STATUS_VARIANT: Record<string, "default" | "outline" | "destructive"> = {
  draft: "outline",
  queued: "outline",
  sent: "default",
  failed: "destructive",
};

export function BroadcastsPage() {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [audience, setAudience] = useState("all");

  const broadcasts = useQuery<{ broadcasts: BroadcastRow[] }>({
    queryKey: ["admin-broadcasts"],
    queryFn: async () => {
      const res = await apiFetch("/api/voice/broadcasts", { headers: adminHeaders() });
      if (!res.ok) throw new Error("Failed to load broadcasts");
      return res.json();
    },
  });

  const create = useMutation({
    mutationFn: async () => {
      const res = await apiFetch("/api/voice/broadcasts", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify({ title, body, audience }),
      });
      if (!res.ok) throw new Error("Failed to create broadcast");
      return res.json();
    },
    onSuccess: () => {
      setTitle("");
      setBody("");
      queryClient.invalidateQueries({ queryKey: ["admin-broadcasts"] });
    },
  });

  const send = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiFetch(`/api/voice/broadcasts/${id}/send`, { method: "POST", headers: adminHeaders() });
      if (!res.ok) throw new Error("Failed to send broadcast");
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-broadcasts"] }),
  });

  const rows = broadcasts.data?.broadcasts ?? [];
  const columns: Column<BroadcastRow>[] = [
    { key: "title", header: "Title", render: (r) => r.title },
    { key: "audience", header: "Audience", render: (r) => <span className="font-mono text-xs">{r.audience}</span> },
    { key: "status", header: "Status", render: (r) => <Badge variant={STATUS_VARIANT[r.status]}>{r.status}</Badge> },
    { key: "created", header: "Created", render: (r) => formatWhen(r.createdAt) },
    { key: "sent", header: "Sent", render: (r) => formatWhen(r.sentAt) },
    {
      key: "actions",
      header: "",
      className: "text-right",
      render: (r) =>
        r.status === "draft" ? (
          <button
            onClick={() => send.mutate(r.id)}
            disabled={send.isPending}
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          >
            <Send className="size-3.5" />
            Send
          </button>
        ) : null,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Broadcasts"
        description="Message users or the waitlist. Sending needs RESEND_API_KEY configured \u2014 without it, broadcasts are marked \u201cqueued,\u201d not silently faked as sent."
      />

      <div className="rounded-lg border border-border p-4 mb-6 space-y-3">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title"
          className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring/40"
        />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Message body (HTML allowed)"
          rows={3}
          className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring/40"
        />
        <div className="flex items-center gap-3">
          <select
            value={audience}
            onChange={(e) => setAudience(e.target.value)}
            className="rounded-md border border-border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring/40"
          >
            <option value="all">All users</option>
            <option value="waitlist">Waitlist</option>
          </select>
          <Button onClick={() => create.mutate()} disabled={!title.trim() || !body.trim() || create.isPending} className="ml-auto">
            {create.isPending && <Loader2 className="size-3.5 animate-spin" />}
            Create draft
          </Button>
        </div>
      </div>

      {broadcasts.isLoading && <SkeletonTable columns={6} />}
      {!broadcasts.isLoading && rows.length === 0 && (
        <EmptyState title="No broadcasts yet" description="Create one above to message users or the waitlist." />
      )}
      {rows.length > 0 && <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />}
    </div>
  );
}
