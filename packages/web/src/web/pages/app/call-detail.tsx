import { useQuery } from "@tanstack/react-query";
import { useRoute, Link } from "wouter";
import { ArrowLeft, Sparkles, PlayCircle } from "lucide-react";
import { appFetch } from "../../lib/merchant-session";
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

export function MerchantCallDetailPage() {
  const [, params] = useRoute("/app/calls/:id");
  const id = params?.id ?? "";

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

  const row = call.data?.call;
  const facts = Object.entries(row?.capturedState ?? {});
  const transcriptRows = transcript.data?.transcript ?? [];

  return (
    <div>
      <Link
        href="/app/calls"
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
            <h1 className="font-mono text-2xl font-medium">
              {row.direction === "inbound" ? row.fromNumber : row.toNumber}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {row.direction} · {row.status}
              {row.disposition ? ` · ${row.disposition}` : ""}
            </p>
            {row.recordingUrl && (
              <a
                href={row.recordingUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-3 inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
              >
                <PlayCircle className="size-4" aria-hidden />
                Play recording
              </a>
            )}
          </div>

          <div className="grid gap-8 md:grid-cols-[1fr_300px]">
            <div>
              <h2 className="mb-3 font-mono text-xs uppercase tracking-[0.15em] text-muted-foreground">Transcript</h2>
              <div className="divide-y divide-border rounded-lg border border-border">
                {transcriptRows.map((t) => (
                  <div key={t.id} className={`px-4 py-3 ${t.role === "agent" ? "bg-muted/40" : ""}`}>
                    <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                      {t.role === "agent" ? "agent" : "customer"}
                    </div>
                    <div className="text-sm leading-relaxed">{t.text}</div>
                  </div>
                ))}
                {transcriptRows.length === 0 && (
                  <div className="px-4 py-6 text-center text-sm text-muted-foreground">No transcript yet.</div>
                )}
              </div>
            </div>

            <div>
              <h2 className="mb-3 flex items-center gap-1.5 font-mono text-xs uppercase tracking-[0.15em] text-muted-foreground">
                <Sparkles className="size-3.5 text-success" aria-hidden />
                What the agent learned
              </h2>
              <div className="rounded-lg border border-success/25 bg-success-soft/40 p-4">
                {facts.length === 0 && <p className="text-sm italic text-muted-foreground">Nothing captured yet.</p>}
                <dl className="space-y-2">
                  {facts.map(([field, value]) => (
                    <div key={field}>
                      <dt className="font-mono text-[10px] uppercase tracking-wider text-success">{field}</dt>
                      <dd className="text-sm font-medium">{String(value)}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
