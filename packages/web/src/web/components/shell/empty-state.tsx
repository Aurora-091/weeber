/**
 * Text-only empty/error state per UI-DESIGN-BRIEF: serif headline, one plain
 * line, one optional action. Deliberately no illustrations.
 */
export function EmptyState({
  title,
  description,
  action,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border px-6 py-14 text-center">
      <h3 className="text-lg font-medium">{title}</h3>
      {description && <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  );
}
