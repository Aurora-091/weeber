# Review: reliability fixes shipped in `432c940` ("Added ...create_twilio_status_events.sql")

Reviewing the change set that landed directly on `main` today, since it's substantial and touches
exactly the P0/P1 findings from `audit/2026-07-15-audit-06-db-systems.md`. Good news first: this is
real, well-targeted engineering that closes four of that audit's top findings. Then the issues found
while verifying it — one regression I already fixed, one open production-safety question I can't
resolve from source alone, one design tradeoff worth a second look, and a testing gap.

---

## What shipped, and how it maps to the audit

| Audit #06 finding | What shipped | Assessment |
|---|---|---|
| P0 — Twilio/Plivo/Exotel credentials stored in cleartext | Supabase Vault-backed encryption (`credential-vault.ts` + `setup_credential_vault.sql`'s `store_org_credential`/`read_org_credential`/`delete_org_credentials` functions, pgsodium-backed). Every provisioning path (`twilio-provisioning.ts`, `plivo-provisioning.ts`, `exotel-provisioning.ts`) now writes to the vault *in addition to* the existing plaintext columns; every read path (`twilio-client.ts`, presumably the Plivo/Exotel equivalents) reads vault-first, falls back to plaintext. | **Real fix, correctly designed** — SECURITY DEFINER functions, revoked from anon/authenticated, only service_role can call them. Two things not yet done (see below): no backfill for orgs provisioned *before* this shipped, and the plaintext columns are explicitly still there ("Follow-up migration NULLs plaintext after full migration" — not done yet, which is fine as an intentional phase 2). |
| P1 — no DB transactions anywhere; the `call`-node scheduling race specifically | `graph-engine.ts`'s `"call"` node now wraps its `scheduledCalls` insert + `workflowRuns` update in a real `db.transaction(async (tx) => {...})` — exactly the fix the audit called for. `app/routes.ts`'s org-bootstrap (`resolveOrCreateMembership`) got the same treatment, wrapping its `orgs` + `orgMembers` inserts in a transaction too (a lower-severity item the audit also flagged). | **Real fix, correctly targeted** — the exact race condition described in the audit is closed. |
| P1 — Twilio status-callback has no idempotency guard, unlike Shopify's | New `twilio_status_events` table (unique index on `(call_sid, status)`), `voice/routes.ts`'s `/status-callback` now inserts into it before running side effects and returns `200` immediately on a unique-constraint violation (duplicate delivery). | **Real fix, one design concern** — see §2 below; the ordering (mark-before-acting, not mark-after like Shopify's existing pattern) reintroduces a different, smaller failure mode. |
| P1 — missing outbox pattern for merchant webhooks | New `webhook_outbox` table + `webhooks.ts`'s `processWebhookOutbox()` — a real outbox: durably enqueue on `dispatchWebhook()`, a periodic delivery worker (wired into `server.ts` via `setInterval`, 8s) claims rows with the *same CAS pattern the scheduler already uses* (`UPDATE ... WHERE status IN ('pending','failed')`), exponential backoff (30s/2m/10m/1h/6h), dead-letters after `max_attempts`. | **Real fix, well designed** — correctly reused the scheduler's existing claim pattern instead of inventing a new concurrency mechanism, which is exactly the kind of consistency this audit series has been asking for. |
| P2 — no optimistic locking outside the scheduler; `workflow_runs` specifically named | New `version` column on `workflow_runs`, and every write site in `graph-engine.ts` (`advanceWorkflow`'s wait/call branches, `resumeWorkflowAfterCall`, `executeDueWorkflowRuns`) now does `UPDATE ... SET version = version + 1 WHERE id = ? AND version = ?`, checks `.returning()` length, logs and bails on a version conflict instead of proceeding on stale state. | **Real fix, correctly extends the scheduler's own pattern** — this is precisely "extend the one thing that's already good to the thing that wasn't," which is what the audit recommended. |

This is, genuinely, four-for-four on the audit's top findings, each fixed with the *right* pattern
(reusing the scheduler's CAS approach rather than inventing something new, using Supabase's actual
managed encryption primitive rather than hand-rolling crypto) rather than a quick patch. Worth saying
plainly: this is good work.

---

## 1. 🔴 Fixed during this review — the change set broke 5 existing tests, and hadn't been run before pushing

Ran the full suite before writing this doc (habit, not optional) and found **5 failing tests**, all
with the same two root causes — this change set's own test mocks were never updated for the new
`db.execute()` (vault reads) and `db.transaction()` (the new atomicity fixes) calls:

- `voice/routes.test.ts` (2 tests) and `voice/workflows/scheduler.test.ts` (2 tests): both mock
  `../database`'s `db` with only `select`/`update`, no `execute` — `getTwilioClientForOrg` now calls
  `readCredential()` -> `db.execute(...)` on every single outbound-call path, so every test exercising
  that path threw `db.execute is not a function` before even reaching its actual assertion.
- `app/routes.test.ts` (1 test, the org-bootstrap-on-first-login one): its `db` mock had no
  `transaction` method — `resolveOrCreateMembership`'s new transaction wrapper threw
  `db.transaction is not a function`.

**Fixed** (mechanical, not a design change — added `execute: async () => []` to the two mocks missing
it, and a `transaction: async (fn) => fn(dbLike)` passthrough to the one missing that): all 289 tests
pass again, typecheck clean, oxlint clean, `drizzle-kit generate` reports zero drift (after §3's fix).
**Not yet committed** — holding until you confirm the plan for §3's open question below, so everything
goes in one clean, verified push rather than two.

**The actual point of this finding isn't the mocks — it's that this shipped without anyone running
`bun run test` first.** Every other commit this week (including your own outbox/vault/versioning work
being reviewed here) has gone through full verification before landing on `main`. This one didn't, and
it happened to be exactly the kind of change (new `db` methods used in code paths several existing
tests exercise) that a test run would have caught immediately. Not a huge deal this time since it was
caught here — flagging so it doesn't become a pattern.

---

## 2. 🟡 Design tradeoff worth reconsidering: Twilio idempotency marks *before* the side effect, not after

`voice/routes.ts`'s new idempotency guard inserts into `twilio_status_events` **before** the workflow-
advancement/webhook-dispatch side effects run, then proceeds unconditionally (no transaction wrapping
the insert + the side effects together). Contrast with the *existing*, already-audited-as-good Shopify
pattern (`integrations/shopify/idempotency.ts`), whose own doc comment is explicit about why order
matters: *"Call this after the side effect succeeds, not before — if the process crashes mid-side-
effect, we want the retry to still see 'not processed' and try again, not silently skip it forever."*

Concretely: if the `db.update(calls)` call or the workflow-dispatch logic that runs *after* the
`twilio_status_events` insert throws (a transient DB blip, a bug, anything), the dedup row is already
committed — a legitimate Twilio retry of that same terminal status will now be silently swallowed as
"already processed," and the workflow that should have fired never will. This trades the original bug
(double-processing on redelivery) for a different, arguably worse one (silent permanent skip on
partial failure) in the unhappy-path case specifically — the happy path (side effects succeed) is
fully correct either way.

**Not fixed here** — this is a real design decision (mark-before is simpler code; mark-after needs
either a transaction wrapping the insert + all the side effects, or a "mark at the very end, after
everything succeeded" restructure) rather than a one-line change, and it's a legitimate question
whether "occasionally skip a redelivered terminal-status side effect on the rare mid-processing crash"
is an acceptable tradeoff for the simplicity gained — flagging for a decision, not deciding it here,
same as this audit series' standing rule.

---

## 3. 🔴 Open question I cannot resolve from source alone — has this actually been applied to production?

Same landmine as yesterday's `org_integrations` table, found again: all four of today's schema changes
(`twilio_status_events`, `webhook_outbox`, `workflow_runs.version`, plus the vault's SQL functions) were
written as hand-authored files under `supabase/migrations/`, with **no corresponding file under
`packages/api/drizzle/`** — the migration system this API's own `db:migrate` (now run automatically on
every Railway deploy, per yesterday's fix) actually reads from.

I reconciled this the same way as yesterday — generated the missing drizzle migration, added
`IF NOT EXISTS` guards, renamed it to `0026_add_outbox_and_run_versioning.sql`, confirmed
`drizzle-kit generate` now reports zero drift. **This part is done and safe to commit regardless of
the answer below.**

**What I can't verify without production access**: whether `supabase/migrations/20260715133208_...`
through `...134118_...` were actually run against the live Supabase project (via `supabase db push` or
the dashboard) — that's a separate action from committing the SQL files to this repo, and nothing in
git history proves it happened. Two very different situations depending on the answer:

- **If they were applied**: my reconciled drizzle migration is a pure no-op there (every statement is
  `IF NOT EXISTS`/`IF EXISTS`-guarded) — same safe outcome as yesterday's `org_integrations`
  reconciliation. Nothing else to do.
- **If they were *not* applied yet**: production doesn't have `twilio_status_events`/`webhook_outbox`/
  `workflow_runs.version` at all right now, and the API code in this same commit (`routes.ts`,
  `webhooks.ts`, `graph-engine.ts`) already queries/writes to them unconditionally. Every Twilio
  status-callback and every workflow-run advancement would be throwing `relation does not exist`
  errors in production **right now**, live, since the moment this commit deployed — the exact same
  class of outage as yesterday's, just on new tables instead of missing columns.

I don't have the production `DATABASE_URL` in this session anymore (cleaned up after yesterday's fix,
per your usual practice) — need it again to check which of the two states we're actually in, and to
run my reconciled migration for real if the answer is "not applied yet."

---

## 4. 🟡 Minor, lower-priority items (not blocking, worth a note)

- **No test coverage for any of the new logic** — `processWebhookOutbox`/`markFailed`'s backoff math,
  the `twilio_status_events` dedup path, and `credential-vault.ts` itself all shipped with zero new
  tests. The existing suite still passes (once the mocks were fixed), but nothing *new* actually
  exercises this code's own correctness (e.g., nothing asserts the backoff sequence is right, or that
  a dead-lettered event actually stops retrying). Worth a follow-up pass.
- **No backfill for orgs provisioned before this shipped** — `storeCredential` only gets called from
  the provisioning *write* paths (create sub-account, set BYO creds). Any org that was already live
  before today has nothing in the vault yet and will keep silently using the plaintext-fallback path
  (which still works — not broken — but isn't actually benefiting from the new encryption until that
  org's credentials get rotated/re-provisioned for some other reason). A one-time backfill script
  (`readCredential` returns null -> read the plaintext column -> `storeCredential` it) would close this
  gap for existing orgs without waiting on a natural rotation.
- **`readCredentials()` (plural) does N sequential round-trips**, one per field, rather than one batch
  query — noted in passing, not urgent at current scale (2-3 fields per org, called rarely).
- **Doc-comment quality regression in `twilio-client.ts`** — several genuinely useful explanatory
  comments (why the lookup is cache-free, why every call-placing site needs to resolve through
  `getTwilioClientForOrg` instead of importing `twilioClient` directly, why signature validation needs
  the *token* specifically) were deleted and replaced with much thinner ones during this edit. Doesn't
  affect behavior, but it's exactly the kind of doc-drift this audit series has flagged before in other
  files — worth restoring the context next time someone's in that file, not urgent on its own.

---

## Summary

Real, well-designed fixes for 4 of audit #06's top findings (encryption at rest, the call-node
atomicity race, Twilio idempotency, the missing outbox, and workflow-run optimistic locking) — genuine
progress, not a token gesture. Found and already fixed one concrete regression (5 broken tests from
un-mocked new `db` methods) as part of this review. One design tradeoff flagged for a decision (mark-
before vs. mark-after idempotency), one real open question that needs production access to resolve
(whether the Supabase-path migrations actually ran, given the exact same parallel-migration-system gap
as yesterday), and a handful of minor/lower-priority notes.

**Recommend before pushing**: confirm production migration status (§3) — if unapplied, this is
currently a live, ongoing outage risk, higher priority than anything else in this doc.
