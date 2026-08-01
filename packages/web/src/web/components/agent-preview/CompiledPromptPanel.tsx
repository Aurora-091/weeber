import { useCallback, useEffect, useRef, useState } from "react";
import { Loader as Loader2, RefreshCw, Copy, Check, ChevronRight } from "lucide-react";

export type PromptSegment = {
  id: string;
  label: string;
  source: string;
  body: string;
  editable: boolean;
};

type CompiledPrompt = { text: string; segments: PromptSegment[] };

type Props = {
  /** POSTs { configOverride } to the compiled-prompt route and resolves to
   * { text, segments } — same override contract as the drawer's other tabs. */
  fetchFn: () => Promise<Response>;
  /** Serialized current form state. Changing it re-compiles (debounced), which
   * is what makes the diff below possible: the panel always holds the previous
   * compile to compare against. */
  configKey: string;
};

/** Line-level diff between two versions of one segment. Line-level (not word)
 * because the call-control block is a bulleted list — a merchant toggling a
 * tool wants to see "this bullet appeared", not a character-level smear. */
function diffLines(before: string, after: string): { added: string[]; removed: string[] } {
  const beforeLines = before.split("\n").map((l) => l.trim()).filter(Boolean);
  const afterLines = after.split("\n").map((l) => l.trim()).filter(Boolean);
  const beforeSet = new Set(beforeLines);
  const afterSet = new Set(afterLines);
  return {
    added: afterLines.filter((l) => !beforeSet.has(l)),
    removed: beforeLines.filter((l) => !afterSet.has(l)),
  };
}

/**
 * Phase III / D2 (ADR-067) — the compiled prompt, as layers.
 *
 * The agent editor gives a merchant one textarea and ships five layers to the
 * model: language behaviour, identity, their own text, the recording
 * disclosure, and a call-control/guardrail block generated from their tool and
 * guardrail settings. Four of those were invisible, so every "why did it say
 * that?" question was unanswerable from inside the product.
 *
 * Two deliberate choices over a plain <pre> dump:
 *  1. Segmented — labelled, collapsible layers with the merchant's own text
 *     highlighted, so "which part is mine" is answerable at a glance.
 *  2. Diffed — when the form changes, the layers that changed say so and list
 *     the exact lines that appeared or disappeared. That is the only way a
 *     tool checkbox visibly connects to the instructions it rewrites.
 *
 * The segments come straight from the backend's composeSystemPrompt (one
 * composition path, join-invariant unit-tested) — this component never
 * assembles prompt text itself, so it cannot drift from what a real call gets.
 */
