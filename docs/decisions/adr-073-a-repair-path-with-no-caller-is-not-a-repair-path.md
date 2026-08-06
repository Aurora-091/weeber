# ADR-073: A repair path with no caller is not a repair path

- **Date:** 2026-08-06
- **Status:** Accepted
- **Supersedes / relates to:** ADR-042 (per-org Twilio isolation), ADR-071 (ending a call is a local guarantee)

## Context

`syncNumberWebhooksForOrg` in `voice/twilio-provisioning.ts` re-applies `inboundVoiceWebhooks()` to
every active number an org holds. It was written, documented and covered by four unit tests in
`twilio-subaccount-idempotency.test.ts`. It had **no caller anywhere in the system** — not a route,
not a CLI, not a boot hook. `rg` over the repo found it referenced only by its own tests.

The function exists for two states it is the only cure for:

1. **Numbers bought before the purchase path set a `voiceUrl` at all.** These are inert. Twilio has no
   URL to POST to, so the caller reaches Twilio's default "not in service" message.
2. **Every number after a `PUBLIC_APP_URL` change.** Webhooks are baked per number at purchase time
   (a deliberate choice — see the `inboundVoiceWebhooks` comment on why not a shared
   `voiceApplicationSid`), so a domain move silently strands the whole fleet.

Both failures are invisible from our side. There is no inbound webhook, therefore no `calls` row, no
error, no log line — nothing to alert on. The only signal is a caller who says nobody answered. That
makes this the worst possible class of dead code: the repair for a failure mode our telemetry cannot
see was itself unreachable.

Worth being precise about the blast radius, because it is narrower than "inbound is broken":

- **Outbound is unaffected.** `place-outbound-call.ts` passes `url` per call on `calls.create`, which
  Twilio prefers over anything configured on the number.
- **Numbers purchased after `aad7029`** get the webhooks at purchase time and are fine unless the
  public URL later moves.

So the exposure is specifically numbers bought before that commit, plus any future domain move. Whether
Railway currently holds any number of the first kind is still **unverified** — that check is the
immediate reason this route needs to exist.

## Decision

Give it a caller: `POST /api/voice/admin/orgs/:orgId/twilio/sync-webhooks`, next to the sub-account and
number-purchase routes in `voice/admin-routes.ts`.

- **Admin-key gated**, like every other route in that file.
- **404** on an unknown org, before touching Twilio.
- **400** with the provider's own error text on failure — never a success shape.
- Returns `{ checked, repaired }` so the operator can tell "all fine" from "fixed 3".
- **Audit-logs `twilio.webhooks.synced` only when `repaired.length > 0`.** This mirrors the sub-account
  route's `reused` handling: a clean run over correctly configured numbers is a no-op, and recording it
  as a repair would make the admin audit trail claim fixes that never happened.

**Manual and admin-triggered, not automatic on boot.** This is the load-bearing part of the decision.
An automatic sync would make a deploy that comes up with a wrong or missing `PUBLIC_APP_URL` re-point
every number in the fleet at it — converting a config typo into a fleet-wide inbound outage, with no
human in the loop. The function is idempotent and safe to re-run, but "safe to re-run" is not the same
as "safe to run unattended against the wrong input." Requiring an intentional request keeps the blast
radius behind a human.

## Consequences

- The repair is reachable. Both states above now have an operator-executable cure.
- One more admin route to keep gated; it carries the same key requirement as its neighbours.
- The route is per-org by design. A `PUBLIC_APP_URL` move needs one call per org holding numbers —
  acceptable at current scale, and a deliberate limit on how much a single request can change. If the
  fleet grows past the point where that is reasonable, the answer is a batch route with an explicit
  confirmation argument, not an automatic hook.
- Tests pin the **caller**, not the repair: `voice/admin-twilio-sync-webhooks.test.ts` covers gating,
  the unknown org, the error surface, and the audit-on-repair-only rule.
  `twilio-subaccount-idempotency.test.ts` continues to cover the repair itself.
- Still open: nothing here proves Railway's existing numbers are healthy. The route makes that
  answerable in one request per org; the answer has not been obtained yet.

## Alternatives considered

- **Run it automatically at startup.** Rejected above — turns a bad env var into a fleet-wide outage.
- **Run it inside the existing sub-account route.** Conflates "make sure this org can be billed a
  number" with "repair numbers it already has", and would fire on a path that has no reason to touch
  remote number config.
- **A one-off script instead of a route.** Would work once, for the numbers that exist today, run by
  someone with production credentials on their laptop. It does not survive the next domain move, and
  it puts live Twilio write access in an ad-hoc place rather than behind the admin key and the audit
  log.
- **Delete the function as dead code.** Tempting and wrong: the failure it repairs is real, silent, and
  has no other cure.
