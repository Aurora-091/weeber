import type { LucideIcon } from "lucide-react";
import { TrendingUp, TrendingDown } from "lucide-react";

type Props = {
  label: string;
  value: string;
  icon?: LucideIcon;
  hint?: string;
  trend?: number | null;
  sparkData?: number[];
};

function MiniSpark({ data }: { data: number[] }) {
  const max = Math.max(1, ...data);
  return (
    <div className="flex items-end gap-[2px] h-5 mt-2">
      {data.map((v, i) => (
        <div
          key={i}
          className="flex-1 min-w-[3px] max-w-[6px] rounded-sm bg-primary/50"
          style={{ height: `${Math.max(10, (v / max) * 100)}%` }}
        />
      ))}
    </div>
  );
}

function Trend({ value }: { value: number }) {
  const up = value >= 0;
  const Icon = up ? TrendingUp : TrendingDown;
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-[10px] font-medium ml-1.5 ${
        up ? "text-emerald-600" : "text-amber-600"
      }`}
    >
      <Icon className="size-3" aria-hidden />
      {up ? "+" : ""}
      {value.toFixed(1)}%
    </span>
  );
}

export function StatCard({ label, value, icon: Icon, hint, trend, sparkData }: Props) {
  return (
    <div className="card-weeber p-4">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1.5">
        {Icon && <Icon className="size-3.5" aria-hidden />}
        {label}
      </div>
      <div className="flex items-baseline gap-0.5">
        <span className="text-xl font-semibold tracking-tight">{value}</span>
        {trend != null && <Trend value={trend} />}
      </div>
      {hint && <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>}
      {sparkData && sparkData.length > 0 && <MiniSpark data={sparkData} />}
    </div>
  );
}
