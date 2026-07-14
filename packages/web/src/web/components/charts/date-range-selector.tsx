const RANGES = [
  { label: "7d", days: 7 },
  { label: "14d", days: 14 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
] as const;

type Range = (typeof RANGES)[number]["days"];

type Props = {
  value: number;
  onChange: (days: number) => void;
  options?: Range[];
};

export function DateRangeSelector({ value, onChange, options = [7, 30, 90] }: Props) {
  const visible = RANGES.filter((r) => options.includes(r.days as Range));
  return (
    <div className="flex items-center gap-1 rounded-lg border border-border bg-muted/40 p-0.5">
      {visible.map(({ label, days }) => (
        <button
          key={days}
          type="button"
          onClick={() => onChange(days)}
          className={`rounded-md px-3 py-1 text-xs font-medium transition-all ${
            value === days
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
