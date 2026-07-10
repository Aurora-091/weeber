import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { PhoneIncoming, PhoneOutgoing, Sparkles } from "lucide-react";
import { api } from "../../lib/api";
import { adminHeaders } from "../../lib/admin-key";

const STATUS_STYLES: Record<string, string> = {
  "in-progress": "bg-success-soft text-success",
  completed: "bg-muted text-muted-foreground",
  failed: "bg-destructive/10 text-destructive",
};

function formatWhen(iso: string | null) {
  if (!iso) return "—";
  const date = new Date(iso);
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function CallsListPage() {
  const calls = useQuery({
    queryKey: ["calls"],
    queryFn: async () => {
      const res = await api.voice.calls.$get({}, { headers: adminHeaders() });
      return res.json();
    },
    refetchInterval: 5000,
  });

  const callRows = calls.data && "calls" in calls.data ? calls.data.calls : [];
  const rows = [...callRows].reverse();

  return (
    <div>
      <div className="flex items-baseline justify-between mb-8">
        <div>
          <h1 className="text-2xl font-semibold">Calls</h1>
          <p className="text-sm text-muted-foreground mt-1">Live and completed calls across every configured number.</p>
        </div>
        <span className="text-xs font-mono text-muted-foreground">{rows.length} total</span>
      </div>

      {calls.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {!calls.isLoading && rows.length === 0 && (
        <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          No calls yet. Place an outbound call or dial your Twilio number to see one here.
        </div>
      )}

      <div className="rounded-lg border border-border overflow-hidden divide-y divide-border">
        {rows.map((call) => {
          const factCount = Object.keys(call.capturedState ?? {}).length;
          return (
            <Link
              key={call.id}
              href={`/dashboard/calls/${call.id}`}
              className="flex items-center gap-4 px-5 py-3.5 hover:bg-muted/60 transition-colors"
            >
              <div className="shrink-0">
                {call.direction === "inbound" ? (
                  <PhoneIncoming className="size-4 text-success" />
                ) : (
                  <PhoneOutgoing className="size-4 text-primary" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm">{call.fromNumber} → {call.toNumber}</span>
                  {call.disposition && (
                    <span className="text-xs font-mono text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                      {call.disposition}
                    </span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">{formatWhen(call.startedAt)}</div>
              </div>
              {factCount > 0 && (
                <div className="flex items-center gap-1 text-xs text-success shrink-0" title={`${factCount} facts captured`}>
                  <Sparkles className="size-3.5" />
                  {factCount}
                </div>
              )}
              <span
                className={`shrink-0 text-xs font-medium px-2 py-1 rounded-full ${STATUS_STYLES[call.status] ?? "bg-muted text-muted-foreground"}`}
              >
                {call.status}
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
