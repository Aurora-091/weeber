# ADR-112 — A number the table does not know about cannot be configured

- **Date:** 2026-08-13
- **Status:** Accepted (implemented 2026-08-13; migration generated, **not applied**)

## Context

The numbers architecture is already built: `buyNumberForOrg` rents a number into the org's Twilio
sub-account, the Numbers page renders the org's numbers and lets the merchant declare a
`numberSeries` on each, `org_agent_configs.phone_number_id` is an FK giving per-agent caller ID,
`assignAgentNumber` validates that the number belongs to the org, `syncNumberWebhooksForOrg`
repairs webhooks, and `resolveOutboundRouting` walks four steps: per-agent → per-org → legacy
`orgs.outbound_number` → `TWILIO_PHONE_NUMBER`. Onboarding's `PhoneNumberStep` offers **both**
bring-your-own and auto-provision. None of that needed building.

What was missing is smaller and worse: **only the purchase path writes a row.**
`buyNumberForOrg` inserts into `org_phone_numbers`; all three BYO paths —
`setByoCredentials` (Twilio), `setPlivoByoCredentials`, `setExotelByoCredentials` — write
`orgs.outbound_number` and nothing else. So a BYO org has a working caller ID and no row
representing it, and every feature that reads the **table** rather than the legacy column is dead
for exactly those orgs:

1. **The Numbers page is empty, so `numberSeries` cannot be set.** That column is where a TRAI/DLT
   series is declared, which makes `checkIndiaNumberSeriesCompliance` unsatisfiable for a BYO
   Shopify org and the insurance 1600-series gate unsatisfiable *by construction*. A compliance
   gate an honest org has no way to pass is not enforcement, it is a wall — and ADR-108 was written
   about exactly this refusal arriving in front of a prospect.
2. **Per-agent numbers could not be expressed at all.** `phone_number_id` is an FK into this table,
   so steps 1 and 2 of `resolveOutboundRouting` both missed and every BYO call fell through to the
   legacy column. Per-agent routing was silently dead for the orgs most likely to want it.
3. **BYO numbers were outside the webhook repair path**, `syncNumberWebhooksForOrg` iterating the
   same table — the same invisibility that left the legacy platform number with a dead webhook
   nothing could fix.

Second problem, found while fixing the first: the table **could not express where a number came
from**. `org_phone_numbers` has `provider` (which vendor) and `status` (active/released), and
nothing saying whether the platform is paying for it. That absence is why there was no safe
cleanup rule: a stale active BYO row from a previous setup should be superseded, and a purchased
row must never be, and the two were indistinguishable.

Context for both: all platform-rented Twilio numbers were **released** on 2026-08-13 at the
founder's instruction — the parent account and both live sub-accounts now hold zero numbers, and
every org is expected to bring its own or buy one. That makes the BYO path the **default** path,
not the exotic one, which is what promoted this from a known gap to work worth doing.

## Decision

**1. `org_phone_numbers.source` — `text` with a TS-level enum of `purchased` | `byo`, nullable,
no default.** Migration `0049_daffy_beyonder.sql` is a single `ADD COLUMN`, additive-only per the
standing invariant. Deliberately **no backfill**: rows predating the column have unknown
provenance, and labelling them `purchased` or `byo` from a guess would make a fabricated fact look
authoritative — ADR-110's reason for rejecting `orgs.market`, and ADR-098's precedent that an
absent fact is not a negative fact.

**2. `registerByoNumber(orgId, provider, phoneNumber)` — one shared helper, not three copies.**
The reason those three functions drifted from `buyNumberForOrg` in the first place is that each
owns its own persistence block; a fourth provider would drift the same way. It upserts an active
row and returns its id.

**3. Idempotent via an explicit read, not `onConflictDoNothing`.** `org_phone_numbers` has no
unique constraint on `(org_id, phone_number)`, and adding one would require reconciling whatever
duplicates already exist — a data migration this change is not willing to hide inside itself. So
the guard is a `select` on the pair, and an existing row is **re-activated** rather than shadowed
by a second insert (a released BYO number the org re-connects is the same number; two rows would
show it twice on the Numbers page).

