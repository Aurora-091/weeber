/**
 * Formatting for migration failures (ADR-076).
 *
 * Lives in `src/` rather than next to `scripts/migrate.ts` so it is covered by
 * `bun test src/` — the runner script itself is a top-level-await entrypoint
 * that connects to a database on import, so it cannot be unit tested directly.
 */

/** Every field postgres.js copies off a Postgres ErrorResponse, plus the basics. */
const PG_ERROR_FIELDS = [
  "name",
  "message",
  "severity",
  "code",
  "detail",
  "hint",
  "position",
  "internal_position",
  "internal_query",
  "where",
  "schema_name",
  "table_name",
  "column_name",
  "data_type_name",
  "constraint_name",
  "file",
  "line",
  "routine",
  "errno",
  "syscall",
  "address",
  "port",
] as const;

const MAX_CAUSE_DEPTH = 5;

/**
 * drizzle-orm wraps the driver error in a plain `Error` whose message is the
 * failing SQL, and hangs the real PostgresError — the one carrying `code`,
 * `detail` and `hint` — off `.cause`. Printing only the top-level error tells
 * you which statement died but not why, so walk the whole chain.
 */
export function describeMigrationError(error: unknown, depth = 0): string {
  const indent = "  ".repeat(depth + 1);
  if (!(error instanceof Error)) {
    return `${indent}non-Error thrown: ${String(error)}`;
  }
  const record = error as unknown as Record<string, unknown>;
  const lines: string[] = [];
  for (const field of PG_ERROR_FIELDS) {
    const value = record[field];
    if (value !== undefined && value !== null && value !== "") {
      lines.push(`${indent}${field}: ${String(value).replaceAll("\n", " ")}`);
    }
  }
  if (error.stack) {
    lines.push(`${indent}stack: ${error.stack.replaceAll("\n", `\n${indent}  `)}`);
  }
  if (error.cause !== undefined && error.cause !== null && depth < MAX_CAUSE_DEPTH) {
    lines.push(`${indent}caused by:`);
    lines.push(describeMigrationError(error.cause, depth + 1));
  }
  return lines.join("\n");
}
