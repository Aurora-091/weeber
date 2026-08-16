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

## Addendum (2026-08-17) — a second connection pool for everything that isn't a live call

Raised directly: "what if too many things are interfering with each other, which drops performance."
Checked, and it's real. `database/index.ts` exported one `db` singleton — one 20-connection pool — used
by all 52 files in this package that touch Postgres. That pool is shared between the two workloads this
product can least afford to let compete: a live call's per-turn writes (`turnLatency`/`transcripts`
inserts, per-turn config reads — the exact numbers ADR-107/audit-13 exist to protect) and everything
timer-driven or dashboard-shaped (the scheduler sweep, the webhook delivery retry loop, the org-lifecycle
sweep, admin-panel reads, merchant analytics aggregations, Shopify webhook ingestion). A slow multi-second
analytics query or a mid-batch sweep holding connections can queue out a live call's turn-latency write
behind it on the same pool — the worst failure mode a voice product has.

**Decision:** add `dbBackground`, a second `postgres.js` client in `database/index.ts` against the same
`DATABASE_URL` (`DATABASE_POOL_MAX_BACKGROUND`, default 8, well under half of `db`'s), and repoint every
file whose code is provably never reachable from a live call's turn (`stream.ts`/`agent.ts`'s import
graph) at it:

- **Whole files** (import aliased to `dbBackground as db`, zero other changes): `admin-routes.ts` (both
  the top-level one and `workflows/admin-routes.ts`), `workflows/scheduler.ts`,
  `workflows/org-lifecycle-sweep.ts`, `app/support.ts`, `app/broadcasts.ts`, `app/waitlist.ts`,
  `app/export.ts`, `app/audit-log.ts`, `integrations/shopify/routes.ts`,
  `integrations/shopify/idempotency.ts`.
- **Split within a file, by function, because one export is reachable from the call path and the rest
  aren't:** `webhooks.ts` — `dispatchWebhook` (the fire-and-forget enqueue `stream.ts` calls mid-call)
  stays on `db`; `processWebhookOutbox`/`markFailed` (the timer-driven retry sweep) move to
  `dbBackground`. `org-queries.ts` — 18 of its 19 exported functions are dashboard/admin/onboarding-only
  and move; `getEffectiveFlags` alone stays on `db` (aliased `dbHotPath` in that file) because both
  `stream.ts` (per-turn) and the compliance number-series gate call it live.
- **Untouched, verified by tracing the actual import graph rather than assuming:** everything
  `stream.ts`/`agent.ts` import directly or transitively — `caller-memory.ts`, `leads/leads.ts`,
  `tools/bookAppointment.ts`, `template-visibility.ts`, the compliance gates, `knowledge-base.ts`,
  `place-outbound-call.ts` (a call-initiation path, not a sweep — deliberately left on the default pool
  as the conservative choice rather than guessed into the background one).

**Why not a read replica or a second Postgres instance instead:** no new infra exists yet for the new
Supabase project this whole pass is preparing for, and a pure application-side connection-budget split
gets most of the isolation for zero additional moving parts. Revisit if `dbBackground`'s own workload
ever grows large enough to want its own physical resources.

**Test-suite cost:** 15 test files mock `"../database"` via `mock.module` and needed their mock factory
to also export `dbBackground` (Bun throws `SyntaxError: Export named 'dbBackground' not found` at import
time otherwise, rather than silently returning `undefined` — a loud, immediate failure that made every
affected file easy to find by just running the suite). Fixed by exporting the same fake `db`-like object
under both names in each — none of the fakes care which pool name a call went through, only what table a
query targets. 1402/1402 tests pass, typecheck/lint/knip:gate clean.

**Known and unfixed:** no production evidence yet that this contention was ever actually observed (there
is no traffic on the new project yet) — this is a structural safeguard against a failure mode that's
obviously possible given the shared-singleton architecture, not a measured regression being fixed.
`DATABASE_POOL_MAX_BACKGROUND`'s default (8) is a starting guess, same status as `DATABASE_POOL_MAX`'s
own default — both should be revisited once the new project has real traffic to size them against.
