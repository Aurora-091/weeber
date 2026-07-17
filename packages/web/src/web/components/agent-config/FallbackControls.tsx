// Cross-provider failover config controls (2026-07-17, Phase 1 of the Agents UI/UX audit —
// docs/agents-ux-audit-and-cogs-2026-07-17.md's P0 finding: sttFallbackOrder/ttsFallbackOrder/
// llmFallbackModels were fully supported backend-side with zero UI anywhere). Shared between
// pages/app/agents.tsx (merchant) and pages/dashboard/agents.tsx (admin) — both import from here
// so the two surfaces can't drift apart, same discipline as agent-config.ts's shared FormState.
//
// No drag-and-drop library exists in this codebase (checked package.json) — a plain numbered
// list with up/down buttons gives the exact same "set the order" outcome without adding a new
// dependency for what's a 2-3 item list, not a long draggable canvas.
import { ArrowUp, ArrowDown, X, Plus, RotateCcw } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { useState } from "react";

const controlBtnCls =
  "inline-flex items-center justify-center rounded border border-border w-6 h-6 text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-30 disabled:pointer-events-none transition-colors";

/**
 * STT/TTS fallback order — candidate universe is fixed (the 3 real providers per type), so this
 * is reorder + include/exclude, not free text. `value` empty = "using the platform default chain"
 * (matches the backend's own null-means-default semantics in voice/failover.ts exactly — an empty
 * array and undefined are handled identically by resolveSttFailoverChain/resolveTtsFailoverChain).
 */
export function ProviderFallbackOrder({
  primary,
  allProviders,
  labels,
  value,
  onChange,
  defaultOrder,
}: {
  primary: string;
  allProviders: readonly string[];
  labels: Record<string, string>;
  value: string[];
  onChange: (next: string[]) => void;
  defaultOrder: readonly string[];
}) {
  const candidates = allProviders.filter((p) => p !== primary);
  const usingDefault = value.length === 0;
  const effective = usingDefault ? defaultOrder.filter((p) => candidates.includes(p)) : value.filter((p) => candidates.includes(p));
  const excluded = candidates.filter((p) => !effective.includes(p));

  function move(index: number, dir: -1 | 1) {
    const next = [...effective];
    const target = index + dir;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  }

  function remove(provider: string) {
    onChange(effective.filter((p) => p !== provider));
  }

  function add(provider: string) {
    onChange([...effective, provider]);
  }

  return (
    <div className="space-y-2">
      <ol className="space-y-1.5">
        {effective.map((provider, i) => (
          <li key={provider} className="flex items-center gap-2 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm">
            <span className="font-mono text-xs text-muted-foreground w-4">{i + 1}</span>
            <span className="flex-1">{labels[provider] ?? provider}</span>
            <button type="button" className={controlBtnCls} disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${labels[provider] ?? provider} up`}>
              <ArrowUp className="size-3.5" />
            </button>
            <button type="button" className={controlBtnCls} disabled={i === effective.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${labels[provider] ?? provider} down`}>
              <ArrowDown className="size-3.5" />
            </button>
            <button type="button" className={controlBtnCls} onClick={() => remove(provider)} aria-label={`Remove ${labels[provider] ?? provider} from fallback order`}>
              <X className="size-3.5" />
            </button>
          </li>
        ))}
        {effective.length === 0 && (
          <li className="rounded-md border border-dashed border-border px-2.5 py-2 text-xs text-muted-foreground">
            No fallback providers — if the primary fails, the call ends instead of trying an alternative.
          </li>
        )}
      </ol>
      {excluded.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {excluded.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => add(p)}
              className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground hover:border-foreground/40 transition-colors"
            >
              <Plus className="size-3" /> Add {labels[p] ?? p} as fallback
            </button>
          ))}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        {usingDefault
          ? `Using the platform default order. Reorder or remove above to customize.`
          : (
            <>
              Custom order set.{" "}
              <button type="button" onClick={() => onChange([])} className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-foreground">
                <RotateCcw className="size-3" /> Reset to platform default
              </button>
            </>
          )}
      </p>
    </div>
  );
}

/**
 * LLM fallback models — free-text AI Gateway model ids (no fixed enum on the backend, unlike
 * STT/TTS), so this is add/remove/reorder rather than include/exclude from a known list.
 */
export function ModelFallbackList({
  value,
  onChange,
  suggestions,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  suggestions?: readonly string[];
}) {
  const [draft, setDraft] = useState("");

  function addModel() {
    const trimmed = draft.trim();
    if (!trimmed || value.includes(trimmed)) return;
    onChange([...value, trimmed]);
    setDraft("");
  }

  function move(index: number, dir: -1 | 1) {
    const next = [...value];
    const target = index + dir;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  }

  function remove(model: string) {
    onChange(value.filter((m) => m !== model));
  }

  return (
    <div className="space-y-2">
      <ol className="space-y-1.5">
        {value.map((model, i) => (
          <li key={model} className="flex items-center gap-2 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm">
            <span className="font-mono text-xs text-muted-foreground w-4">{i + 1}</span>
            <span className="flex-1 font-mono text-xs">{model}</span>
            <button type="button" className={controlBtnCls} disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${model} up`}>
              <ArrowUp className="size-3.5" />
            </button>
            <button type="button" className={controlBtnCls} disabled={i === value.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${model} down`}>
              <ArrowDown className="size-3.5" />
            </button>
            <button type="button" className={controlBtnCls} onClick={() => remove(model)} aria-label={`Remove ${model}`}>
              <X className="size-3.5" />
            </button>
          </li>
        ))}
        {value.length === 0 && (
          <li className="rounded-md border border-dashed border-border px-2.5 py-2 text-xs text-muted-foreground">
            No fallback models set — only active on the AI Gateway provider (not Groq). Add one below.
          </li>
        )}
      </ol>
      <div className="flex gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addModel();
            }
          }}
          placeholder="e.g. openai/gpt-5.4-mini"
          list="llm-fallback-suggestions"
          className="flex-1"
        />
        {suggestions && (
          <datalist id="llm-fallback-suggestions">
            {suggestions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        )}
        <Button type="button" size="sm" variant="outline" onClick={addModel} disabled={!draft.trim()}>
          <Plus className="size-3.5" /> Add
        </Button>
      </div>
    </div>
  );
}
