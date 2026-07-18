import { Sparkles } from "lucide-react";

/** Top-right trigger for PreviewDrawer — same button on both /app/agents and /dashboard/agents. */
export function PreviewButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-medium text-foreground hover:bg-muted transition-colors duration-150"
    >
      <Sparkles className="size-3.5 text-primary" aria-hidden />
      Preview
    </button>
  );
}
