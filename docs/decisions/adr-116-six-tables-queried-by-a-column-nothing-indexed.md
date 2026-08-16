# ADR-116 — Six tables queried by a column nothing indexed

- **Date:** 2026-08-17
- **Status:** Accepted (implemented 2026-08-17)

## Context

The project is moving off its current Supabase account to a new one with an empty database — no data
to migrate, no downtime constraint, no locking concern. That is also the one window where a schema
correction costs nothing: every index below will exist from the first row inserted, instead of being
retrofitted onto a live table later (`CREATE INDEX CONCURRENTLY`, monitoring for lock contention, the
usual production-index dance). Asked directly to use it: audit the schema and real query call sites for
missing indexes and query-shape problems before the new project's migrations run for the first time.

Method: read every table in `schema.ts` (44 tables), then grepped every real call site against the ones
that looked under-indexed, rather than guessing from the schema alone — the same discipline
`sota-runtime-fix-marathon-2026-08-16.md` and the audits it's grounded in insist on (a claim about what's
slow is only as good as whether it was checked against production code, not assumed). Six confirmed
gaps, all with a real query site cited below, not a hypothetical one.

## Decision

**Add six indexes, drop two that a new composite makes redundant, and batch two N+1 insert loops.**

| Table | Change | Real query site |
| --- | --- | --- |
| `tool_calls` | + `(call_id)` | `org-queries.ts` (`getOrgCallToolCalls`, and two batched dashboard aggregations), `routes.ts:458`, `admin-routes.ts:516`, `compliance/adapters.ts:129` (GDPR delete) — **four call sites, zero indexes on the table before this.** `transcripts` and `turn_latency` already had this same per-call-id index; `tool_calls` was the one left out. |
| `calls` | `org_id` idx → `(org_id, started_at)` composite | `listOrgCalls` — the merchant calls-list page — plus three separate dashboard range queries in `org-queries.ts` (`eq(orgId)` + `gte`/`lt(startedAt)`), all filtering and ranging on both columns together. Leftmost-prefix means the composite still serves every plain `orgId` lookup the old index did, so the old one added nothing once this exists. |
| `scheduled_calls` | `org_id` idx → `(org_id, run_at)` composite | `listOrgOrderCalls` (merchant Orders page): `eq(orgId)` + `orderBy(desc(runAt))`. The table's existing `(status, run_at)` composite doesn't serve this — different leading column, built for the scheduler sweep, not the per-org list. |
| `webhook_outbox` | + `(status, next_retry_at)` composite | `webhooks.ts`'s delivery sweep: `inArray(status, [pending, failed]) AND lte(nextRetryAt, now)` on every poll, unindexed. `scheduled_calls_status_run_at_idx` and `workflow_runs_status_next_run_at_idx` already have this exact shape for their own sweeps; `webhook_outbox` was the one delivery-poller table missing it. |
| `org_members` | + `(org_id)` | `admin-routes.ts:143` (org-detail view) and `broadcasts.ts:51` (send-to-org-audience) both filter `eq(orgId)`. The table's only prior index leads with `supabase_user_id`. |
| `support_tickets` | + `(status, created_at)` composite | `app/support.ts`'s admin queue: `eq(status)` + `orderBy(desc(createdAt))`. Table had no indexes at all. |
| `org_agent_configs` / `org_workflow_configs` seeding | N sequential `INSERT`s in a loop → one batched multi-row `INSERT` | `org-queries.ts`'s `provisionVerticalDefaults` (fires once per org, on first login/vertical assignment) — real N+1, low traffic, cheap and mechanical to fix while already in this file. |

Migration `0052_panoramic_squadron_supreme.sql` — pure `CREATE INDEX`/`DROP INDEX`, no data-shape change,
no backfill. Verified against `drizzle-kit generate`'s own diff output rather than hand-written, so it
matches `schema.ts` exactly.

## Rejected

