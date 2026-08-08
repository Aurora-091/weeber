# ADR-079: A surface that can spend must be able to refund, and "reset" must not strand what it paid for

- **Date:** 2026-08-08
- **Status:** Accepted
- **Supersedes / relates to:** ADR-042 (per-org Twilio isolation), ADR-073 (a repair path with no caller is not a repair path), ADR-077 (a 201 is not proof the resource is configured)

## Context

Undoing the 2026-08-08 Twilio provisioning experiment required hand-written SQL against
production (`/home/user/openvent-prod-cleanup-2026-08-08.sql`). That was treated as a one-off
inconvenience. It was a symptom of two structural defects in the telephony surface, and the
investigation also corrected a wrong claim made while triaging it.

### Correction first: `closeOrgTelephony` is not dead code

The initial triage recorded `closeOrgTelephony` as having zero callers — the same shape ADR-073
found in `syncNumberWebhooksForOrg`. **That was wrong.** It has three live callers:

- `app/routes.ts` — `POST /api/app/org/close`, owner-only, user-initiated permanent close.
- `voice/workflows/org-lifecycle-sweep.ts:49` — the 30-day inactivity suspend.
- `voice/workflows/org-lifecycle-sweep.ts:67` — the 60-day permanent close.

And `runOrgLifecycleSweep` is itself invoked from `voice/workflows/scheduler.ts:330`. The whole
chain is wired. Recorded here explicitly because the false claim was written down first, and a
wrong "this is dead" note is how live code gets deleted later.

### Defect 1 — the admin surface could spend but not release

`POST /api/voice/orgs/:orgId/twilio/number` (`voice/admin-routes.ts`) buys a number. That is a
recurring monthly rental, and it is audit-logged as `twilio.number.purchased`. There was **no
admin release route.** Release existed only at `POST /api/app/numbers/:id/release`, which is
merchant-session scoped — an operator does not hold a session for someone else's workspace, and
should not need one to undo their own action.

The comment sitting directly above `GET /orgs/:orgId/numbers` asserted this was deliberate:

> C2b — read-only mirror of GET /api/app/numbers for admin oversight. Buying/releasing numbers
> stays a merchant-side action in the app panel; admins can see what's assigned but don't manage
> it here.

That was already untrue when it was written: the purchase route is seventy lines above it, in the
same file. So the stated design held on the *release* half only. An asymmetry that permits
spending and forbids refunding is the wrong way round — if only one of the two belongs on the
admin surface, it is not the one that costs money every month.

### Defect 2 — `resetToPlatformDefault` stranded paid numbers with no recovery path

Worse, because it is reachable by any merchant, not just an operator.

`resetToPlatformDefault` nulls `orgs.twilioAccountSid` and `orgs.twilioAuthToken` and purges every
telephony vault entry, while leaving `org_phone_numbers` rows at `status = "active"`.
`releaseNumberForOrg` resolves its Twilio client from exactly those credentials. So after a reset:

- the number is still rented, still billing monthly;
- our DB still claims it is active;
- **no route in the system can release it** — merchant or admin — because the credentials needed
  to reach the sub-account were just deleted;
- `syncNumberWebhooksForOrg` cannot see or repair it either, for the same reason.

Recovery means recovering the sub-account SID from the admin audit log (`twilio.subaccount.created`)
or the Twilio console, then hand-writing SQL. Which is what happened.

The function's own docstring justified the behaviour:

> Does not delete anything on the provider's own side (e.g. the underlying Twilio sub-account or
> number), just stops using them; that's a deliberate manual action on the provider's own console,
> not something to do silently from here.

That reasoning is sound for **BYO**, where the customer owns the Twilio account and can log into
its console. It is false for **platform mode**, and the codebase already documents why —
`inboundVoiceWebhooks`' docstring relies on the same fact:

> their number lives in a sub-account under Weeber's parent account, so they have no console login
> for it

So the escape hatch the docstring pointed at is structurally unavailable for precisely the case
that costs money. Two docstrings in one file, each correct in isolation, contradicting each other.

Entry point is `POST /api/app/telephony/reset`, which has **no owner-only check** — unlike
`/org/close`, which does. Any member could reach it.

## Decision

### 1. Give the admin surface the inverse of its purchase route

