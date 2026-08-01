import { Skeleton } from "../ui/skeleton";

export function SkeletonTable({ columns = 4, rows = 6 }: { columns?: number; rows?: number }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border shadow-weeber-card" aria-hidden>
      <div className="flex gap-4 border-b border-border bg-muted/40 px-3 py-2">
        {Array.from({ length: columns }).map((_, i) => (
          <Skeleton key={i} className="h-3.5 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-4 border-b border-border px-3 py-shell-row last:border-b-0">
          {Array.from({ length: columns }).map((_, c) => (
            <Skeleton key={c} className="h-4 flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}

export function SkeletonCards({ count = 3, lines = 3 }: { count?: number; lines?: number }) {
  return (
    <div className="grid gap-[var(--shell-card-gap)] @xl:grid-cols-2 @4xl:grid-cols-3" aria-hidden>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="rounded-lg border border-border bg-card p-4 shadow-weeber-card">
          <Skeleton className="mb-3 h-4 w-2/5" />
          {Array.from({ length: lines }).map((_, l) => (
            <Skeleton key={l} className="mb-2 h-3.5 w-full last:mb-0" />
          ))}
        </div>
      ))}
    </div>
  );
}
