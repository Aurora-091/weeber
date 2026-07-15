# Database & Distributed Systems Audit #06 — 2026-07-15

Scope: audit the actual codebase against a standard DB/distributed-systems concept checklist (ACID,
transactions, concurrency, reliability, integrity, performance, distributed systems, event systems,
security, recovery) — same rigor as the UI/UX audit series: every finding traced to real code, file
paths cited, no live-browser-equivalent (no live-traffic/load-test) claims made without saying so.
Verified against `HEAD` (`44acfd7`) after today's migration-idempotency pass.

---

## 1. Core Database Theory (ACID / BASE / CAP / PACELC)

**Architecture, not a bug**: single-region Supabase-managed Postgres (`ADR-034`), single Railway API
service, no read replicas, no multi-region failover visible anywhere in the codebase or `railway.json`.
This is unambiguously a **CP-leaning, not distributed** system in practice — there's no partition
tolerance to reason about because there's only one database and (as far as the code shows) one
writer. PACELC's "else" branch (latency vs. consistency trade-off during normal operation) isn't a
live design choice here either — every write goes through one Postgres instance with default
`READ COMMITTED` isolation (see §2). This isn't wrong for the current scale, but it means **the
system's actual availability ceiling is "however available Supabase's single Postgres instance is,"**
with zero app-level mitigation (no fallback datastore, no read-through cache serving stale data during
an outage). Worth being explicit about this rather than assuming BASE-style eventual consistency
exists anywhere — it doesn't; everything here is ACID-or-nothing against one database.

---

## 2. Transactions — 🔴 P1: zero use of database transactions anywhere in the codebase

```
grep -rln "\.transaction(" packages/api/src --include="*.ts" | grep -v test
```
returns **nothing**. Every multi-step write sequence in this codebase is a series of independent,
unwrapped statements — if the process crashes, throws, or the network drops between step 1 and step
2, you get a real partial-write state with no rollback. Concretely, the worst instance:

**`voice/workflows/graph-engine.ts`'s `"call"` node** (~line 144-172): schedules an outbound call
(`db.insert(scheduledCalls)`) and then parks the workflow run (`db.update(workflowRuns).set({status:
"waiting", ...})`) as two separate, unwrapped statements. If the process dies between them, the
`scheduled_calls` row exists and can get dialed, but `workflow_runs` still shows the *previous*
position/status — the next time this run gets touched (e.g. a retry sweep, or the same node getting
re-entered), nothing prevents re-inserting a second `scheduled_calls` row for the same attempt,
double-dialing the same customer and potentially double-issuing a discount code. Both statements are
plain `db.insert`/`db.update` calls with no `db.transaction(async (tx) => {...})` wrapper anywhere in
this file.

Other multi-step sequences with the same shape, lower individual severity: `app/routes.ts`'s
`resolveOrCreateMembership` (org insert + membership insert as two calls — mitigated by a real unique
index + re-select, see §3, but still leaves an orphaned `orgs` row on every genuine race, since the
org insert always uses a freshly-generated UUID that never actually collides between concurrent
requests); `stream.ts`'s call finalization (`calls` update, `callLatency` upsert, `callerMemory`
upsert, workflow trigger — four+ independent writes with no atomicity between them, each individually
best-effort/`.catch()`'d rather than transactional).

**Isolation level**: never set anywhere (`SET TRANSACTION ISOLATION LEVEL`, drizzle's
`isolationLevel` option) — everything runs at Postgres's default `READ COMMITTED`. Not necessarily
wrong (most of this codebase's write patterns don't need stronger isolation given the claim-based
concurrency control described in §3), but it's a default nobody has actually decided on, not a chosen
one.

**Savepoints, MVCC, deadlocks**: no savepoint usage found (consistent with zero transaction usage —
savepoints only make sense inside a transaction). MVCC is Postgres's own default behavior, nothing
app-level to audit. No deadlock-retry logic found anywhere (`grep` for "deadlock" in `packages/api/src`
returns nothing) — given the near-total absence of multi-row-locking transactions, this is low-risk
today, but would need addressing the moment any of the above gets wrapped in real transactions
touching multiple rows in inconsistent orders.

---

