/**
 * Production migration runner.
 *
 * Replaces `bunx drizzle-kit migrate` in the deploy start path (ADR-076).
 *
 * Two reasons this exists instead of shelling out to the drizzle-kit CLI:
 *
 * 1. drizzle-kit swallows the database error. On failure its spinner clears the
 *    line and the process exits 1 with no diagnostic at all — the Railway
 *    deploy log showed only `[⡿] applying migrations...` followed by
 *    `error: script "start:railway" exited with code 1`, six times in a
 *    crash-loop, with the actual Postgres error never written to stdout or
 *    stderr. An unshippable deploy with an invisible cause is not debuggable.
 *    This runner prints every field Postgres gives us, cause chain included.
 *
 * 2. drizzle-kit is a devDependency and builds its own postgres.js client with
 *    the library defaults, which means prepared statements are ON. The app's
 *    own client deliberately sets `prepare: false` (ADR-034) because Supabase's
 *    transaction-mode pooler on port 6543 — which is what DATABASE_URL points
 *    at — does not reliably support them. Production should not be starting by
 *    invoking a dev CLI whose connection settings we cannot configure.
 *
 * Uses drizzle-orm's own migrator, which reads the same
 * `drizzle/meta/_journal.json` and the same `drizzle.__drizzle_migrations`
 * table, so migration state stays shared with `bun run db:migrate` locally.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { describeMigrationError } from "../src/database/migration-error";

// Resolved off this file, not the working directory, so the runner behaves the
// same whether it's invoked from the repo root or from packages/api.
const migrationsFolder = new URL("../drizzle", import.meta.url).pathname;

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("[migrate] DATABASE_URL is not set — refusing to run migrations.");
  process.exit(1);
}

// `max: 1` because migrations are strictly sequential and a single connection
// keeps every statement on one pooler backend. `prepare: false` per ADR-034.
const client = postgres(url, {
  prepare: false,
  max: 1,
  idle_timeout: 20,
  connect_timeout: 30,
  onnotice: (notice) => {
    // "schema already exists, skipping" on every boot is expected noise, but
    // silently discarding notices is how migration surprises stay invisible.
    console.log(`[migrate] notice ${notice.code ?? "?"}: ${notice.message ?? ""}`);
  },
});

const startedAt = Date.now();
console.log(`[migrate] applying migrations from ${migrationsFolder}`);

try {
  await migrate(drizzle(client), { migrationsFolder });
  console.log(`[migrate] up to date in ${Date.now() - startedAt}ms`);
} catch (error) {
  console.error(`[migrate] FAILED after ${Date.now() - startedAt}ms`);
  console.error(describeMigrationError(error));
  await client.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
}

await client.end({ timeout: 5 }).catch(() => {});
process.exit(0);
