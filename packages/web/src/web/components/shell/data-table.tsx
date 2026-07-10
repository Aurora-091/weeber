import { cn } from "../../lib/utils";

export type Column<T> = {
  key: string;
  header: React.ReactNode;
  className?: string;
  render: (row: T) => React.ReactNode;
};

/**
 * Flat, thin-bordered data table (UI-DESIGN-BRIEF "inline content" surface).
 * Row padding follows the shell density variables.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string | number;
  onRowClick?: (row: T) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border content-fade-in">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/40 text-left">
            {columns.map((col) => (
              <th key={col.key} className={cn("px-3 py-2 text-xs font-medium text-muted-foreground", col.className)}>
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={cn(
                "border-b border-border last:border-b-0",
                onRowClick && "cursor-pointer transition-colors duration-150 hover:bg-muted/50",
              )}
            >
              {columns.map((col) => (
                <td
                  key={col.key}
                  className={cn("px-3", col.className)}
                  style={{ paddingTop: "var(--shell-row-py)", paddingBottom: "var(--shell-row-py)" }}
                >
                  {col.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
