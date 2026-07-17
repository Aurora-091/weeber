import { useQuery } from "@tanstack/react-query";
import { useRoute, Link } from "wouter";
import { motion } from "motion/react";
import { ArrowLeft, Sparkles, Wrench, PlayCircle, ShieldCheck, Gauge, RefreshCw } from "lucide-react";
import { api, apiFetch } from "../../lib/api";
import { adminHeaders } from "../../lib/admin-key";
import { adminPath } from "../../lib/route-base";

/**
 * Downloads the compliance audit trail for this call as a plain-text file —
 * who was called, when, disclosure/consent status, disposition, DNC status,
 * and the full transcript, assembled server-side (see @openvent/compliance's
 * audit-trail.ts). This is the direct answer to real user feedback that the
 * thing that actually kills the compliance fear is being able to produce
 * this on demand, not another warning.
 */
async function downloadAudit(callId: string) {
  const res = await apiFetch(`/api/voice/calls/${callId}/audit?format=text`, { headers: adminHeaders() });
  if (!res.ok) return;
  const text = await res.text();
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `vent-audit-call-${callId}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

function LatencyRow({ label, ms }: { label: string; ms: number | null }) {
  return (
    <div className="flex items-center justify-between py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-mono ${ms == null ? "text-muted-foreground/60 italic text-xs" : "font-medium"}`}>
        {ms == null ? "not recorded" : `${ms}ms`}
      </span>
    </div>
  );
}

