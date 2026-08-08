# ADR-076: A start command that hides its failure is not shippable

- **Date:** 2026-08-08
- **Status:** Accepted
- **Relates to:** ADR-034 (Supabase Postgres, transaction-mode pooler, `prepare: false`), ADR-075 (a required check must assert what succeeded)

## Context

Production is running commit `1337df4`. `1de740a` — the ADR-075 CI gate fix — is on `origin/main` with
all 11 checks green, and has been deployed to Railway production **twice**:

| Deployment | Created | Result |
| --- | --- | --- |
| `2f81281d-1255-4c62-829a-1565e2ae76aa` | 2026-08-08T17:34:13Z | FAILED — reported as "1/1 replicas never became healthy" |
| `01921c55-881c-433a-873f-780d73dd5256` | 2026-08-08T18:00:07Z | FAILED — same, after `healthcheckTimeout` was raised to 300s |

The healthcheck was a symptom, not the cause. `deploymentLogs` for `01921c55` show a hard crash-loop
restarting roughly every 1.5 seconds — six container starts between 18:01:02 and 18:01:11 — and every
one of them produced exactly this, and nothing else:

```
$ cd packages/api && bunx drizzle-kit migrate && bun run src/server.ts
No config path provided, using default 'drizzle.config.ts'
Reading config file '/app/packages/api/drizzle.config.ts'
Using 'postgres' driver for database querying
[⣷] applying migrations...[⣯] applying migrations...[⡿] applying migrations...
error: script "start:railway" exited with code 1
```

The server never binds because `bunx drizzle-kit migrate` exits 1 first. **The database error is never
written anywhere.** The log stream was re-fetched and decoded with carriage returns expanded and ANSI
sequences stripped, in case the spinner had merely overwritten the text — it had not. drizzle-kit's
spinner clears its line on failure and the process exits without printing the driver error at all. So
the deploy is not just broken, it is undebuggable from the only place we can observe it.

Every hypothesis that could be tested from outside the container was tested and eliminated:

- **Migration state drift.** Production `drizzle.__drizzle_migrations` holds exactly 47 rows (ids 4–50),
  zero NULL `created_at`, and `max(created_at) = 1785521763852`, which equals journal index 46
  (`0046_colorful_robbie_robertson`) — the last entry. The repo has 47 `.sql` files and 47 journal
  entries. There is nothing pending to apply.
- **Migration logic.** A throwaway local database was seeded with those exact 47 rows and
  `bunx drizzle-kit migrate` run against it: two expected `already exists, skipping` notices, then
  `[✓] migrations applied successfully!`, exit 0.
- **drizzle-kit version drift via `bunx`.** npm `dist-tags.latest` for `drizzle-kit` is `0.31.10`,
  identical to `packages/api/package.json` (`^0.31.10`) and `bun.lock`.
- **Connection exhaustion.** `pg_stat_activity` on production: 15 connections total, 1 active,
  against `max_connections = 90`.
- **Database in a read-only or degraded state.** `pg_is_in_recovery() = false`, database size 14 MB,
  PostgreSQL 17.6, reachable and writable-in-principle.
- **Pooler incompatibility.** A SELECT-only postgres.js probe against the production port-6543 pooler
  passed: simple queries, repeated parameterised (prepared) statements, `sql.begin()` transactions.
  A second probe ran 96 parameterised queries across 8 pooled connections with `prepare: true` and with
  `prepare: false` — 0 errors either way.

So: same commit, same `DATABASE_URL` (verified byte-identical to the value in Railway), same drizzle-kit
version, same migration state, healthy pooler — succeeds from a sandbox, fails inside the Railway
container. **The root cause is still unidentified**, and it will stay unidentified for as long as the
failing command refuses to say what went wrong.

Two further problems with the command itself, independent of this incident:

1. **`drizzle-kit` is a devDependency.** Production's start path shells out to a development CLI via
   `bunx`, which means the deployed image's dependency pruning and npm's registry state are both inputs
   to whether production boots.
