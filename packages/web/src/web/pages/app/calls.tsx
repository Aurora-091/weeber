import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { PhoneIncoming, PhoneOutgoing } from "lucide-react";
import { appFetch } from "../../lib/merchant-session";
import { useMerchant } from "../../components/app/merchant-shell";
import { PageHeader } from "../../components/shell/page-header";
import { EmptyState } from "../../components/shell/empty-state";
import { SkeletonTable } from "../../components/shell/skeletons";

type CallRow = {
  id: number;
  direction: string;
  fromNumber: string;
  toNumber: string;
  status: string;
  disposition: string | null;
  startedAt: string;
  capturedState: Record<string, unknown> | null;
};

const STATUS_STYLES: Record<string, string> = {
  "in-progress": "bg-success-soft text-success",
  completed: "bg-muted text-muted-foreground",
  failed: "bg-error-soft text-error",
};

const STATUS_EDGE: Record<string, string> = {
  "in-progress": "edge-success",
  completed: "edge-muted",
  failed: "edge-error",
};

function formatWhen(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function MerchantCallsPage() {
  const { vertical } = useMerchant();

  const calls = useQuery({
    queryKey: ["app-calls"],
    queryFn: async () => {
      const res = await appFetch("/api/app/calls");
      if (!res.ok) throw new Error(`calls failed (${res.status})`);
      return (await res.json()) as { calls: CallRow[] };
    },
    refetchInterval: 10000,
  });
  const rows = calls.data?.calls ?? [];

  return (
    <div>
      <PageHeader
        title="Conversations"
        description={`Every call your agents have had with your ${vertical.glossary.customers.toLowerCase()}.`}
        actions={rows.length > 0 ? <span className="font-mono text-xs text-muted-foreground">{rows.length} total</span> : undefined}
      />

      {calls.isLoading && <SkeletonTable columns={4} rows={6} />}

      {calls.isError && (
        <EmptyState title="Couldn't load conversations" description="Something went wrong — refresh to try again." />
      )}

      {!calls.isLoading && !calls.isError && rows.length === 0 && (
        <EmptyState title={vertical.copy.callsEmptyTitle} description={vertical.copy.callsEmptyBody} />
      )}

      {rows.length > 0 && (
        <div className="content-fade-in divide-y divide-border overflow-hidden rounded-lg border border-border">
          {rows.map((call) => (
            <Link
              key={call.id}
              href={`/app/calls/${call.id}`}
              className={`flex items-center gap-4 px-5 transition-colors duration-150 hover:bg-muted/60 hover:border-foreground/10 ${STATUS_EDGE[call.status] ?? "edge-muted"}`}
              style={{ paddingTop: "var(--shell-row-py)", paddingBottom: "var(--shell-row-py)" }}
            >
              <div className="shrink-0">
                {call.direction === "inbound" ? (
                  <PhoneIncoming className="size-4 text-success" aria-hidden />
                ) : (
                  <PhoneOutgoing className="size-4 text-primary" aria-hidden />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm">{call.direction === "inbound" ? call.fromNumber : call.toNumber}</span>
                  {call.disposition && (
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                      {call.disposition}
                    </span>
                  )}
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">{formatWhen(call.startedAt)}</div>
              </div>
              <span
                className={`shrink-0 rounded-full px-2 py-1 text-xs font-medium ${STATUS_STYLES[call.status] ?? "bg-muted text-muted-foreground"}`}
              >
                {call.status}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