## 3. Concurrency — mixed: one genuinely excellent pattern, one real gap, no formal versioning anywhere

**✅ Solid**: `voice/workflows/scheduler.ts`'s `executeDueScheduledCalls()` implements real optimistic
concurrency control correctly — claims a row via `UPDATE scheduled_calls SET status='claimed' WHERE id
= ? AND status = 'pending'` and checks `.returning()` came back non-empty before proceeding (lines
~20-34). This is the exact right pattern (equivalent in effect to `SELECT ... FOR UPDATE SKIP LOCKED`)
and is explicitly commented as being *for* preventing double-dial under concurrent sweeps. If this
API ever runs more than one instance (Railway horizontal scaling, or just two instances briefly
overlapping during a rolling deploy), this specific code path is already safe.

**🔴 Nothing else in the codebase uses this pattern, or any versioning scheme.** No `version`/
`updated_at`-as-CAS column exists anywhere in `schema.ts` — grepped for it directly, zero hits. Every
other write in the codebase (call state updates, workflow run advancement, agent config saves) is a
last-write-wins blind `UPDATE ... WHERE id = ?`, with no optimistic-lock check that the row hasn't
changed since it was read. For most of these (e.g. a merchant editing their own agent config form)
concurrent-write collision is low-probability and low-consequence — but `graph-engine.ts`'s
`updateRunPosition`/workflow-run advancement is exactly the kind of state machine that *should* have
either a real transaction or a claim-style CAS (like the scheduler has) and currently has neither: two
concurrent triggers to advance the same `workflow_runs.id` (plausible if a Twilio status-callback
retry races a legitimate second event — see §4) can interleave their reads/writes with nothing
stopping it.

No pessimistic locking (`SELECT ... FOR UPDATE`) used anywhere either — consistent with §2's "no
transactions" finding, since `FOR UPDATE` only has teeth inside a transaction.

---

## 4. Reliability (Idempotency / Retries / *-once semantics) — the split that matters most in this audit

