import { Sparkles } from "lucide-react";

/** Top-right trigger for PreviewDrawer — same button on both /app/agents and /dashboard/agents. */
export function PreviewButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted transition-colors"
    >
      <Sparkles className="size-3.5 text-primary" aria-hidden />
      Preview
    </button>
  );
}
