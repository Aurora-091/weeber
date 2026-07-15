import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Phone, Loader as Loader2, ShoppingCart, MessageSquareHeart, Search } from "lucide-react";
import { toast } from "sonner";
import { appFetch } from "../../lib/user-session";
import { PageHeader } from "../../components/shell/page-header";
import { EmptyState } from "../../components/shell/empty-state";
import { SkeletonTable } from "../../components/shell/skeletons";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";

type OrderRow = {
  id: number;
  toNumber: string;
  workflowName: string;
  status: string;
  attempt: number;
  maxAttempts: number;
  runAt: string;
  checkoutToken: string | null;
  recoveredOrderId: string | null;
  recoveredAmount: string | null;
  metadata: Record<string, string | number> | null;
  createdAt: string;
};

/** workflowName -> tag. Only the 3 real Shopify trigger workflows this page
 * covers (matches app/export.ts's "Download as Excel" filter exactly). */
const TAGS: Record<string, { label: string; icon: typeof ShoppingCart; className: string }> = {
  "shopify-cart-recovery": { label: "Cart Recovery", icon: ShoppingCart, className: "bg-chart-1/15 text-chart-1 border-chart-1/30" },
  "shopify-cod-confirmation": { label: "COD", icon: Phone, className: "bg-chart-2/15 text-chart-2 border-chart-2/30" },
  "shopify-feedback": { label: "Feedback", icon: MessageSquareHeart, className: "bg-chart-3/15 text-chart-3 border-chart-3/30" },
};

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  pending: "outline",
  claimed: "secondary",
  executed: "default",
  canceled: "secondary",
  failed: "destructive",
};

function formatWhen(iso: string) {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function CallNowButton({ row }: { row: OrderRow }) {
  const queryClient = useQueryClient();
  const callNow = useMutation({
    mutationFn: async () => {
      const res = await appFetch(`/api/app/orders/${row.id}/call-now`, { method: "POST" });
      const data = await res.json().catch(() => ({ error: "Failed to place the call" }));
      if (!res.ok) throw new Error(data.error ?? "Failed to place the call");
      return data;
    },
    onSuccess: () => {
      toast.success(`Calling ${row.toNumber} now`);
      queryClient.invalidateQueries({ queryKey: ["app-orders"] });
    },
    onError: (err: Error) => toast.error("Couldn't place the call", { description: err.message }),
  });

  if (row.status !== "pending") return null;

  return (
    <Button size="sm" variant="outline" disabled={callNow.isPending} onClick={() => callNow.mutate()} className="gap-1.5">
      {callNow.isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Phone className="size-3.5" aria-hidden />}
      Call now
    </Button>
  );
}

export function UserOrdersPage() {
  const [query, setQuery] = useState("");

  const orders = useQuery<{ orders: OrderRow[] }>({
    queryKey: ["app-orders"],
    queryFn: async () => {
      const res = await appFetch("/api/app/orders");
      if (!res.ok) throw new Error(`${res.status}`);
      return res.json();
    },
    refetchInterval: 15000,
  });

  const rows = orders.data?.orders ?? [];
  const filtered = query.trim()
    ? rows.filter((r) => [r.toNumber, r.checkoutToken, r.recoveredOrderId, r.metadata?.orderId, r.metadata?.shop]
        .filter(Boolean).join(" ").toLowerCase().includes(query.trim().toLowerCase()))
    : rows;

  return (
    <div className="page-enter">
      <PageHeader
        title="Orders"
        description="Every cart-recovery, COD confirmation, and feedback trigger we've captured — call any pending one right now instead of waiting."
      />

      <div className="mb-4 flex items-center gap-2">
        <div className="relative w-full max-w-sm">
          <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search phone, order ID, shop..."
            className="w-full rounded-md border border-border bg-background pl-8 pr-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring/40"
          />
        </div>
      </div>

      {orders.isLoading && <SkeletonTable rows={6} />}
      {orders.isError && <EmptyState title="Couldn't load orders" description="Something went wrong reaching the server — try refreshing." />}
      {!orders.isLoading && !orders.isError && filtered.length === 0 && (
        <EmptyState
          title={rows.length === 0 ? "No triggers captured yet" : "No matches"}
          description={
            rows.length === 0
              ? "Cart-recovery, COD confirmation, and feedback triggers show up here as your store sends webhooks."
              : "Try a different search."
          }
        />
      )}

      {filtered.length > 0 && (
        <div className="card-weeber content-fade-in divide-y divide-border overflow-hidden">
          {filtered.map((row) => {
            const tag = TAGS[row.workflowName] ?? { label: row.workflowName, icon: Phone, className: "" };
            const Icon = tag.icon;
            return (
              <div key={row.id} className="flex flex-wrap items-center gap-4 px-5 py-shell-row">
                <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <div className="min-w-[10rem] flex-1">
                  <div className="font-mono text-sm">{row.toNumber}</div>
                  <div className="text-xs text-muted-foreground">
                    {row.metadata?.shop ? String(row.metadata.shop) : "—"}
                    {row.recoveredOrderId ? ` · order ${row.recoveredOrderId}` : row.metadata?.orderId ? ` · order ${row.metadata.orderId}` : ""}
                  </div>
                </div>
                <Badge variant="outline" className={tag.className}>{tag.label}</Badge>
                <Badge variant={STATUS_VARIANT[row.status] ?? "outline"} className="capitalize">{row.status}</Badge>
                <div className="w-28 shrink-0 text-xs text-muted-foreground">
                  Attempt {row.attempt}/{row.maxAttempts}
                </div>
                <div className="w-40 shrink-0 text-xs text-muted-foreground">{formatWhen(row.runAt)}</div>
                {row.recoveredAmount && (
                  <div className="w-24 shrink-0 text-xs font-medium text-success">₹{row.recoveredAmount}</div>
                )}
                <div className="ml-auto shrink-0">
                  <CallNowButton row={row} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
