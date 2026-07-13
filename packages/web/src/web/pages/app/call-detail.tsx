import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRoute, Link } from "wouter";
import { ArrowLeft, Sparkles, CirclePlay as PlayCircle, Copy, Check, Wrench } from "lucide-react";
import { appFetch } from "../../lib/user-session";
import { appPath } from "../../lib/route-base";
import { EmptyState } from "../../components/shell/empty-state";
import { SkeletonCards } from "../../components/shell/skeletons";

type CallRow = {
  id: number;
  direction: string;
  fromNumber: string;
  toNumber: string;
  status: string;
  disposition: string | null;
  recordingUrl: string | null;
  capturedState: Record<string, unknown> | null;
};

type TranscriptRow = { id: number; role: "caller" | "agent"; text: string };
type ToolCallRow = { id: number; toolName: string; input: unknown };

/** Merchant-friendly labels for internal tool names — falls back to the raw
 * name for anything not in this list (new tools show up immediately, just
 * unstyled, rather than being hidden). */
const TOOL_LABELS: Record<string, string> = {
  captureField: "Captured info",
  confirmCodOrder: "Confirmed COD order",
  bookAppointment: "Booked appointment",
  crmSync: "Synced to CRM",
  lookupInfo: "Looked up info",
  offerCartRecoveryDiscount: "Offered discount",
  setDisposition: "Set call outcome",
  transferToHuman: "Transferred to human",
  hangUp: "Ended call",
  flagGuardrailEvent: "Flagged compliance event",
};

function StatusBadge({ status }: { status: string }) {
  let dotClass = "bg-muted-foreground/40";
  if (status === "completed") dotClass = "bg-weeber-success";
  else if (status === "in-progress" || status === "ringing" || status === "queued") dotClass = "bg-weeber-warning pulse-dot";
  else if (status === "failed" || status === "busy" || status === "no-answer") dotClass = "bg-weeber-error";

  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-0.5 text-xs font-medium text-muted-foreground" style={{boxShadow:"var(--weeber-shadow-card)"}}>
      <span className={`size-2 rounded-full ${dotClass}`} />
      {status}
    </span>
  );
}