`POST /api/voice/orgs/:orgId/twilio/numbers/:id/release`, next to the purchase and sync-webhooks
routes.

- **Admin-key gated**, like every route in that file.
- **400** on a non-integer `:id`, before touching Twilio.
- **400** with `releaseNumberForOrg`'s own error text on failure — never a success shape.
- Org-scoping is **not** re-implemented in the route. `releaseNumberForOrg` already requires the row
  to match on both `id` AND `orgId`, so a mistyped `:orgId` returns "Number not found for this org"
  instead of releasing another workspace's number. One enforcement point, already tested.
- **Audit-logs `twilio.number.released` with the phone number, not the row id.** `ReleaseNumberResult`
  was widened to `{ ok: true; phoneNumber }` to make that possible. A release is destructive,
  billable and irreversible; "which number did we give up" is the only useful form of that record
  months later, and it makes the trail symmetric with `twilio.number.purchased`.
- No audit entry on failure — mirrors ADR-073's rule that the trail must not claim actions that
  never happened.

### 2. `resetToPlatformDefault` refuses rather than orphans

It now returns `ResetTelephonyResult` instead of `void`. When the org is **not** BYO and holds any
`org_phone_numbers` row at `status = "active"`, it returns `{ ok: false, error }` naming those
numbers, and **writes nothing** — no org update, no vault deletion. Both callers surface it as
**409** (`voice/admin-routes.ts`, `app/routes.ts`): the request is well-formed, the workspace is
just in a state where resetting would strand billable resources.

Three sub-decisions worth pinning:

- **Refuse, do not auto-release.** Auto-releasing would make a button labelled "revert to platform
  default" silently destroy paid, dialable numbers. A release is irreversible — Twilio will not give
  the same number back — and the number may already be printed, advertised or forwarded. This
  matches the stance `getSubClientEnsuring` already documents: provisioning a sub-account is
  implicit because it is free, but "the *number* is the chargeable step, and that stays an explicit
  user action." Releasing is the same step in reverse.
- **Anything not explicitly `"byo"` is treated as platform-owned.** An unknown org or a null mode
  falls into the guarded branch. Guessing "BYO" is the expensive way to be wrong: it clears the
  credentials for numbers we are the ones paying for.
- **BYO passes through unchanged.** The customer owns that account and console, so the original
  docstring reasoning genuinely applies.

### 3. The refusal has to be readable in the UI

`pages/app/integrations.tsx`'s reset mutation threw a hardcoded `"Failed to reset telephony
settings"` and discarded the response body — the one mutation in that file not following its own
`data.error ?? fallback` pattern. A guard whose explanation is swallowed on the way to the toast is
a dead end, which is the failure ADR-073 was written about. It now surfaces the server's message, so
the merchant is told which numbers to release.

## Consequences

- Ten new tests, both files proven to fail without the fix:
  - `voice/admin-twilio-number-release.test.ts` (5) — pins the caller: admin-gated, forwards both
    path params, rejects a non-integer id before reaching Twilio, surfaces the provider error, and
    audit-logs the number rather than the id. Without the route: 4 of 5 fail with 404.
  - `voice/twilio-reset-orphan-guard.test.ts` (5) — pins the guard: refusal names the blocking
    numbers, **writes nothing at all** when it refuses, resets normally with no active numbers,
    still lets BYO through, treats an unknown org as platform-owned. Without the guard: 5 of 5 fail.
- The "writes nothing at all" assertion is the load-bearing one. A guard that refuses *after*
  clearing the credentials would produce exactly the unrecoverable state this ADR exists to remove.
- `resetToPlatformDefault` is now a checked call. Any future caller that ignores the result
  reintroduces the silent version of this bug; the `void`-returning signature no longer allows it
  to be ignored accidentally.
- A merchant holding numbers can no longer switch telephony providers in one click. That is the
  intended trade: the previous one-click path left them renting an unreachable number.
- **Not addressed here:** `POST /api/app/telephony/reset` still has no owner-only check, unlike
  `/org/close`. The guard removes the expensive consequence, not the permission gap. Tracked
  separately.
- The test mock in `admin-twilio-sync-webhooks.test.ts` gained a `releaseNumberForOrg` entry.
  `mock.module` replaces the whole module, so every export `admin-routes` imports must be present
  or the file fails to load — the same trap ADR-078 hit with a relative-path mock.
