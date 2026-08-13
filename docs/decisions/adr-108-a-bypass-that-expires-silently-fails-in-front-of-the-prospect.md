# ADR-108 — A bypass that expires silently fails in front of the prospect

- **Date:** 2026-08-12
- **Status:** Accepted (implemented 2026-08-12)

## Context

Dialing an India number stopped working. The diagnosis took long enough to be worth
recording, because nothing was broken.

`91efb0f` (ADR-096) made `assertOutboundCallAllowed` the single fail-closed chokepoint
for every outbound dial. Before it, three of `placeOutboundCall`'s five callers ran no
gates at all — `POST /api/leads/:id/call-now`, the tenant preview test-call, and the
admin `.../test-call-phone`. Those were the paths used for live testing. ADR-096 closed
them, correctly, and the last real calls in production (`+1857…` → `+9179…`,
`+9163…`, 2026-08-10) predate that commit landing.

With the chokepoint in place, an insurance-vertical org dialing `+91` reaches
`checkInsuranceNumberSeriesCompliance`, which is **unconditional** for that vertical and
requires an active TRAI 1600-series number. No org has one. The dial is refused before
Twilio is touched, which is the correct outcome.

The escape hatch already existed and already covers this: `orgs.callingWindowTestModeUntil`,
set to now()+24h by `POST /api/app/compliance/test-mode`, returns `allowed: true` from
`insurance-gates.ts` **before any number lookup** — its own comment says it exists to
"run a live phone demo before the 1600-series number is registered". Walking every gate
for an insurance org dialing a fresh `+91` with test mode on: DNC enforced (never
bypassed), calling window bypassed, FTSA attempt cap a no-op (Florida NANP area codes
only, `+91` cannot match), 1600-series bypassed, producer licensing a no-op (US-only,
and fails open on an empty roster per ADR-098), India DLT series skipped entirely for
the insurance vertical. So the capability was never missing.

What actually failed is the ergonomics of its expiry. Test mode is deliberately
self-expiring so it cannot be left on in production, and on expiry the refusal it
produces is **byte-identical** to the refusal an org that was never configured gets:
the full TRAI 1600-series registration paragraph. Accurate, and the wrong thing to read
out during a demo, when the real remedy is one toggle. The four production orgs' state
at diagnosis time: two with `calling_window_test_mode_until` NULL, one expired
2026-08-11 20:19Z, one expired 2026-08-04. The most recent had lapsed the previous
evening — that was the whole of it.

## Decision

Two changes, both to legibility. Neither widens what test mode lifts.

**1. Name the expiry in the refusal.** `assertOutboundCallAllowed` becomes a thin
wrapper over `runOutboundGates`, which keeps the fail-closed logic untouched; on refusal
only, the wrapper appends the diagnosis when the org has a **lapsed**
`callingWindowTestModeUntil`. The suffix is additive — the registration requirement is
still real after the toggle, so the original reason survives verbatim.

Scoped by `TEST_MODE_BYPASSABLE = {calling_window, insurance_number_series,
insurance_producer_licensing}`. DNC and `attempt_cap` are deliberately absent: they are
never bypassed, so a refusal from either is never a test-mode problem, and a message
implying otherwise would teach an operator that DNC has a toggle. It does not. Silent
when the column is NULL (no demo history to blame) and silent when test mode is still
active (the refusal came from a gate test mode does not lift, so blaming it would
actively mislead). Best-effort by construction: this is an error-message improvement and
must never convert a clean refusal into a thrown exception, so any failure yields no
suffix.

**2. Show the countdown before it matters.** `formatTimeRemaining` in
`packages/web/src/web/lib/format.ts` returns null once lapsed rather than "0m", forcing
callers to handle the expired case. The dashboard badge gains `Xh left`, switching to a
bolded `lapses in Xh` inside the last 3 hours — long enough to re-arm before a scheduled
call. Settings gains the same warning plus, when the timestamp is in the **past**, an
explicit "expired, your next call will be refused" line. That state is the one worth
naming loudest: the toggle reads "off" either way, but here the org was demoing
recently and a gate that passed yesterday will refuse today.

## Rejected

**A per-org verified test-number allowlist** — register your own handsets, only those
exact E.164 numbers skip the config gates. This was proposed first and is the wrong
shape for the actual use case: demos are given to whoever is in the room, in real time,
so the destination is not known in advance and cannot be pre-registered. An allowlist
would make the common case impossible while solving a narrowing problem nobody has.
Recorded here so it is not re-proposed.

**Making the 1600-series gate conditional (flagged) like the India DLT gate.** It is an
IRDAI mandate with a passed deadline; the unconditional version is correct, and the
demo path already has a documented, self-expiring, per-org bypass.

**Extending the 24h window, or making it configurable.** The window is the control. A
longer one is a bypass that outlives the demo, which is the failure mode the expiry
exists to prevent.

**Replacing the gate's reason string with the test-mode hint.** The registration
requirement does not stop being true because a toggle is available.

## Consequences

`bun run --cwd packages/api test` 1281 → 1287. `outbound-gate-test-mode-hint.test.ts`
asserts the two properties that matter — the hint appears only for gates test mode
actually lifts (DNC and attempt-cap refusals verified clean) and the original regulatory
reason survives — and was proven non-vacuous by stubbing the hint to `""`, which failed
2 of 6.

**Known and unfixed.** Test mode is a blanket lift for its 24 hours, not a
demo-scoped one: it applies to every destination the org dials, not just the handset in
the room. For invited demos, where the prospect asked to see the product and is
expecting the call, that is defensible. It is not a safe basis for cold outreach — under
the FCC's February 2024 declaratory ruling an AI-generated voice is "artificial" for TCPA
purposes at $500–$1,500 per call, no aggregate cap, private right of action — and this
toggle is precisely the mechanism that would let that happen quietly. Nothing in the
product currently distinguishes the two uses, and no ADR here proposes to; the
constraint is operational.

Also unfixed: the countdown is computed at render time and does not tick, so a
dashboard left open past the boundary shows a stale label until the next fetch.
