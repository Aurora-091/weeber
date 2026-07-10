/**
 * Single-series horizontal bar meter list — magnitude of one measure across
 * labeled rows. Per the dataviz method: one hue (the brand accent as the
 * sequential hue; identity lives in the row labels, not color), thin
 * rounded-end marks on a recessive track, every value directly labeled in
 * text tokens, no legend (single series). Don't extend this to multi-hue
 * series without running the palette validator first.
 */
export function BarMeterList({ title, counts }: { title?: string; counts: Record<string, number> }) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map(([, v]) => v));
  return (
    <div className="rounded-lg border border-border p-4">
      {title && <div className="mb-3 text-sm font-medium">{title}</div>}
      {entries.length === 0 && <p className="text-xs text-muted-foreground">No data in this range.</p>}
      <div className="space-y-2">
        {entries.map(([key, count]) => (
          <div key={key} className="flex items-center gap-2">
            <span className="w-36 shrink-0 truncate font-mono text-xs" title={key}>
              {key}
            </span>
            <div
              className="h-2 flex-1 overflow-hidden rounded-full bg-muted"
              role="img"
              aria-label={`${key}: ${count}`}
            >
              <div className="h-full rounded-full bg-primary/70" style={{ width: `${(count / max) * 100}%` }} />
            </div>
            <span className="w-8 shrink-0 text-right text-xs text-muted-foreground">{count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