2. **Its connection settings are not configurable.** `drizzle.config.ts` exposes only a URL. drizzle-kit
   constructs its own postgres.js client with library defaults, so prepared statements are **on**. The
   application's own client sets `prepare: false` deliberately (ADR-034) because `DATABASE_URL` points at
   Supabase's transaction-mode pooler. Migrations were connecting on terms the rest of the app has
   documented as unsafe.

## Decision

Migrations in the deploy path run through **our own runner**, `packages/api/scripts/migrate.ts`, which
calls drizzle-orm's programmatic `migrate()` — the same journal (`drizzle/meta/_journal.json`) and the
same ledger table (`drizzle.__drizzle_migrations`), so state stays shared with `bun run db:migrate`
locally and nothing about migration history changes.

`start:railway` becomes:

```
cd packages/api && bun run scripts/migrate.ts && bun run src/server.ts
```

The runner:

- Connects with `prepare: false` (ADR-034) and `max: 1` — migrations are strictly sequential, and one
  connection keeps every statement on a single pooler backend.
- Refuses to run, with a named error, when `DATABASE_URL` is unset, instead of falling through to a
  driver default.
- Logs Postgres **notices** rather than discarding them.
- On failure prints every field Postgres populates — `severity`, `code`, `detail`, `hint`, `position`,
  `constraint_name`, `routine`, and the socket-level `errno`/`syscall`/`address`/`port` — and then walks
  `.cause`, because drizzle-orm wraps the driver error in a plain `Error` whose message is the failing SQL
  and hangs the real `PostgresError` one level down. A formatter that stops at the top level reproduces
  the exact blindness this ADR exists to remove: you learn which statement died, never why.
- Resolves the migrations folder from `import.meta.url`, not the working directory.

The formatter lives at `src/database/migration-error.ts` rather than inside the script, because the
script is a top-level-`await` entrypoint that opens a database connection on import and therefore cannot
be unit tested; `src/` is what `bun test src/` covers.

Uses `bunx drizzle-kit` are unchanged everywhere else — `db:generate`, `db:push`, `db:studio`, the local
`db:migrate`, and the "Drizzle migrations match schema.ts" CI job are all development-side and keep the
CLI.

## Consequences

- The next production deploy will either succeed or print the actual Postgres error. This ADR does **not**
  claim to fix the deploy; it makes the failure legible, which is the prerequisite for fixing it.
- Production no longer depends on a devDependency CLI, or on npm resolution at container start, to boot.
- Migrations now connect on the same terms as the application (ADR-034) instead of contradicting them.
- Migrations still run **in the start path**, so a migration failure still crash-loops the container
  rather than blocking the deploy. Moving them to Railway's `preDeployCommand`, so a failed migration
  fails the deploy visibly and leaves the previous version serving, is the correct next step and is
  deliberately not bundled into this change — one variable at a time while the cause is unknown.
- `healthcheckTimeout` on the production service was raised from its default to 300s during this
  investigation and has not been reverted. It was not the cause and should be reconsidered once deploys
  are green again.

## Alternatives considered

- **Run `drizzle-kit migrate` from a sandbox against production to capture the error.** It would have
  answered the question in one command, but it issues `CREATE SCHEMA IF NOT EXISTS` / `CREATE TABLE IF
  NOT EXISTS` — writes — against production, and production was being treated as strictly read-only for
  this investigation. Rejected without explicit authorisation, and made unnecessary by the runner.
- **Pipe the CLI's output through `cat` or a file, then expand carriage returns.** Already effectively
  tested by decoding the raw log stream: the error text is not in the stream at all, so no amount of
  reformatting recovers it.
- **Keep the CLI and wrap it in a shell trap that dumps state on non-zero exit.** Layers a second
  guessing mechanism on top of a tool that has demonstrated it will not report its own errors, and leaves
  the devDependency and `prepare: true` problems in place.
- **Drop migrations from the start path entirely and run them by hand.** Trades an invisible failure for
  an un-run migration, which is worse — the schema would drift from the deployed code with nothing
  checking.
