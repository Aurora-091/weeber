# ADR-093 — A vertical switch left the old vertical's agents live

- **Status:** Accepted
- **Date:** 2026-08-10
- **Related:** ADR-092 (`enabled` as a dispatch gate), ADR-091 (visibility is an authorization boundary), ADR-086 (template visibility columns)

## Context

`PATCH /api/app/settings` accepts `vertical`. The org's vertical is not a cosmetic
label — per the 2026-06-18 architecture decision it re-points the entire product:
which agents exist, which workflows exist, which metrics and terminology the
dashboard uses. The route nonetheless did a bare
`db.update(orgs).set(updates)` and stopped there.

Nothing cleaned up `org_agent_configs`. Production state at the time of writing
(audit 12): `rishipawar8999's workspace` is `vertical=insurance` and holds three
`shopify-*` config rows — `shopify-cart-recovery`, `shopify-cod-confirmation`,
`shopify-feedback` — **all `enabled=t`**, the last one holding
`phone_number_id=5`, an active number.

Those rows sat in the worst possible position:

- **Invisible.** `getAgentConfigsForOrg` narrows by the org's current vertical,
  so the merchant cannot see them in the agents grid, and therefore cannot pause
  them or take the caller ID back.
- **Reachable.** `visibleTemplatesForOrg` deliberately has *no* vertical
  narrowing (ADR-091 — an in-flight call on a retired or cross-vertical template
  must still resolve its persona), so the resolver reached them fine.
- **Dispatchable.** Before ADR-092, `enabled` was not read on the call path at
  all, so the pill state was irrelevant anyway.

ADR-091 recorded a presumption worth correcting here: that a config row is
"already org-scoped" and therefore safe. It is org-scoped. It is not
*vertical*-scoped, and this route is the reason.

ADR-092 made these rows inert for dispatch, from the code side. That fixes the
consequence and leaves the cause: an org still accumulates live-looking rows for
a vertical it left, and the state a human reads (a row with `enabled=t`) does
not match the state the scheduler enforces (blocked). Two sources of truth about
the same agent is how the original defect happened.

## Decision

**1. On a vertical change, retire the off-vertical config rows.**
New `retireOffVerticalAgentConfigs(orgId, newVertical)` in
`voice/org-queries.ts`, called from `PATCH /api/app/settings` **only when the
vertical actually changes** (the previous value is read before the write). It
sets `enabled = false` and `phoneNumberId = null` on every config row whose
template belongs to another vertical, and returns the affected template keys,
which the route surfaces as `retiredAgents` so the UI can tell the merchant what
the switch just turned off instead of doing it silently.

**2. Disable, do not delete.** The persona text, tool selection, language and
provider overrides in those rows are the merchant's own work, and a vertical
switch is reversible — in practice it is often a mis-click during onboarding.
Deleting is the only part of this that cannot be undone. What actually has to
stop is the row being live and holding a caller ID; that is exactly the two
columns this touches.

**3. Only rewrite rows that are live or holding a number.** The update is
predicated on `enabled = true OR phone_number_id IS NOT NULL`, so switching
vertical back and forth does not keep rewriting already-inert rows.

**4. Do not narrow `visibleTemplatesForOrg` by vertical.** Still correct, still
for ADR-091's reason. Cleanup at the write is the right place for this; a
resolver that refuses to resolve a call already ringing is not.

**5. Inbound calls to a paused agent keep being answered, on the default
persona — decided, not inherited.** `enabled` is an **outbound** gate only
(ADR-092 enforces it in `dispatchScheduledCall`) and is deliberately not
consulted in `stream.ts`, where inbound resolves its persona from
`numberConfig`/`row.toNumber`. An inbound call is a human who chose to dial a
number the merchant publishes; pausing an agent is a statement about automated
dialling, not an instruction to stop answering the phone. Rejected: hanging up
(a real customer hears dead air on an advertised number — the worst outcome
available), and force-transferring to `humanTransferNumber` (most orgs have none
configured, so it degenerates into a hang up). If a merchant wants a number to
stop answering, the primitive for that is releasing the number. Those are
separate controls and stay separate. This is now a comment at the resolution
site so the next reader finds an argument instead of an accident.

## Consequences

- A vertical switch no longer strands live agents or a caller ID on a vertical
  the org has left. The rows persist, disabled, and re-enable normally if the
  merchant switches back.
- `PATCH /settings` gains one read (the previous vertical) on requests that
  include `vertical`, and one write when it changed. No cost on any other field.
- The existing production rows are not fixed by deploying this — the switch
  already happened. They need a one-off SQL cleanup applying the same rule
  (`enabled = false`, `phone_number_id = NULL`, no deletes), done separately.
- Inbound behaviour is unchanged by design. If that turns out to be wrong for a
  specific pilot, it needs a per-number setting, not a re-reading of `enabled`.
- Still not covered: `org_workflow_configs` has the same shape of problem
  (workflow templates are also vertical-scoped). Not fixed here because no
  production org has stranded workflow rows today; the same predicate applies
  when one does.

## Verification

- 3 new tests on `retireOffVerticalAgentConfigs`: off-vertical rows are disabled
  and their caller ID released · **only** `enabled` and `phoneNumberId` are
  written (the persona-preservation invariant) · no `UPDATE` at all when no
  template belongs to another vertical.
- Full gate chain green. No live call placed — unit-verified only, as with
  ADRs 082–085 and 092.
