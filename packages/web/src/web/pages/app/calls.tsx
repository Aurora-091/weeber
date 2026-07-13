import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { PhoneIncoming, PhoneOutgoing, Search } from "lucide-react";
import { appFetch } from "../../lib/user-session";
import { appPath } from "../../lib/route-base";
import { useUser } from "../../components/app/user-shell";
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

const STATUS_DOT: Record<string, string> = {
  "in-progress": "bg-success",
  completed: "bg-muted-foreground/50",
  failed: "bg-error",
};

const STATUS_EDGE: Record<string, string> = {
  "in-progress": "edge-success",
  completed: "edge-muted",
  failed: "edge-error",
};

type DirectionFilter = "all" | "inbound" | "outbound";
type StatusFilter = "all" | "in-progress" | "completed" | "failed";

function formatWhen(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diffMs = now - then;
  if (diffMs < 0) return "just now";

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return "just now";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;

  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function PillToggle<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { label: string; value: T }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-lg bg-muted/60 p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors duration-150 ${
            value === opt.value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export function UserCallsPage() {
  const { vertical } = useUser();

  const [directionFilter, setDirectionFilter] = useState<DirectionFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [search, setSearch] = useState("");

  const calls = useQuery({
    queryKey: ["app-calls"],
    queryFn: async () => {
      const res = await appFetch("/api/app/calls");
      if (!res.ok) throw new Error(`calls failed (${res.status})`);
      return (await res.json()) as { calls: CallRow[] };
    },
    refetchInterval: 10000,
  });
  const rawCalls = calls.data?.calls;

  const filteredRows = useMemo(() => {
    let result = rawCalls ?? [];

    if (directionFilter !== "all") {
      result = result.filter((c) => c.direction === directionFilter);
    }

    if (statusFilter !== "all") {
      result = result.filter((c) => c.status === statusFilter);
    }

    if (search.trim()) {
      const q = search.trim().toLowerCase();
      result = result.filter(
        (c) =>
          c.fromNumber.toLowerCase().includes(q) ||
          c.toNumber.toLowerCase().includes(q)
      );
    }

    return result;
  }, [rawCalls, directionFilter, statusFilter, search]);

  const rows = rawCalls ?? [];

  const filtersActive = directionFilter !== "all" || statusFilter !== "all" || search.trim() !== "";

  return (
    <div className="page-enter">
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
        <>
          {/* Filter bar */}
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <PillToggle
              options={[
                { label: "All", value: "all" as DirectionFilter },
                { label: "Inbound", value: "inbound" as DirectionFilter },
                { label: "Outbound", value: "outbound" as DirectionFilter },
              ]}
              value={directionFilter}
              onChange={setDirectionFilter}
            />
            <PillToggle
              options={[
                { label: "All", value: "all" as StatusFilter },
                { label: "Completed", value: "completed" as StatusFilter },
                { label: "Failed", value: "failed" as StatusFilter },
              ]}
              value={statusFilter}
              onChange={setStatusFilter}
            />
            <div className="relative ml-auto">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <input
                type="text"
                placeholder="Search phone number…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-8 w-52 rounded-md border border-border bg-background pl-8 pr-3 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
          </div>

          {/* Showing X of Y */}
          {filtersActive && (
            <p className="mb-2 text-xs text-muted-foreground">
              Showing {filteredRows.length} of {rows.length}
            </p>
          )}

          {filteredRows.length === 0 ? (
            <EmptyState title="No matching calls" description="Try adjusting your filters or search query." />
          ) : (
            <div className="card-weeber content-fade-in divide-y divide-border overflow-hidden">
              {filteredRows.map((call) => (
                <Link
                  key={call.id}
                  href={appPath(`/calls/${call.id}`)}
                  className={`flex items-center gap-4 px-5 transition-colors duration-150 hover:bg-muted/40 ${STATUS_EDGE[call.status] ?? "edge-muted"}`}
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
                    <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                      <span>{formatWhen(call.startedAt)}</span>
                      <span className="opacity-60">·</span>
                      <span className="opacity-70">{relativeTime(call.startedAt)}</span>
                    </div>
                  </div>
                  <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <span className={`inline-block size-2 rounded-full ${STATUS_DOT[call.status] ?? "bg-muted-foreground/50"}`} />
                    {call.status}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
