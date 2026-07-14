type Props = {
  title?: string;
  counts: Record<string, number>;
};

export function BreakdownList({ title, counts }: Props) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map(([, v]) => v));
  const total = entries.reduce((sum, [, v]) => sum + v, 0);

  return (
    <div className="card-weeber p-4">
      {title && <div className="text-sm font-medium mb-3">{title}</div>}
      {entries.length === 0 && (
        <p className="text-xs text-muted-foreground">No data in this range.</p>
      )}
      <div className="space-y-2">
        {entries.map(([key, count]) => {
          const pct = total > 0 ? ((count / total) * 100).toFixed(1) : "0.0";
          return (
            <div key={key} className="group relative flex items-center gap-2">
              <span className="w-36 shrink-0 truncate font-mono text-xs" title={key}>
                {key}
              </span>
              <div
                className="h-2 flex-1 overflow-hidden rounded-full bg-muted"
                role="img"
                aria-label={`${key}: ${count}`}
              >
                <div
                  className="h-full rounded-full bg-primary/70 transition-all"
                  style={{ width: `${(count / max) * 100}%` }}
                />
              </div>
              <span className="w-8 shrink-0 text-right text-xs text-muted-foreground">
                {count}
              </span>
              <span className="absolute right-0 -top-5 hidden group-hover:inline-block whitespace-nowrap rounded bg-foreground px-1.5 py-0.5 text-[10px] font-medium text-background shadow-sm">
                {pct}%
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
