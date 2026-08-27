import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { PhoneOutgoing, Sparkles, Clock, RefreshCw } from "lucide-react";
import { apiFetch } from "../../lib/api";
import { adminHeaders } from "../../lib/admin-key";
import { adminPath } from "../../lib/route-base";
import { formatDateTime } from "../../lib/format";
import { DEMO_ORG_ID } from "../../lib/demo-widget-constants";

/**
 * Real demo-call widget (2026-08-27) — Phase 2 admin page. Same list shape as
 * `calls-list.tsx`, filtered to the demo org via `voice/routes.ts`'s new `?orgId=` param, so a
 * founder can see results from the public widget without them mixed into the main Calls view.
 * Row drill-down reuses `call-detail.tsx` unmodified — same `/calls/:id` route, no `orgId`
 * concept needed there since a call id is already globally unique.
 *
 * `apiFetch` rather than the typed `api.voice.calls.$get` RPC client: that endpoint has no
 * `zValidator` on its query string, so the generated client type doesn't model `?orgId=` — same
 * "drop to apiFetch for anything outside the typed RPC surface" pattern `call-detail.tsx`'s audit
 * download already uses.
 */

type Call = {
  id: number;
  direction: "inbound" | "outbound";
  fromNumber: string;
  toNumber: string;
  status: string;
  disposition: string | null;
  startedAt: string | null;
  endedAt: string | null;
  capturedState: Record<string, unknown> | null;
  providerFailoverCount?: number | null;
};

const STATUS_STYLES: Record<string, string> = {
  "in-progress": "bg-success-soft text-success",
  completed: "bg-muted text-muted-foreground",
  failed: "bg-destructive/10 text-destructive",
};

function formatWhen(iso: string | null) {
  if (!iso) return "—";
  return formatDateTime(iso);
}

function formatDuration(startedAt: string | null, endedAt: string | null): string | null {
  if (!startedAt || !endedAt) return null;
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  if (ms < 0) return null;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  return `${mins}m ${remainSecs}s`;
}

export function DemoCallsPage() {
  const calls = useQuery({
    queryKey: ["demo-calls"],
    queryFn: async () => {
      const res = await apiFetch(`/api/voice/calls?orgId=${encodeURIComponent(DEMO_ORG_ID)}`, {
        headers: adminHeaders(),
      });
      if (!res.ok) throw new Error(`Failed to load demo calls (${res.status})`);
      return res.json() as Promise<{ calls: Call[] }>;
    },
    refetchInterval: 5000,
  });

  const rows = [...(calls.data?.calls ?? [])].reverse();

  return (
    <div>
      <div className="flex items-baseline justify-between mb-8">
        <div>
          <h1 className="text-2xl font-semibold">Demo Calls</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Calls placed through the public landing-page demo widget (weeber.ai).
          </p>
        </div>
        <span className="text-xs font-mono text-muted-foreground">{rows.length} total</span>
      </div>

      {calls.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {!calls.isLoading && rows.length === 0 && (
        <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          No demo calls yet.
        </div>
      )}

      <div className="card-weeber overflow-hidden divide-y divide-border">
        {rows.map((call) => {
          const factCount = Object.keys(call.capturedState ?? {}).length;
          const duration = formatDuration(call.startedAt, call.endedAt ?? null);
          return (
            <Link
              key={call.id}
              href={adminPath(`/calls/${call.id}`)}
              className="flex items-center gap-4 px-5 py-3.5 hover:bg-muted/60 transition-colors"
            >
              <div className="shrink-0">
                <PhoneOutgoing className="size-4 text-primary" aria-hidden />
                <span className="sr-only">Outbound</span>
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
              {duration && (
                <div className="flex items-center gap-1 text-xs text-muted-foreground shrink-0">
                  <Clock className="size-3" aria-hidden />
                  <span className="font-mono" aria-label={`Duration: ${duration}`}>{duration}</span>
                </div>
              )}
              {factCount > 0 && (
                <div className="flex items-center gap-1 text-xs text-success shrink-0" aria-label={`${factCount} facts captured`}>
                  <Sparkles className="size-3.5" aria-hidden />
                  <span aria-hidden>{factCount}</span>
                </div>
              )}
              {(call.providerFailoverCount ?? 0) > 0 && (
                <div
                  className="flex items-center gap-1 text-xs text-warning shrink-0"
                  aria-label={`Failed over ${call.providerFailoverCount} time(s)`}
                  title="This call switched providers mid-call"
                >
                  <RefreshCw className="size-3.5" aria-hidden />
                  <span aria-hidden>{call.providerFailoverCount}</span>
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
