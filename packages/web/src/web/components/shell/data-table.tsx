import React, { useState, useMemo } from "react";
import { ChevronUp, ChevronDown, ArrowUpDown } from "lucide-react";
import { cn } from "../../lib/utils";

export type SortDir = "asc" | "desc";

export type Column<T> = {
  key: string;
  header: React.ReactNode;
  className?: string;
  render: (row: T) => React.ReactNode;
  /**
   * Provide a primitive extractor to enable client-side sorting for this column.
   * Returning null/undefined sorts the row to the bottom.
   */
  sortValue?: (row: T) => string | number | null | undefined;
};

/**
 * Flat, thin-bordered data table (UI-DESIGN-BRIEF "inline content" surface).
 * Row padding follows the shell density variables.
 *
 * Accessibility:
 * - Every <th> carries scope="col" and aria-sort when sortable.
 * - Clickable rows are keyboard-accessible (Enter/Space) with a visible focus ring.
 * - Pass `caption` for a visually-hidden accessible table name (preferred) or
 *   `aria-label` for a quick inline label when no caption is practical.
 * - Empty-string headers (action columns) render a sr-only "Actions" label.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  caption,
  "aria-label": ariaLabel,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string | number;
  onRowClick?: (row: T) => void;
  /** Visually hidden <caption> — preferred way to name the table for screen readers. */
  caption?: string;
  /** Fallback accessible name when no caption is provided. */
  "aria-label"?: string;
}) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  function handleSort(key: string) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  const sortedRows = useMemo(() => {
    if (!sortKey) return rows;
    const col = columns.find((c) => c.key === sortKey);
    if (!col?.sortValue) return rows;
    return [...rows].sort((a, b) => {
      const av = col.sortValue!(a) ?? "";
      const bv = col.sortValue!(b) ?? "";
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
  }, [rows, sortKey, sortDir, columns]);

  return (
    <div className="overflow-x-auto rounded-lg border border-border content-fade-in">
      <table
        className="w-full text-sm"
        aria-label={!caption ? ariaLabel : undefined}
      >
        {caption && <caption className="sr-only">{caption}</caption>}

        <thead>
          <tr className="border-b border-border bg-muted/40 text-left">
            {columns.map((col) => {
              const isSortable = Boolean(col.sortValue);
              const isActive = sortKey === col.key;
              const ariaSortValue: React.AriaAttributes["aria-sort"] = isSortable
                ? isActive
                  ? sortDir === "asc"
                    ? "ascending"
                    : "descending"
                  : "none"
                : undefined;

              // Action columns intentionally have no visible header text.
              // Render a sr-only label so assistive tech still announces the column.
              const headerLabel = col.header || <span className="sr-only">Actions</span>;

              return (
                <th
                  key={col.key}
                  scope="col"
                  aria-sort={ariaSortValue}
                  className={cn(
                    "px-3 py-2 text-xs font-medium text-muted-foreground",
                    col.className,
                  )}
                >
                  {isSortable ? (
                    <button
                      type="button"
                      onClick={() => handleSort(col.key)}
                      className="inline-flex items-center gap-1 rounded-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    >
                      {headerLabel}
                      {isActive ? (
                        sortDir === "asc" ? (
                          <ChevronUp className="size-3 shrink-0" aria-hidden />
                        ) : (
                          <ChevronDown className="size-3 shrink-0" aria-hidden />
                        )
                      ) : (
                        <ArrowUpDown className="size-3 shrink-0 opacity-40" aria-hidden />
                      )}
                    </button>
                  ) : (
                    headerLabel
                  )}
                </th>
              );
            })}
          </tr>
        </thead>

        <tbody>
          {sortedRows.map((row) => (
            <tr
              key={rowKey(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              onKeyDown={
                onRowClick
                  ? (e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onRowClick(row);
                      }
                    }
                  : undefined
              }
              tabIndex={onRowClick ? 0 : undefined}
              className={cn(
                "border-b border-border last:border-b-0",
                onRowClick &&
                  "cursor-pointer transition-colors duration-150 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              )}
            >
              {columns.map((col) => (
                <td
                  key={col.key}
                  className={cn("px-3", col.className)}
                  style={{
                    paddingTop: "var(--shell-row-py)",
                    paddingBottom: "var(--shell-row-py)",
                  }}
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