**✅ Shopify webhooks — done properly, worth calling out as genuinely good work.**
`integrations/shopify/idempotency.ts`'s `alreadyProcessed()`/`markProcessed()` pair, backed by
`shopify_webhook_events`'s real unique index on `(shop, topic, idempotency_key)`
(`schema.ts` line ~346), is textbook-correct at-least-once-to-effectively-exactly-once handling: check
before acting, mark *after* the side effect succeeds (not before — so a crash mid-effect correctly
leaves it retriable), and the unique index is the actual race safety net for two concurrent retries,
not just the check. The code comment explicitly states the contract ("delivery is at-least-once...
every endpoint must be idempotent") — this is a team that understood the problem and solved it
correctly for this one integration.

**🔴 P1 — Twilio's status-callback webhook has no equivalent protection, and Twilio's delivery is
also at-least-once (documented Twilio behavior: retries on non-2xx or timeout).**
`voice/routes.ts`'s `POST /status-callback` (~line 240): the `calls` table update
(`db.update(calls).set({status, endedAt})`) is naturally idempotent (re-applying the same UPDATE is a
no-op), but the **side effects are not** — on a terminal status (`completed`/`failed`/`busy`/
`no-answer`/`canceled`), it dispatches a webhook and, for `no-answer`/`busy`/`failed`, triggers
`resumeWorkflowAfterCall`/`runWorkflowForOutcome`, then deletes the in-memory session. A genuine
concrete failure mode this creates: if Twilio redelivers the same terminal status (session already
deleted from the first delivery), `session` is now `undefined`, so `session?.workflowRunId` is
`undefined` too — the code falls into the `else` branch and calls `runWorkflowForOutcome` a **second**
time, with `previousAttempt: session?.workflowAttempt` now `undefined` instead of whatever it
legitimately was. This isn't just a duplicate no-op — it's a duplicate call with different (reset)
retry-count parameters, meaning a retry workflow can schedule an *extra*, unintended attempt that
looks like a fresh "attempt 1" to the discount-escalation logic in §-adjacent `resolveDiscountPercent`.
No `idempotencyKey`/dedup table exists for Twilio webhooks anywhere, unlike Shopify's.

**`withRetry`** (`database/with-retry.ts`) is a sound, minimal retry-once helper — but its doc comment
still says *"e.g. ECONNRESET to Turso"*, a stale reference to the pre-`ADR-034` SQLite/Turso backend;
this repo has been on Postgres/Supabase for a while now. Harmless (doesn't affect behavior), but it's
exactly the kind of doc-drift this audit series has flagged before, and worth a one-line fix next time
someone's in that file. Checked its actual call sites (`stream.ts` lines 256, 343, 935) — all three
wrap `UPDATE` statements, which are safe to blindly retry (idempotent by nature), so the retry-without-
dedup design is *appropriate* for its current usage, even though the helper itself has no built-in
idempotency guarantee if someone later wraps a plain `INSERT` with it.

**`resilient-fetch.ts`** (reviewed in earlier sessions' tests) — timeout + retry + circuit breaker for
outbound HTTP to CRM/Calendar providers. Good pattern, already covered by existing tests
(`resilient-fetch.test.ts`).

---

## 5. Data Integrity (Constraints / FKs / Cascades / Triggers) — solid, one real bug already found+fixed this week

Foreign keys are used consistently and correctly throughout `schema.ts` — every relational table
references its parent with an explicit `onDelete` policy (`cascade` for owned child data like
`org_phone_numbers` -> `orgs`, `set null` for soft-associations like `org_agent_configs.phone_number_id`
-> `org_phone_numbers`). This is real, working referential integrity, not just documentation —
confirmed live against production this week (the `org_phone_numbers`/`org_agent_configs` FK chain from
this session's C2b work). No orphan-prone relationships found.

**Already found and fixed this week** (not a new finding, cross-referencing for completeness): the
`recovered_amount` column's `text -> numeric` migration had no `USING` clause and the `0010`/`0011`
duplicate-index bug — both covered in the migration-idempotency changelog entry, not repeated in full
here.

**Triggers**: zero Postgres triggers used anywhere — every piece of "when X happens, also do Y" logic
lives in the application layer (e.g. `logToolCall`'s captureField merge, `finalizeCall`'s workflow
dispatch). This is a legitimate architectural choice (keeps business logic in one language/place, out
of the database), not a gap — flagging only so it's clear this was a choice, not an oversight, since
"Triggers" was on the requested checklist.

---

## 6. Performance (Indexes / Query Planning / Caching / Connection Pooling)

**Indexes**: mostly solid coverage on hot query paths (org_id-scoped tables all indexed on `org_id`,
per this week's migration review) — the one real index bug (`0010`/`0011` duplicate) was already found
and fixed this week via the idempotency sweep, not repeated here.

**Query planning / N+1**: checked `org-queries.ts`'s `computeOrgAnalytics` (the most query-heavy code
path in the merchant-facing app) specifically for N+1 patterns — clean. It batch-fetches
`calls`/`callLatency`/`toolCalls`/`turnLatency` each in one query (via `inArray(...)` on the already-
fetched call IDs) and aggregates in-memory afterward, not per-row queries in a loop. No N+1 found here.

**🔴 Caching**: there is no shared/distributed cache anywhere — every "cache" in this codebase
(`tts-cache.ts`'s hybrid audio cache, `session-store.ts`'s default backend, `fixed-window-limiter.ts`'s
rate limiter) is explicitly documented as **in-memory, process-local**, with the same disclosed
tradeoff each time ("fine for a single instance"). This is consistent, honest documentation, not a
hidden gap — but it means none of these actually survive a process restart or work correctly across
more than one instance. Combined with §3's scheduler finding (the one piece of code that *is*
horizontal-scaling-safe), this paints a clear picture: **this codebase is currently single-instance by
necessity, not just by current deployment choice** — several pieces of state (session store, TTS
cache, rate limiter) would silently misbehave (not crash, just quietly stop working as intended) the
moment a second instance runs. Worth a real decision (Redis/Supabase-backed shared cache, or an
explicit "single instance only" operational constraint documented somewhere) before ever scaling out.

**Connection pooling**: `database/index.ts`'s `postgres(process.env.DATABASE_URL!, { prepare: false
})` — no explicit `max` pool size set, meaning it runs on `postgres.js`'s library default (10). Not
necessarily wrong for current traffic, but it's an unexamined default, not a chosen number — worth
sizing deliberately against Supabase's actual connection limit for this project's plan tier
(shared-pooler-mode connection limits are a common gotcha with Supabase specifically, and this
codebase's `?sslmode`/pooler-port choice wasn't verified this round — flagging as unverified, not
confirmed either way).

---

## 7. Distributed Systems (Replication / Sharding / Consensus / Leader Election)

No sharding anywhere (single Postgres instance, single schema) — appropriate at current scale, nothing
to fix. No consensus protocol needed or used (single writer). **Leader election**: covered in §3 —
the scheduler's claim-based CAS is the *de facto* leader-election-free-alternative for that one job,
and it's correctly designed. Nothing else in the codebase runs a periodic/background job that would
need the same protection today (checked for other `setInterval`/cron-like patterns — the scheduler is
the only one).

**Replication / replication lag**: entirely delegated to Supabase's managed Postgres — nothing in this
codebase reads from a replica or has any read/write-splitting logic, so there's no app-level
replication-lag handling to audit (there's nothing to be stale relative to, since every read and write
goes to the same primary). Worth noting only because "replication lag" was on the requested checklist
— it's a non-issue *because* the architecture is simple, not because it was solved.

---

## 8. Event Systems (Event Sourcing / CQRS / Outbox / Sagas)

**Sagas — yes, and reasonably well done.** `voice/workflows/graph-engine.ts` is structurally a saga:
a long-running, multi-step process (trigger -> wait -> call -> conditional split -> ...) that persists
its own position (`workflow_runs.current_node_id`/`status`/`next_run_at`) and resumes across
process restarts and real-world delays (a wait node can span days). This is the right shape for the
problem. Its main gap is exactly §2's finding — the steps within a single node's execution aren't
transactional, which is the standard saga-implementation risk (compensating actions/idempotent steps
are supposed to cover for this; here, neither exists for the `"call"` node specifically).

**CQRS**: not used, and not obviously needed — reads and writes both go through the same `db`/schema
model everywhere, no separate read model. Not a gap, just doesn't apply here.

**🔴 Outbox pattern — missing, and this is the most textbook "missing outbox" gap in the whole
audit.** `voice/webhooks.ts`'s `dispatchWebhook()` (~line 25) is a bare `fetch()` in a `try/catch` that
logs and gives up on failure — no persistence of the event before attempting delivery, no retry, no
dead-letter queue, no way for a merchant to know they missed a `call.completed`/`call.transcript`/
`call.tool_call` event because their receiving endpoint happened to be down or slow for a few seconds.
Every one of these events is genuinely lost forever the moment the single `fetch()` attempt fails.
This is the standard motivating case for an outbox table (`webhook_outbox` or similar: write the event
transactionally alongside the state change that caused it, then a separate delivery worker retries
until acknowledged) — nothing like that exists today.

---

## 9. Security (RLS / RBAC / Encryption / Auditing)

**RLS**: Supabase-side migrations (`supabase/migrations/*.sql`, several files) do enable RLS on tables
they create, with policies scoped to `service_role`/`authenticated` and their own comments explicitly
stating the real model: *"Service role bypasses RLS, so backend CRUD works. Policies exist as
defense-in-depth."* This is a deliberate, reasonably-understood design (RLS is a backstop against a
hypothetical anon-key leak, not the primary access-control boundary — that's application-layer
org-scoping via `orgId` checks in every route) — confirmed this is stated intent, not an accidental
gap, by reading the migration comments directly rather than assuming.

**RBAC**: `platform_admins` (email allowlist + role) and `admin_keys` (hashed API keys) both exist and
are used to gate the admin surface — real, not a stub.

**🔴 P1 — Encryption at rest for stored provider credentials: none.** `orgs.twilioAuthToken` (and by
extension the Plivo/Exotel equivalent columns seen elsewhere in `schema.ts`) are plain `text` columns
— confirmed via direct schema read, zero `encrypt`/`crypto.createCipher`/`AES` usage found anywhere in
`packages/api/src`. Live Twilio (and Plivo/Exotel, for BYO orgs) credentials sit in cleartext in the
database. Given the very same session that found this also found a completely separate, real
production DB-access path this week (the migration outage required giving direct `DATABASE_URL`
access to fix it) — this isn't a hypothetical: anyone with read access to this database, a leaked
backup, or a future SQL-injection-adjacent bug gets live telephony credentials for every BYO org,
in the clear, with no additional barrier. This is the single highest-severity finding in this whole
audit and the one most worth prioritizing a real fix for (application-level encryption with a
KMS-managed key, or at minimum moving these into a secrets manager rather than a plain DB column).

**Auditing**: `admin_audit_log` + `logAdminAction()` exist and are called from the write routes
actually spot-checked this round (`twilio/reset`, `flags/:id` DELETE) — both correctly log. Did **not**
exhaustively verify every admin write route calls it (a crude route-vs-call-count comparison suggested
a possible gap but wasn't reliable enough to name specific routes with confidence) — flagging as
worth a dedicated, careful pass rather than claiming a specific number of uncovered routes.

---

## 10. Recovery (WAL / PITR / Backups / Replication Lag)

Entirely delegated to Supabase's managed Postgres — WAL, point-in-time recovery, and backup cadence
are all infrastructure-level, not application code, and weren't (and can't meaningfully be) audited
from source alone. The one recovery-adjacent thing this audit *did* validate concretely this week: a
genuine disaster-recovery scenario (migration tracking wiped, full replay against an already-migrated
database) now works correctly end-to-end, which it did not before this week's fixes — see the
migration-idempotency changelog entry. Nothing else recovery-related was in scope for a source-level
review.

---

## Summary — ranked by severity

1. 🔴 **P0 — Encryption at rest**: Twilio/Plivo/Exotel credentials stored in cleartext (§9).
2. 🔴 **P1 — No database transactions anywhere**: `graph-engine.ts`'s call-node scheduling is the
   concrete double-dial/double-discount risk; the pattern is systemic, not isolated (§2).
3. 🔴 **P1 — Twilio status-callback has no idempotency guard**, unlike Shopify's — a redelivered
   terminal status can double-fire a workflow outcome with reset retry-count state (§4).
4. 🔴 **P1 — Missing outbox pattern for merchant webhooks** — `call.completed`/etc. events are lost
   forever on any single delivery failure, no retry, no visibility (§8).
5. 🟡 **P2 — No optimistic locking/versioning anywhere except the scheduler's claim pattern** —
   `workflow_runs` advancement in particular has no equivalent protection (§3).
6. 🟡 **P2 — No shared cache/session-store** — several in-memory-only components would silently
   misbehave (not crash) the moment a second instance runs (§6).
7. 🟢 **Solid, worth preserving**: Shopify webhook idempotency (§4), the scheduler's claim-based
   concurrency control (§3), FK/cascade integrity (§5), no N+1 in analytics (§6).

## What I did NOT audit this round (honest scope)

- No live load-testing or actual concurrent-write reproduction against a real database — the
  transaction/concurrency findings are from reading the code paths, not from triggering the race
  conditions live (unlike the migration-idempotency work earlier this week, which *was* validated
  against a real disposable Postgres end-to-end).
- Did not exhaustively verify audit-log coverage across every admin write route (§9) — flagged as an
  open item, not a confirmed count.
- Did not verify Supabase's actual connection-pooler mode/limits against this app's pool settings (§6)
  — flagged as unverified.
- Did not review encryption/security posture of any other secret (Supabase service-role key, admin API
  keys' storage — `admin_keys` does appear to store a hash, not plaintext, per its own naming and
  `hashAdminKey` tests, but wasn't re-verified line-by-line this round) beyond the specific Twilio/
  Plivo/Exotel credential columns called out in §9.
- Recovery/WAL/PITR (§10) is infrastructure, not code — explicitly out of what a source audit can
  cover.

*Next audit in this series should: (1) confirm whether the encryption-at-rest finding gets addressed
or explicitly risk-accepted, (2) check whether graph-engine.ts's call-node sequence gets wrapped in a
real transaction or a claim-style guard, (3) verify Twilio status-callback idempotency was added,
(4) re-check the outbox-pattern gap, (5) do the exhaustive admin-audit-log route-by-route pass this
round didn't have budget for.*