export function UserCallDetailPage() {
  const [, params] = useRoute<{ id: string }>(appPath("/calls/:id"));
  const id = params?.id ?? "";
  const [copied, setCopied] = useState(false);

  const call = useQuery({
    queryKey: ["app-call", id],
    enabled: !!id,
    queryFn: async () => {
      const res = await appFetch(`/api/app/calls/${id}`);
      if (!res.ok) throw new Error(`call failed (${res.status})`);
      return (await res.json()) as { call: CallRow };
    },
    refetchInterval: 8000,
  });

  const transcript = useQuery({
    queryKey: ["app-call-transcript", id],
    enabled: !!id,
    queryFn: async () => {
      const res = await appFetch(`/api/app/calls/${id}/transcript`);
      if (!res.ok) throw new Error(`transcript failed (${res.status})`);
      return (await res.json()) as { transcript: TranscriptRow[] };
    },
    refetchInterval: 8000,
  });

  const toolCalls = useQuery({
    queryKey: ["app-call-tool-calls", id],
    enabled: !!id,
    queryFn: async () => {
      const res = await appFetch(`/api/app/calls/${id}/tool-calls`);
      if (!res.ok) throw new Error(`tool-calls failed (${res.status})`);
      return (await res.json()) as { toolCalls: ToolCallRow[] };
    },
    refetchInterval: 8000,
  });

  const row = call.data?.call;
  const facts = Object.entries(row?.capturedState ?? {});
  const transcriptRows = transcript.data?.transcript ?? [];
  const toolCallRows = toolCalls.data?.toolCalls ?? [];

  function copyTranscript() {
    const text = transcriptRows
      .map((t) => `${t.role === "agent" ? "Agent" : "Customer"}: ${t.text}`)
      .join("\n\n");
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="page-enter">
      <Link
        href={appPath("/calls")}
        className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        All conversations
      </Link>

      {call.isLoading && <SkeletonCards count={2} lines={4} />}
      {call.isError && <EmptyState title="Conversation not found" description="This call doesn't exist or isn't yours." />}

      {row && (
        <div className="content-fade-in">
          <div className="mb-[var(--shell-section-gap)]">
            <div className="flex items-center gap-3">
              <h1 className="font-mono text-2xl font-medium">
                {row.direction === "inbound" ? row.fromNumber : row.toNumber}
              </h1>
              <StatusBadge status={row.status} />
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {row.direction} · {row.status}
              {row.disposition ? ` · ${row.disposition}` : ""}
            </p>
            {row.recordingUrl && (
              <div className="mt-3">
                <div className="inline-flex items-center gap-1.5 text-sm text-primary">
                  <PlayCircle className="size-4" aria-hidden />
                  <span className="font-medium">Recording</span>
                </div>
                {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                <audio
                  controls
                  src={row.recordingUrl}
                  className="mt-2 w-full max-w-md"
                  preload="metadata"
                >
                  <a href={row.recordingUrl} target="_blank" rel="noreferrer">
                    Play recording
                  </a>
                </audio>
              </div>
            )}
          </div>

          <div className="grid gap-8 md:grid-cols-[1fr_300px]">
            <div>
              <div className="mb-3 flex items-center gap-3">
                <h2 className="font-mono text-xs uppercase tracking-[0.15em] text-muted-foreground">Transcript</h2>
                {transcriptRows.length > 0 && (
                  <button
                    type="button"
                    onClick={copyTranscript}
                    className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    {copied ? (
                      <>
                        <Check className="size-3" aria-hidden />
                        Copied!
                      </>
                    ) : (
                      <>
                        <Copy className="size-3" aria-hidden />
                        Copy transcript
                      </>
                    )}
                  </button>
                )}
              </div>
              <div className="space-y-3">
                {transcriptRows.map((t) => (
                  <div
                    key={t.id}
                    className={`flex ${t.role === "agent" ? "justify-start" : "justify-end"}`}
                  >
                    <div
                      className={`max-w-[80%] rounded-lg px-4 py-3 ${
                        t.role === "agent"
                          ? "border-l-[3px] border-l-primary bg-card shadow-sm"
                          : "bg-muted/60"
                      }`}
                    >
                      <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                        {t.role === "agent" ? "agent" : "customer"}
                      </div>
                      <div className="text-sm leading-relaxed">{t.text}</div>
                    </div>
                  </div>
                ))}
                {transcriptRows.length === 0 && (
                  <div className="card-weeber px-4 py-6 text-center text-sm text-muted-foreground">
                    No transcript yet.
                  </div>
                )}
              </div>
            </div>

            <div className="md:sticky md:top-6 md:self-start">
              <h2 className="mb-3 flex items-center gap-1.5 font-mono text-xs uppercase tracking-[0.15em] text-muted-foreground">
                <Sparkles className="size-3.5 text-success" aria-hidden />
                What the agent learned
              </h2>
              <div className="card-weeber p-4" style={{borderColor:"color-mix(in oklch, var(--weeber-success) 25%, var(--border))"}}>
                {facts.length === 0 && <p className="text-sm italic text-muted-foreground">Nothing captured yet.</p>}
                <dl className="space-y-2">
                  {facts.map(([field, value]) => (
                    <div key={field}>
                      <dt className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/60">{field}</dt>
                      <dd className="text-sm font-medium">{String(value)}</dd>
                    </div>
                  ))}
                </dl>
              </div>

              <h2 className="mb-3 mt-6 flex items-center gap-1.5 font-mono text-xs uppercase tracking-[0.15em] text-muted-foreground">
                <Wrench className="size-3.5" aria-hidden />
                What the agent did
              </h2>
              <div className="rounded-lg border border-border divide-y divide-border">
                {toolCallRows.length === 0 && (
                  <div className="px-4 py-6 text-center text-sm text-muted-foreground">Nothing yet.</div>
                )}
                {toolCallRows.map((tc) => (
                  <div key={tc.id} className="px-4 py-2.5 text-sm">
                    {TOOL_LABELS[tc.toolName] ?? tc.toolName}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
