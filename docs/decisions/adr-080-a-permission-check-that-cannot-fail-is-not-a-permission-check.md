# ADR-080: A permission check that cannot fail is not a permission check — the role model is a placeholder, and the unique index is the gate

- **Date:** 2026-08-09
- **Status:** Accepted
- **Supersedes / relates to:** ADR-079 (a surface that can spend must be able to refund) — this ADR resolves the open item ADR-079 left in its Consequences

## Context

ADR-079 shipped a guard on `resetToPlatformDefault` and, in its Consequences, recorded one thing
it had **not** addressed:

> `POST /api/app/telephony/reset` still has no owner-only check, unlike `/org/close`. The guard
> removes the expensive consequence, not the permission gap.

That read as a straightforward follow-up: copy the three lines from `/org/close` onto
`/telephony/reset` and close the gap. Doing the work first, rather than the line first, showed
there is no gap to close — and that the check being copied is itself inert.

### There is exactly one role, enforced by the schema

Four independent facts, each verified:

1. **`org_members` is unique on the user alone.** `schema.ts` declares
   `uniqueIndex("org_members_user_idx").on(table.supabaseUserId)` — not a composite
   `(user, org)`. One membership row per user, database-enforced. A multi-member org is not
   "unimplemented", it is *unrepresentable*.
2. **The only insert site hardcodes the role.** `rg "insert\(orgMembers\)"` returns exactly one
   hit — `resolveOrCreateMembership` in `app/routes.ts`, writing `role: "owner"`. The column
   default is also `"owner"`.
3. **There is no invite path.** No route, service, or job creates a membership for anyone but
   the authenticating user on their own first login. `invite` appears in the API package only
   inside `app/email-templates.ts`.
4. **Production agrees.** `select role, count(*) from org_members group by role` → `owner | 4`.
   Four orgs, four members, one role.

And by the time any route body runs, membership is guaranteed non-null: `requireUserOrg` returns
403 `no_org` first. So `c.get("userRole")` inside a handler is never `null` and never anything
but `"owner"`.

### Which makes two existing checks unreachable, and a third comment false

- `app/routes.ts` `POST /org/close` — `if (c.get("userRole") !== "owner") return 403`. Cannot
  fire. The 403 branch is dead.
- `packages/web` `settings.tsx:74` — `const isOwner = (me.role ?? "owner") === "owner"`, gating
  the danger zone at line 569. Always `true`.
- The comment ADR-079 itself added above `/telephony/reset` claimed the route was reachable by
  "any member". **False.** There is no member who is not the owner. That sentence was written to
  justify the guard's urgency and it overstated the threat model in the same commit that fixed
  the real defect.

Adding a fourth instance would not have secured anything. It would have added a line that *looks*
like access control, can never execute its deny branch, and would tell the next reader — correctly
reasoning from three consistent examples — that this codebase enforces roles somewhere. It does
not. That is a worse failure mode than the honest absence, because it is the kind of thing a
security review counts rather than tests.

This is the same class of defect as ADR-075 (`ci-success` asserting what failed instead of what
succeeded) and ADR-073 (a repair path with no caller): a control that is present in the source,
absent in behaviour, and trusted because it is present.

### The real coupling: shipping invites means dropping the index that fixes a race

The interesting finding is not the missing check, it is what enabling the role model actually
costs. To have a second member in an org, `org_members_user_idx` has to be dropped. That index is
not a modelling nicety — it is the audit#03 P1 fix, and it is load-bearing for first-login
race-safety. Its own comment says so:

> resolveOrCreateMembership's race-safety (routes.ts) depends on THIS constraint, not the old
> composite one below. Two concurrent first-logins each generate a different random orgId before
> inserting, so a composite (user, org) key never actually conflicts between them — only a
> standalone unique constraint on the user catches that race.

`resolveOrCreateMembership` mints `org_${randomUUID()}` *before* inserting, then inserts org and
membership in one transaction with `onConflictDoNothing`, then re-selects rather than trusting its
own write. That re-select only converges because the unique index rejects the loser. Drop the
index for invites and two concurrent first requests from the same user each create an org and each
keep a membership — a silently duplicated workspace on the single code path every new user hits,
found in production, not in tests.

So "add team invites" is not a feature bolted onto an existing role model. It is: drop the index,
replace the race-safety it provided with something else (advisory lock, `ON CONFLICT` against a
composite key with a deterministic orgId, or serialising bootstrap), *then* the role checks that
already exist start meaning something.

Worth noting the docstring on `resolveOrCreateMembership` named the wrong constraint — "the unique
(user, org) index" — directly contradicting the schema comment that says a composite key would not
catch the race at all. Two comments in two files disagreeing about which constraint provides the
guarantee is how the index gets dropped by someone who reads only one of them.

## Decision

**Do not add an owner-only check to `POST /api/app/telephony/reset`.** It would be inert, and
inert access control is worse than none because it is trusted.

**Do not delete the existing inert checks either.** `/org/close`'s 403 and `settings.tsx`'s
`isOwner` are the correct landing spots for invites and cost nothing to keep. They are wrong only
in being *unlabelled*.

**Label them instead.** Every place that reads as if a role model is live now says it is not, and
points here:

- `schema.ts`, above `orgMembers.role` — the column is a Phase 2 placeholder; every value is and
  can only be `"owner"`; every `role !== "owner"` check is currently unreachable.
- `app/routes.ts`, above `/org/close` — the 403 is unreachable, kept as the landing spot, not
  proof the model is live.
- `app/routes.ts`, above `/telephony/reset` — corrects ADR-079's "any member can reach" claim and
  states the omission is deliberate.
- `settings.tsx:74` — always true today; the server is the authority regardless.
- `resolveOrCreateMembership`'s docstring — names the standalone user index, matching schema.ts.

**Leave `org_members.role` without a CHECK constraint,** deliberately diverging from
`platform_admins.role`, which has a 5-value CHECK. That constraint was justified: the vocabulary
came from Vocalist and was already known. Here it is not. Pinning `('owner','admin','member')`
today guesses the invite design and buys a migration to undo.

**Record the index/race coupling as the gate for team invites** so it is discovered at design
time and not by a duplicated workspace in production.

## Consequences

- The ADR-079 open item is closed as "correctly absent", not "done". Anyone re-auditing the app
  surface will find `/telephony/reset` ungated and now finds the reason next to it.
- No runtime behaviour changes. This commit is comments, one docstring correction, and this
  record — the verification chain re-runs to prove exactly that.
- The permission model is now honestly documented as *single-owner-per-workspace, enforced by a
  unique index* rather than implied to be role-based. If Weeber ever claims role-based access
  control to a pilot customer or in a security questionnaire, that claim is false today.
- **Not addressed:** `resolveOrCreateMembership` can leak an orphan `orgs` row — the losing racer's
  `insert(orgs)` succeeds while its `insert(orgMembers)` hits `onConflictDoNothing`, leaving an org
  with no members. Checked against production: 4 orgs, 0 without a member, so it has never fired.
  Harmless (an empty row) and not worth a transaction rewrite before the invite work forces one.
- **Not addressed:** whether the product actually wants multi-member workspaces pre-pilot at all.
  Nothing here commits to shipping invites; it only prices them.
