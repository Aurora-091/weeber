---
adr: 096
title: A gate on two of five doors is a door
date: 2026-08-10
status: Proposed
supersedes: none
amends: the contract stated in place-outbound-call.ts:80-88
related: ADR-003, ADR-007 (DNC has no bypass), ADR-090 (reachability ratchet), ADR-092
---

# ADR-096 — a gate on two of five doors is a door

## Status

**Proposed.** No code changed. Raised by audit 16 F1/F2.

## Context

`placeOutboundCall` (`packages/api/src/voice/place-outbound-call.ts:89`) is documented as the single
call-placement entry point, and its doc comment assigns compliance to its callers:

> Compliance gates are the caller's responsibility (both call sites already run them before reaching
> here); this only places the call and returns the session key to store state under.

That was true when written. It is now wrong by three. The callers are:

| Call site | Endpoint | Gated |
|---|---|---|
| `voice/workflows/scheduler.ts:119` | scheduled-call sweep | yes (6 gates) |
| `voice/routes.ts:313` | `POST /api/voice/calls/outbound` | yes (6 gates) |
| `app/routes.ts:957` | `POST /api/app/leads/:id/call-now` | **no** |
| `app/routes.ts:645` | tenant agent preview test-call | **no** |
| `voice/routes.ts:840` | admin `.../test-call-phone` | **no** |

Ungated means no DNC, no calling window, no FTSA attempt cap, and none of the three insurance/India
number-series gates. `docs/brain/project-brief.md` lists as a non-negotiable invariant that
"DNC has no bypass anywhere, on purpose (ADR-003, ADR-007)". In code, three endpoints are a bypass.

Two facts make this urgent rather than tidy-up. First, the market decision recorded in ADR-097 moves
the primary market to US insurance outbound, where an unscrubbed call carries $500–$1,500 statutory
damages per call with no aggregate cap and a private right of action, and where the FCC's February 2024
declaratory ruling places AI-generated voices inside the TCPA's "artificial or prerecorded voice."
Second, the one ungated *tenant-facing* endpoint is the leads dialer — the endpoint a pilot actually
uses — and `insurance_advisors` being empty in production means the **gated** outbound route currently
returns 403 for every resolvable US number while the **ungated** leads route dials it. The product as
deployed routes a careful customer around its own compliance system.

This is the same defect class as the eight wiring defects that motivated ADR-090's `knip` ratchet, and
`knip` structurally cannot catch it: the gate functions are imported and are called, just not on every
path. Unit tests hide it for the same reason — each gate has tests, and the gates pass.

An additional live example of why caller-responsibility fails: `voice/routes.ts:279` carries a long
comment about how completely the `bypassCompliance` request-body flag was removed ("stripped entirely,
not just gated"). That hardening was real and it hardened one of five doors. The bypass that exists in
production today is not a flag anyone shipped deliberately; it is an endpoint that was added later and
never given the gates.

## Decision

**Compliance gates move inside `placeOutboundCall` and it fails closed.** Placement stops being a
primitive that trusts its callers and becomes the chokepoint that cannot be called around.

1. `placeOutboundCall` runs, before resolving routing or touching a provider: DNC, calling window,
   FTSA attempt cap, insurance number-series, insurance producer licensing, and the general India
   number-series flag — the same six, in the same order, that `voice/routes.ts:283-303` runs today.
2. It returns the existing typed failure shape (`{ ok: false, error, statusCode: 403 }`) so all five
   call sites surface a blocked call as a 403 with the gate's own reason string, unchanged in wording
   from today's messages.
3. The two currently-gated call sites **keep** their pre-checks. They are not removed. A duplicated
   gate is idempotent and cheap (both are DB reads on the hot path only for outbound placement), and
   the outbound route needs to reject before it writes a session. Removing them would trade one class
   of defect for another; the point of this ADR is that the floor is unconditional, not that the
   pre-checks were wrong.
4. **Fail closed on error.** If a gate throws — DB unavailable, adapter error — placement is refused,
   not allowed. This inverts today's implicit behavior in the ungated paths and is the whole point:
   the expensive failure is a call that should not have happened, not a call that did not happen.
5. The doc comment at `place-outbound-call.ts:80-88` is rewritten to say the opposite of what it says
   now, because that comment is what licensed the three ungated endpoints.
6. `BYPASS_COMPLIANCE` keeps its existing shape exactly — honored only outside production, never from
   a request body. Test mode (`orgs.callingWindowTestModeUntil`) keeps its existing scope exactly:
   calling window plus the two insurance config gates, self-expiring at 24h, and **never** DNC or the
   FTSA cap. This ADR does not widen or narrow any sanctioned bypass; it only makes the unsanctioned
   ones impossible.

### The regression test that is the actual deliverable

A test that enumerates the callers of `placeOutboundCall` and asserts every one of them is covered is
the only durable part of this decision — otherwise door six gets added in three weeks. Because `knip`
cannot see this, the check is a source-level assertion in the api test suite: `placeOutboundCall`'s
body must invoke the gate bundle before any provider client is constructed. Prefer one call to a
single `assertOutboundCallAllowed(orgId, to)` helper so the assertion has one symbol to look for and
the ordering lives in one place.

## Consequences

**Good.** The invariant in `project-brief.md` becomes true. Adding a sixth dial path is safe by
default. The pilot cannot be taught to route around compliance, because there is nowhere to route to.
The 403 reasons become the single place remediation UI has to be written against.

**Costs and risks.**

- Both admin and tenant **test-call** endpoints become gated. This is intended, and it will
  immediately bite: with `insurance_advisors` empty, a test call to any resolvable US number will 403
  until the pilot's licensed states are on file. That is the correct behavior and it makes audit 16 F2
  a hard blocker rather than a latent one. The self-expiring test mode is the sanctioned escape for a
  live demo; if it is not enough, that is a separate, explicit decision about demo flows and not a
  reason to leave a hole.
- Six DB reads move onto the placement path for the three previously-ungated callers. Irrelevant for
  a scheduled or manual dial; noticeable only if someone loops `call-now`, which they should not.
- Duplicated checks on the two already-gated paths double those reads. Accepted for the reason in
  decision point 3.
- Fail-closed means a database blip stops all outbound dialing. Correct trade for this product.

**What this does not decide.** It does not change any gate's logic, does not touch
`packages/weeber-compliance` (a STOP-AND-ASK boundary — the gate *functions* called here live in
`packages/api/src/voice/compliance/`, and the compliance package is consumed unchanged), does not
address the empty `insurance_advisors`/`do_not_call`/`consent_records` tables (audit 16 F2/F3), and
does not fix the area-code-based licensing determination (audit 16 F5, which is a correctness question
about *what* the gate reads, not *whether* it runs).