export function CallDetailPage() {
  const [, params] = useRoute<{ id: string }>(adminPath("/calls/:id"));
  const id = params?.id ?? "";

  const call = useQuery({
    queryKey: ["call", id],
    queryFn: async () => {
      const res = await api.voice.calls[":id"].status.$get({ param: { id } }, { headers: adminHeaders() });
      return res.json();
    },
    refetchInterval: 4000,
    enabled: !!id,
  });

  const transcript = useQuery({
    queryKey: ["call-transcript", id],
    queryFn: async () => {
      const res = await api.voice.calls[":id"].transcript.$get({ param: { id } }, { headers: adminHeaders() });
      return res.json();
    },
    refetchInterval: 4000,
    enabled: !!id,
  });

  const toolCalls = useQuery({
    queryKey: ["call-tool-calls", id],
    queryFn: async () => {
      const res = await api.voice.calls[":id"]["tool-calls"].$get({ param: { id } }, { headers: adminHeaders() });
      return res.json();
    },
    refetchInterval: 4000,
    enabled: !!id,
  });

  const latency = useQuery({
    queryKey: ["call-latency", id],
    queryFn: async () => {
      const res = await api.voice.calls[":id"].latency.$get({ param: { id } }, { headers: adminHeaders() });
      return res.json();
    },
    refetchInterval: 4000,
    enabled: !!id,
  });

  const row = call.data && "call" in call.data ? call.data.call : undefined;
  const latencyRow = latency.data && "latency" in latency.data ? latency.data.latency : undefined;
  const facts = Object.entries(row?.capturedState ?? {});
  const transcriptRows = transcript.data && "transcript" in transcript.data ? transcript.data.transcript : [];
  const toolCallRows = toolCalls.data && "toolCalls" in toolCalls.data ? toolCalls.data.toolCalls : [];

  return (
    <div>
      <Link href={adminPath()} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-6">
        <ArrowLeft className="size-3.5" />
        All calls
      </Link>

      {row && (
        <div className="mb-8">
          <h1 className="text-2xl font-semibold font-mono">
            {row.fromNumber} → {row.toNumber}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {row.direction} · {row.status}
            {row.disposition ? ` · ${row.disposition}` : ""}
            {"sentiment" in row && row.sentiment ? ` · ${row.sentiment}` : ""}
          </p>
          {"providerFailoverCount" in row && (row.providerFailoverCount ?? 0) > 0 && (
            <span
              className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-warning/30 bg-warning-soft px-2.5 py-0.5 text-xs font-medium text-warning"
              title="This call switched providers mid-call due to an error or timeout on the primary provider."
            >
              <RefreshCw className="size-3" aria-hidden />
              Failed over {row.providerFailoverCount}×
            </span>
          )}
          <div className="flex items-center gap-4 mt-3">
            {row.recordingUrl && (
              <a
                href={row.recordingUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
              >
                <PlayCircle className="size-4" />
                Play recording
              </a>
            )}
            <button
              onClick={() => downloadAudit(String(row.id))}
              className="inline-flex items-center gap-1.5 text-sm text-success hover:underline"
            >
              <ShieldCheck className="size-4" />
              Export compliance audit
            </button>
          </div>
        </div>
      )}

      <div className="grid md:grid-cols-[1fr_320px] gap-8">
        <div>
          <h2 className="text-xs font-mono uppercase tracking-[0.15em] text-muted-foreground mb-3">Transcript</h2>
          <div className="rounded-lg border border-border divide-y divide-border">
            {transcriptRows.map((t) => (
              <div key={t.id} className={`px-4 py-3 ${t.role === "agent" ? "bg-muted/40" : ""}`}>
                <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1">{t.role}</div>
                <div className="text-sm leading-relaxed">{t.text}</div>
              </div>
            ))}
            {transcriptRows.length === 0 && (
              <div className="px-4 py-6 text-sm text-muted-foreground text-center">No transcript yet.</div>
            )}
          </div>

          <h2 className="text-xs font-mono uppercase tracking-[0.15em] text-muted-foreground mt-8 mb-3 flex items-center gap-1.5">
            <Wrench className="size-3.5" />
            Tool calls
          </h2>
          <div className="rounded-lg border border-border divide-y divide-border">
            {toolCallRows.map((tc) => (
              <div key={tc.id} className="px-4 py-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-mono">{tc.toolName}</span>
                  {tc.toolName === "captureField" && (
                    <span className="text-[10px] font-mono text-success bg-success-soft px-1.5 py-0.5 rounded">
                      state write
                    </span>
                  )}
                </div>
                <pre className="text-xs text-muted-foreground mt-1.5 overflow-x-auto font-mono">
                  {JSON.stringify(tc.input, null, 2)}
                </pre>
              </div>
            ))}
            {toolCallRows.length === 0 && (
              <div className="px-4 py-6 text-sm text-muted-foreground text-center">No tool calls yet.</div>
            )}
          </div>
        </div>

        <div>
          <h2 className="text-xs font-mono uppercase tracking-[0.15em] text-muted-foreground mb-3 flex items-center gap-1.5">
            <Gauge className="size-3.5 text-primary" />
            Latency breakdown
          </h2>
          <div className="rounded-lg border border-border bg-card p-4 mb-6">
            <LatencyRow label="Pickup to first word (caller-perceived)" ms={latencyRow?.pickupToFirstAudioMs ?? null} />
            <LatencyRow label="STT connect" ms={latencyRow?.sttConnectMs ?? null} />
            <LatencyRow label="LLM time-to-first-token" ms={latencyRow?.llmTtftMs ?? null} />
            <LatencyRow label="TTS first byte" ms={latencyRow?.ttsFirstByteMs ?? null} />
          </div>

          <h2 className="text-xs font-mono uppercase tracking-[0.15em] text-muted-foreground mb-3 flex items-center gap-1.5">
            <Sparkles className="size-3.5 text-success" />
            Captured state
          </h2>
          <motion.div
            layout
            className="rounded-lg border border-success/25 bg-success-soft/40 p-4"
          >
            <p className="text-xs text-muted-foreground mb-3 leading-relaxed">
              Structured facts confirmed this call — the agent reads these back every turn instead of the raw
              transcript, so it never re-asks for something already known.
            </p>
            {facts.length === 0 && <p className="text-sm text-muted-foreground italic">Nothing captured yet.</p>}
            <dl className="space-y-2">
              {facts.map(([field, value]) => (
                <div key={field}>
                  <dt className="text-[10px] font-mono uppercase tracking-wider text-success">{field}</dt>
                  <dd className="text-sm font-medium">{String(value)}</dd>
                </div>
              ))}
            </dl>
          </motion.div>
        </div>
      </div>
    </div>
  );
}
