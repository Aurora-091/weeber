# ADR-076: A start command that hides its failure is not shippable

- **Date:** 2026-08-08
- **Status:** Accepted
- **Relates to:** ADR-034 (Supabase Postgres, transaction-mode pooler, `prepare: false`), ADR-075 (a required check must assert what succeeded)

## Context

`1de740a` — the ADR-075 CI gate fix — is on `origin/main` with all 11 checks green. Deploying it to
Railway production took **five attempts across 35 minutes**, four of which failed:

| Deployment | Created | Result |
| --- | --- | --- |
| `2f81281d-1255-4c62-829a-1565e2ae76aa` | 2026-08-08T17:34:13.641Z | FAILED — reported as "1/1 replicas never became healthy" |
| `9fa745af-1096-4335-b836-619a83e473b1` | 2026-08-08T17:42:15.913Z | FAILED — same |
| `425af76c-e5bf-461e-ab3d-78164fc1f202` | 2026-08-08T17:43:14.134Z | **SUCCESS** — one minute later, same commit, nothing changed |
| `01921c55-881c-433a-873f-780d73dd5256` | 2026-08-08T18:00:07.102Z | FAILED — redeploy, after `healthcheckTimeout` was raised to 300s |
| `bc8b5341-e89b-410e-a1af-d23331db5020` | 2026-08-08T18:09:26.411Z | FAILED — redeploy |

The success at 17:43 matters and was initially missed: **the same commit succeeded 58 seconds after it
failed, with no intervening change.** So this is not a deterministic incompatibility between the commit
and production — it is intermittent, roughly one attempt in five, which rules out every "the code or the
config is wrong" explanation on its own.

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
version, same migration state, healthy pooler — succeeds from a sandbox, fails intermittently inside the
Railway container. **The root cause is not proven**, and it cannot be proven for as long as the failing
command refuses to say what went wrong. That is what makes the diagnostic the fix worth shipping first.

Two intermittency sources were found while investigating, both real regardless of which one caused these
particular failures:

**1. Every push to `main` deploys to staging and production simultaneously, against one database.**
`service.repoTriggers` has two entries and they are *not* duplicates, which is how they were first
misread — one is scoped to the staging environment `573770c5`, one to production `669b2931`, and both
watch `main`. The 17:34 attempt is the clearest evidence: staging deployment `db0992d2` was created at
`17:34:13.256Z` and **succeeded**, production `2f81281d` at `17:34:13.641Z` — 385 ms later — and
**failed**. Since staging shares production's `DATABASE_URL`, both containers ran `drizzle-kit migrate`
against the same database within the same second. `CREATE SCHEMA IF NOT EXISTS` and `CREATE TABLE IF NOT
EXISTS` are *not* concurrency-safe in Postgres: two sessions that pass the existence check together race
to insert into `pg_namespace`/`pg_class` and the loser gets a unique-violation, not a silent skip. A
sandbox run has no competitor, which is exactly why it always succeeded there.

**2. A session-level `SET` can leak into a pooled backend and make it read-only.** Separately documented
in the same day's incident notes: a `set default_transaction_read_only = on` guard, intended to protect
production during read-only auditing, persisted on a Supavisor transaction-mode backend after the client
disconnected and was handed to application traffic — staging's seed at 17:45:25 failed with
`cannot execute UPDATE in a read-only transaction` (`routine: PreventCommandIfReadOnly`). A migration
that lands on such a backend fails on its first DDL statement, intermittently, depending purely on which
backend the pooler hands out. The affected backends were reset and 30 sequential plus 80 concurrent
probes across 6 distinct backends now report `off`. The standing rule from that incident — never `SET`
anything over the pooler, use `begin read only; …; commit;` — applies to migrations too, and is a second
reason the runner below opens its own client with explicit settings rather than inheriting whatever a CLI
decides.

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

## Outcome (same day, after the runner landed)

- `ac49d35` deployed to production at 18:26:46 and again on a redeploy at 18:29:26 — **two consecutive
  successes** where the old command had failed four times out of five. The runner's own output in the
  container: `[migrate] applying migrations from /app/packages/api/drizzle`, the two expected
  `already exists, skipping` notices, `[migrate] up to date in 622ms`, then the server bound on 8080.
  Migrations now report what they did on every boot instead of only spinning.
- Both deployment triggers were switched to `checkSuites: true`, so neither staging nor production can
  auto-deploy a commit whose GitHub check suite has not passed. Previously both were `false`, which meant
  ADR-075's gate protected `main` but protected nothing about what reached production.
- Production deployments now arrive in `NEEDS_APPROVAL` and require an explicit approve before they run.
  This was not configured as part of this work — it was observed on the `ac49d35` push. It has a useful
  side effect worth keeping in mind: approving production alone, without approving staging, is what
  guaranteed the 18:26 deploy had no concurrent peer racing it on the shared database.
- Still open, and deliberately not changed here: staging and production share one database, so a staging
  deploy carrying migrations production does not have would apply them to production's schema. Both
  triggers watch `main` today so the commits match, but nothing enforces that. The narrow fix is to gate
  the migration step on owning the database rather than on merely booting.