- **Squashing the 52 migration files into one clean init before the new project's first run.** Real
  temptation with an empty target DB, but it rewrites a committed, already-shipped history for a benefit
  that doesn't exist here: applying 52 sequential migrations to an empty database costs low-single-digit
  seconds, and every one of them is small additive DDL. The only thing squashing would buy is a shorter
  `drizzle/` folder, at the cost of losing the paper trail `git blame` and the ADRs above it currently
  rely on (several ADRs cite a specific migration file by name as their evidence). Not done.
- **Enabling Supabase Row Level Security on these tables.** This backend never lets a browser talk to
  Postgres directly — every route goes through `packages/api`'s own Hono handlers, authenticated via
  `app/middleware/supabase-auth.ts` resolving `org_members`, using the single `DATABASE_URL` connection
  in `database/index.ts` (the Postgres role, not a per-user Supabase Auth JWT against PostgREST). RLS
  policies would be dead weight on a connection that never carries row-level identity to Postgres in the
  first place; the org-scoping this ADR's indexes exist to speed up is enforced in the API layer
  (`getOrgCall`'s `and(eq(calls.id), eq(calls.orgId))` 404-guard pattern), not the database layer. Adding
  RLS here would be solving an access-control problem this architecture doesn't have, at the cost of a
  policy on every table that has to be kept in sync with application logic that already does the job.
- **Switching `knowledge_chunks`' brute-force in-memory cosine-similarity scan to a real `pgvector`
  index.** Already a deliberate, documented scale call in the schema's own comment (brute-force is fine
  at hundreds-to-low-thousands of chunks per org); nothing in this pass found evidence that assumption
  has stopped holding, and adding a hard `pgvector` extension dependency for a new Supabase project
  before confirming it's actually needed would be exactly the kind of speculative change this repo's own
  conventions warn against.
- **Setting explicit `idle_timeout`/`connect_timeout` on the main app's postgres.js client**
  (`database/index.ts`), matching `scripts/migrate.ts`'s values. That script is a one-shot process where
  aggressive timeouts are pure upside; the main app holds a long-lived pool against Supavisor's
  transaction-mode pooler, where an `idle_timeout` that's too tight would force reconnects during quiet
  periods the pooler itself would have tolerated, trading a hypothetical stale-connection problem for a
  measured one. No production traffic data from the new project exists yet to tune this correctly — left
  alone rather than guessed at.

## Consequences

api tests **1402 → 1402** (no count change — this is instrumentation-free schema work, not new
behavior; two test-file mocks were updated to accept the batched-insert call shape:
`vertical-defaults.test.ts` and `app/routes.test.ts`, both previously assumed `.values()` only ever
received a single row). `bun run typecheck`, `bun run lint`, `knip:gate` (baseline 61, unchanged) all
clean.

**Known and unfixed:**

- **No production query-plan evidence yet.** Every index above is justified by "this WHERE/ORDER BY
  shape has no supporting index," not by an `EXPLAIN ANALYZE` against real data — because there is no
  real data yet in the target project. This is right for a pre-launch schema pass; it means these should
  be re-checked against `pg_stat_user_indexes`/`pg_stat_statements` once the new project has real call
  volume, the same way `sota-runtime-fix-marathon-2026-08-16.md`'s Phase 0 insists latency claims be
  re-grounded in measurement rather than carried forward as permanent truth.
- **This pass covered indexes and one N+1 loop, not query correctness or connection-pool tuning.**
  `database/index.ts`'s pool `max` (ADR-034, `DATABASE_POOL_MAX`) is untouched — it's already
  configurable and there's no new-project traffic to size it against yet.
- **`org_id` is a bare `text` column with no FK constraint** on `calls`, `scheduled_calls`,
  `webhook_outbox`, `org_members` and several others (logically related to `orgs.id`, never declared as
  `.references()`). Out of scope here — adding the FK constraints is a correctness question (can an
  orphaned `org_id` exist today, and does anything rely on that), not an indexing one, and deserves its
  own pass with its own evidence rather than being bundled into a performance ADR.
