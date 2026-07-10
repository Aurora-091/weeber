import type { LucideIcon } from "lucide-react";

/**
 * Hero-number stat tile (dataviz: "sometimes the answer is not a chart").
 * Value in ink, label/hint in muted text tokens — color never carries the
 * number. `hint` is for honest labeling ("confirmed / attempted calls").
 */
export function StatTile({
  label,
  value,
  hint,
  icon: Icon,
}: {
  label: string;
  value: string;
  hint?: string;
  icon?: LucideIcon;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="mb-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
        {Icon && <Icon className="size-3.5" aria-hidden />}
        {label}
      </div>
      <div className="font-serif text-2xl font-medium tracking-tight">{value}</div>
      {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}