**4. The supersede rule is a pure exported function, `supersededByoNumberIds(activeRows, keepId)`,
and only touches `source = 'byo'`.** BYO is single-number by construction — `orgs.outbound_number`
is one column and every BYO form takes one number — so a second active BYO row can only be stale,
and leaving it active feeds `resolveOutboundRouting`'s org-level branch a number the org has moved
off. A `purchased` row is billed monthly and still dialable. A `null` row's provenance is unknown,
and **unknown is treated as untouchable**: the cost of leaving a stale row active is one confusing
entry on a page, the cost of releasing a live paid number is a broken caller ID nobody asked us to
change. `releaseNumberForOrg` remains the only path that gives a rented number back, and it stays
an explicit user action.

Extracting the rule costs one extra `select` — the org's active rows are read back and filtered in
TypeScript instead of the rule living in a `where` predicate. That is the point: **no `db` mock in
this package evaluates predicates** (the one in `twilio-subaccount-idempotency.test.ts` ignores
`where` entirely), so a test asserting "supersession spares purchased numbers" through a mocked
predicate asserts nothing. The one property here whose failure costs a customer a working caller
ID is now asserted directly, table-driven, and proven non-vacuous: dropping the `source === "byo"`
filter fails 5 of 12 tests, and stubbing the id list to empty fails 1.

**5. `resolveOutboundRouting`'s org-level branch is now `orderBy(asc(orgPhoneNumbers.id))`.** It
was an unordered `limit(1)` over "the org's active numbers" — Postgres was free to return any of
them, so an org with two active rows had a **nondeterministic caller ID**. Oldest-first, not
newest-first, because the answer must not change when a number is added.

## Rejected

- **A unique constraint on `(org_id, phone_number)`.** Correct shape, wrong change to bundle: it
  needs a reconciliation of existing duplicates, and a migration that can fail on production data
  does not belong inside a feature commit.
- **Backfilling `source`.** See above — a guess that looks like a record.
- **Superseding by `where` predicate.** Fewer queries, and the safety rule would then be untested
  in practice.
- **Writing the BYO row from the route handlers instead of the provisioning functions.** Puts the
  invariant one layer away from the thing it protects, and there are three routes, so it is the
  three-copies problem again with extra steps.
- **Deleting the legacy `orgs.outbound_number` read (step 3).** Every existing org's caller ID
  lives there and nothing has been migrated. It is superseded, not removed.

## Consequences

- api tests **1,324 → 1,336** (12 new in `register-byo-number.test.ts`). Four existing db mocks
  (`place-outbound-call.test.ts`, `routes.test.ts`, `workflows/scheduler.test.ts`) needed
  `.orderBy()` added to stay chainable — a mock that stops one step short of the real builder
  fails production code for the mock's shape, not for a defect.
- The migration is **generated and not applied anywhere**. Until it runs, `registerByoNumber`
  writing `source` would fail against the real DB, so this must be applied before the next BYO
  setup — flagged, not done, per the standing rule about prod writes.

## Known and unfixed

- **`TWILIO_PHONE_NUMBER` on Railway now names a released number.** Step 4 of
  `resolveOutboundRouting` will attempt to dial from a number the platform does not own. Left
  untouched deliberately: all Railway work is paused at the founder's instruction. Any org with no
  number of its own falls through to it.
- Existing rows keep `source = NULL` forever unless something authoritative labels them, so the
  supersede rule is a no-op for them — safe, and permanently conservative.
- Nothing yet prevents an org from registering a BYO number that another org has already claimed;
  the number is the customer's property and the credentials were validated against the provider,
  but the table has no cross-org uniqueness at all.
- `numberSeries` is now *settable* by a BYO org. Whether the series it declares is real is still
  unverified by anything — the gate checks that a number of the right series exists in the table,
  not that the org actually holds it.