export function CompiledPromptPanel({ fetchFn, configKey }: Props) {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [compiled, setCompiled] = useState<CompiledPrompt | null>(null);
  const [previous, setPrevious] = useState<CompiledPrompt | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const latestRequest = useRef(0);
  const diffTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    const requestId = ++latestRequest.current;
    setState((s) => (s === "ready" ? s : "loading"));
    try {
      const res = await fetchFn();
      const data = await res.json().catch(() => ({}));
      if (requestId !== latestRequest.current) return; // a newer edit won
      if (!res.ok) throw new Error(data.error ?? `Failed (${res.status})`);
      setCompiled((prev) => {
        setPrevious(prev);
        if (prev) {
          setShowDiff(true);
          if (diffTimer.current) clearTimeout(diffTimer.current);
          diffTimer.current = setTimeout(() => setShowDiff(false), 8000);
        }
        return data as CompiledPrompt;
      });
      setState("ready");
    } catch (err) {
      if (requestId !== latestRequest.current) return;
      setError(err instanceof Error ? err.message : "Could not compile the prompt");
      setState("error");
    }
  }, [fetchFn]);

  // Debounced so typing in the persona textarea doesn't fire a request per
  // keystroke — this endpoint is pure composition, but it still hits the DB
  // for the template fallback and the org name.
  useEffect(() => {
    const t = setTimeout(() => void load(), 400);
    return () => clearTimeout(t);
    // `load` is recreated whenever fetchFn is (i.e. on every parent render);
    // configKey is the real trigger, so it alone gates the refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configKey]);

  useEffect(() => () => { if (diffTimer.current) clearTimeout(diffTimer.current); }, []);

  async function copyAll() {
    if (!compiled) return;
    await navigator.clipboard.writeText(compiled.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  if (state === "loading" && !compiled) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Compiling this agent's prompt…
      </div>
    );
  }

  if (state === "error" && !compiled) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        <p className="text-xs text-destructive">{error}</p>
        <button
          type="button"
          onClick={() => void load()}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted"
        >
          <RefreshCw className="size-3" aria-hidden />
          Try again
        </button>
      </div>
    );
  }

  const segments = compiled?.segments ?? [];
  const totalChars = compiled?.text.length ?? 0;

  return (
    <div className="flex flex-1 flex-col gap-3 overflow-y-auto">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Everything this agent is told, in the order it's sent. Only the highlighted layer is yours —
          the rest is built from your settings.
        </p>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => void load()}
            title="Recompile"
            aria-label="Recompile prompt"
            className="rounded-md border border-border p-1.5 text-muted-foreground hover:bg-muted"
          >
            {state === "loading" ? (
              <Loader2 className="size-3 animate-spin" aria-hidden />
            ) : (
              <RefreshCw className="size-3" aria-hidden />
            )}
          </button>
          <button
            type="button"
            onClick={() => void copyAll()}
            title="Copy the whole prompt"
            aria-label="Copy the whole prompt"
            className="rounded-md border border-border p-1.5 text-muted-foreground hover:bg-muted"
          >
            {copied ? <Check className="size-3 text-success" aria-hidden /> : <Copy className="size-3" aria-hidden />}
          </button>
        </div>
      </div>

      <div className="space-y-2">
        {segments.map((seg, i) => {
          const prevBody = previous?.segments?.[i]?.body;
          const changed = showDiff && prevBody !== undefined && prevBody !== seg.body;
          const diff = changed ? diffLines(prevBody, seg.body) : null;
          const empty = seg.body.trim().length === 0;
          const isOpen = open[seg.id] ?? seg.editable;
          return (
            <div
              key={seg.id}
              className={`rounded-xl border transition-colors duration-300 ${
                changed
                  ? "border-warning/50 bg-warning/5"
                  : seg.editable
                    ? "border-primary/40 bg-primary/5"
                    : "border-border bg-muted/20"
              }`}
            >
              <button
                type="button"
                onClick={() => setOpen((o) => ({ ...o, [seg.id]: !isOpen }))}
                aria-expanded={isOpen}
                className="flex w-full items-start gap-2 px-3 py-2 text-left"
              >
                <ChevronRight
                  className={`mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform ${isOpen ? "rotate-90" : ""}`}
                  aria-hidden
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs font-medium text-foreground">{seg.label}</span>
                    {seg.editable && (
                      <span className="rounded-sm bg-primary/15 px-1.5 py-px text-[10px] font-medium text-foreground">
                        yours
                      </span>
                    )}
                    {changed && (
                      <span className="rounded-sm bg-warning/20 px-1.5 py-px text-[10px] font-medium text-warning">
                        just changed
                      </span>
                    )}
                    {empty && (
                      <span className="text-[10px] text-muted-foreground/70">not applied</span>
                    )}
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">{seg.source}</span>
                </span>
                {!empty && (
                  <span className="shrink-0 pt-0.5 font-mono text-[10px] text-muted-foreground/70">
                    {seg.body.trim().length}
                  </span>
                )}
              </button>

              {diff && (diff.added.length > 0 || diff.removed.length > 0) && (
                <div className="mx-3 mb-2 space-y-0.5 rounded-lg border border-warning/30 bg-background/60 p-2 font-mono text-[10px] leading-snug">
                  {diff.removed.map((line, n) => (
                    <p key={`r${n}`} className="text-destructive/80">− {line}</p>
                  ))}
                  {diff.added.map((line, n) => (
                    <p key={`a${n}`} className="text-success">+ {line}</p>
                  ))}
                </div>
              )}

              {isOpen && !empty && (
                <pre className="mx-3 mb-3 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/60 bg-background/60 p-2.5 font-mono text-[11px] leading-relaxed text-foreground/90">
                  {seg.body.trim()}
                </pre>
              )}
            </div>
          );
        })}
      </div>

      {/* Stated rather than faked: these blocks are real, but they depend on
          live call state, so no configured-prompt view can show their content
          honestly ahead of a call. */}
      <p className="border-t border-border/60 pt-3 text-[11px] leading-snug text-muted-foreground">
        {totalChars.toLocaleString()} characters total. On a real call the agent also receives, at the
        bottom: facts it captured during the call, anything your workflow already knew about the order,
        and a short memory of previous calls from the same number.
      </p>
    </div>
  );
}
