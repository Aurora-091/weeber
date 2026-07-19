/**
 * Workflow Canvas v4 — Phase 3: flow preview via web call (2026-07-19).
 *
 * Reads the current (possibly unsaved) canvas graph, lets the merchant pre-pick
 * a branch for each conditionalSplit (a sandbox call has no real disposition),
 * then asks the backend for a log-only storyboard (POST .../preview → the pure
 * walkForPreview). Non-call nodes render as fast-forward log lines; the single
 * `call` step exposes a live browser call that reuses the EXISTING preview
 * pipeline (useVoiceTestCall → test-call-token → test-call-stream, ADR-051) —
 * no new socket/wire-format work.
 */
import { useCallback, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { X, Play, Phone, PhoneOff, Loader as Loader2, ShieldCheck, Clock, MessageSquare, Webhook, Ban, GitBranch, Flag, CircleAlert } from "lucide-react";
import { appFetch } from "../../lib/user-session";
import { useVoiceTestCall } from "../../hooks/useVoiceTestCall";
import { Button } from "../ui/button";
import type { WorkflowGraph } from "../canvas/types";

type PreviewStepType = "trigger" | "compliance" | "wait" | "call" | "branch" | "sms" | "addToDnc" | "webhook" | "end" | "error";
type PreviewStep = {
  nodeId: string;
  nodeType: string;
  type: PreviewStepType;
  label: string;
  live?: boolean;
  persona?: string;
  branchChosen?: string;
  locked?: boolean;
};

const STEP_ICON: Record<PreviewStepType, typeof Play> = {
  trigger: Flag,
  compliance: ShieldCheck,
  wait: Clock,
  call: Phone,
  branch: GitBranch,
  sms: MessageSquare,
  addToDnc: Ban,
  webhook: Webhook,
  end: Flag,
  error: CircleAlert,
};

export function FlowPreviewPanel({
  templateKey,
  graph,
  onClose,
}: {
  templateKey: string;
  graph: WorkflowGraph;
  onClose: () => void;
}) {
  // Every conditionalSplit in the current graph, with the outcome branches it
  // can take (from its outgoing edges) — the merchant picks one per split.
  const splits = useMemo(() => {
    return graph.nodes
      .filter((n) => n.type === "conditionalSplit")
      .map((n) => {
        const branches = graph.edges
          .filter((e) => e.source === n.id && e.branch)
          .map((e) => e.branch as string);
        return { id: n.id, branches };
      })
      .filter((s) => s.branches.length > 0);
  }, [graph]);

  const [selections, setSelections] = useState<Record<string, string>>(() =>
    Object.fromEntries(splits.map((s) => [s.id, s.branches[0]])),
  );
  const [steps, setSteps] = useState<PreviewStep[] | null>(null);

  const run = useMutation({
    mutationFn: async () => {
      const res = await appFetch(`/api/app/workflow-configs/${encodeURIComponent(templateKey)}/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ graph, branchSelections: selections }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error || `Preview failed (${res.status})`);
      }
      return (await res.json()) as { steps: PreviewStep[]; ok: boolean };
    },
    onSuccess: (data) => setSteps(data.steps),
  });

  // Live call reuses the org's real configured agent for this template — the
  // same agent that runs this workflow's call node in production. No override.
  const tokenFetch = useCallback(
    () =>
      appFetch(`/api/app/agent-configs/${encodeURIComponent(templateKey)}/test-call-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    [templateKey],
  );
  const call = useVoiceTestCall(tokenFetch);
  const callActive = call.status === "connecting" || call.status === "listening" || call.status === "speaking";

  const hasCallStep = steps?.some((s) => s.type === "call");

  return (
    <div className="w-96 shrink-0 border-l border-border overflow-y-auto flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border sticky top-0 bg-card z-10">
        <div className="flex items-center gap-2">
          <Play className="size-4 text-primary" aria-hidden />
          <h3 className="font-medium text-sm">Preview flow</h3>
        </div>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground" aria-label="Close preview">
          <X className="size-4" aria-hidden />
        </button>
      </div>

      <div className="p-4 space-y-4">
        <p className="text-xs text-muted-foreground">
          Walk this flow step by step. Waits, SMS and webhooks are fast-forwarded (nothing real is
          sent). At a call step you can run a real browser call with this workflow's agent.
        </p>

        {splits.length > 0 && (
          <div className="space-y-2">
            <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              Pick a branch to walk
            </p>
            {splits.map((s) => (
              <label key={s.id} className="block text-xs">
                <span className="text-muted-foreground">On call outcome:</span>
                <select
                  value={selections[s.id] ?? ""}
                  onChange={(e) => setSelections((prev) => ({ ...prev, [s.id]: e.target.value }))}
                  className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                >
                  {s.branches.map((b) => (
                    <option key={b} value={b}>{b}</option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        )}

        <Button size="sm" className="w-full" onClick={() => run.mutate()} disabled={run.isPending}>
          {run.isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
          Run preview
        </Button>
        {run.isError && <p className="text-xs text-destructive">{(run.error as Error).message}</p>}

        {steps && (
          <ol className="space-y-1.5">
            {steps.map((step, i) => {
              const Icon = STEP_ICON[step.type];
              const isError = step.type === "error";
              return (
                <li
                  key={`${step.nodeId}-${i}`}
                  className={`flex items-start gap-2 rounded-md border px-3 py-2 text-xs ${
                    isError
                      ? "border-destructive/40 bg-destructive/5 text-destructive"
                      : step.type === "call"
                        ? "border-primary/40 bg-primary/5"
                        : "border-border bg-muted/30"
                  }`}
                >
                  <Icon className={`size-3.5 mt-0.5 shrink-0 ${step.locked ? "text-amber-500" : "text-muted-foreground"}`} aria-hidden />
                  <span className="leading-relaxed">{step.label}</span>
                </li>
              );
            })}
          </ol>
        )}

        {hasCallStep && (
          <div className="rounded-md border border-primary/30 bg-primary/5 p-3 space-y-2">
            <p className="text-xs font-medium">Live call at the call step</p>
            <p className="text-[11px] text-muted-foreground">
              {call.status === "idle" && "A real back-and-forth call with this workflow's agent, in your browser."}
              {call.status === "connecting" && "Connecting — allow microphone access if prompted…"}
              {call.status === "listening" && "Listening — talk to the agent like a real call."}
              {call.status === "speaking" && "Agent is speaking…"}
              {call.status === "ended" && "Call ended."}
              {call.status === "error" && (call.errorMessage ?? "Test call failed.")}
            </p>
            {callActive ? (
              <Button size="sm" variant="destructive" className="w-full" onClick={() => call.stop()}>
                <PhoneOff className="size-3.5" aria-hidden />
                End call
              </Button>
            ) : (
              <Button size="sm" className="w-full" onClick={() => call.start()}>
                <Phone className="size-3.5" aria-hidden />
                Start live call
              </Button>
            )}
            {call.transcripts.length > 0 && (
              <div className="max-h-40 overflow-y-auto space-y-1 pt-1">
                {call.transcripts.map((t, i) => (
                  <p key={i} className="text-[11px]">
                    <span className={t.role === "agent" ? "text-primary font-medium" : "text-muted-foreground"}>
                      {t.role === "agent" ? "Agent" : "You"}:
                    </span>{" "}
                    {t.text}
                  </p>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
