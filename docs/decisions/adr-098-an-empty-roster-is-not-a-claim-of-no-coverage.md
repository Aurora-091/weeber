---
adr: 098
title: An empty roster is not a claim of no coverage
date: 2026-08-11
status: Accepted
supersedes: none
amends: ADR-096 (the chokepoint stands; one gate's empty-input behaviour changes)
related: ADR-096, ADR-097, audit 16 F2/F5, docs/agent-prompts/00-insurance-regulatory-reference.md
---

# ADR-098 — An empty roster is not a claim of no coverage

## Status

**Accepted and implemented on 2026-08-11.** One gate, one condition, one day after ADR-096 shipped.

## Context

ADR-096 moved the six dial-time compliance gates inside `placeOutboundCall` behind a fail-closed
chokepoint, so all five call paths run them instead of two. That decision is not in question here and
is not being reversed.

What it exposed within hours: `insurance_advisors` is empty for every org in production (0 rows,
verified 2026-08-11), and `checkInsuranceProducerLicensing` refuses when no advisor on file covers the
prospect's state. Before ADR-096 that refusal only reached two of five paths, so the empty table was a
partial inconvenience. After ADR-096 it reached all five, including both test-call endpoints — which
means the only real pilot customer, a US-licensed insurance agency, could not place a single US call,
and neither could the founder demoing to the ~5 agencies on the waitlist.

The instinct is to read this as "the gate is too strict for an early-stage product." That reading is
wrong and it is worth saying why, because the same instinct will come back for the other five gates.
The gate is not too strict. It is asking the wrong question of the wrong input.

Three observations decide this:

1. **The gate already fails open on a harder case.** When `resolveUsState` cannot map the area code,
   the function returns `{ allowed: true }` with the reasoning that "blocking every call to an
   unrecognized area code would be far more disruptive than the risk it's guarding against." So a
   number whose state is completely unknown passes, while an org that simply has not filled in a form
   is refused. That is internally inconsistent — the second case has strictly more information
   available than the first, and was treated more harshly.

2. **Empty and non-covering are different facts.** An org with a roster listing FL and GA, dialing a
   NY number, has asserted its coverage and the assertion excludes this call. An org with no roster
   has asserted nothing. Collapsing "no data" into "negative data" is the classic fail-closed error:
   defensible for a check whose input is a *lookup against an external authority* (DNC), indefensible
   for a check whose input is *a form the customer has not opened yet*.

3. **The state determination is unreliable anyway.** `resolveUsState` infers jurisdiction from area
   code. Number portability means a Floridian with a NY cell and a New Yorker with a FL cell both
   resolve wrong, in opposite directions. Enforcing hard refusals on top of a best-effort inference,
   against an empty table, is precision theatre. Audit 16 F5 tracks fixing the input (lead `state`
   field first, area code as fallback); that fix is a precondition for this gate meaning much of
   anything, and it has not shipped.

The counter-argument considered and rejected: "an unverified insurance solicitation is a state DOI
matter, so refuse by default." True that it is a DOI matter. But the enforcement posture that actually
reduces that risk is the customer entering their roster, which they will do when onboarding asks them
to — not a platform-side refusal that produces a call failure the customer reads as a Weeber outage
and works around by using a different tool. A control that gets routed around protects nothing.

The alternative actually on the table this session was enabling `orgs.callingWindowTestModeUntil` on
the pilot org. That was rejected as worse: test mode also lifts the **calling window** (so the agent
could dial a prospect at 3am local, which is where real TCPA damages come from), it expires at a hard
24h with no UI surfacing the expiry (so a campaign starts 403ing mid-flight and looks like an
outage), and it is a manual toggle someone has to remember to re-enable. It trades a targeted problem
for an untargeted bypass.

## Decision

`checkInsuranceProducerLicensing` allows when the org's `insurance_advisors` roster is **empty**, and
logs an unconditional `console.warn` naming the org and the unverified state.

Once **any** advisor row exists for the org, the gate enforces exactly as before — a roster that does
not cover the resolved state refuses. An advisor row with `licensed_states: []` counts as a roster and
therefore enforces (and refuses everything), because that is a deliberate entry, not an absence.

Nothing else changes. Specifically:

- **The ADR-096 chokepoint stands.** All five paths still run all six gates. This is a change to one
  gate's behaviour on one input, not a reduction in coverage.
- **DNC stays hard.** No bypass, any path, any environment. This is where uncapped TCPA statutory
  damages live ($500–$1,500 per call, private right of action, FCC Feb 2024 ruling treating an
  AI-generated voice as "artificial").
- **The calling window stays on.** It needs no configuration data to be correct.
- **The FTSA attempt cap stays on.** Florida-only, counts our own call rows, needs no external data.
- **Both number-series gates stay on.** India-callee-only, therefore inert for a US pilot.

The warning is deliberately loud, unconditional and greppable rather than debug-level or sampled: it
is the only remaining signal that a real US solicitation went out with no licensing verification, and
any later audit of "how many unverified calls did we place" depends on it existing in logs.

## Consequences

The pilot agency can dial today without any bypass being enabled, and without the 24h clock. No
operator has to remember to turn anything back on.

The exposure this accepts is explicit: while the roster is empty, Weeber places US insurance
solicitation calls with no producer-licensing verification, and the liability for calling into a state
where no producer is licensed sits with the agency, as it did before Weeber existed. The platform is
not asserting the calls are licensed; it is logging that it does not know.

This makes roster entry an **onboarding** problem rather than a **gate** problem, which is where it
belonged. The API and UI already exist (`GET/POST/DELETE /api/app/insurance-advisors`,
`app/routes.ts:1238-1263`, Settings → Licensed advisors, `settings.tsx:516`); what is missing is
anything that prompts a new insurance org to use them. That prompt is now the actual work item, and it
is not in this ADR.

Deferred, unchanged, and still blocking a real campaign per audit 16 §8: licensing precedence (lead
`state` over area code, F5), a DNC feed with real data, and consent provenance captured at CSV import.
The empty `do_not_call` table means the DNC gate currently passes everything it is asked about — it is
hard, and it is also uninformed, which is a separate problem this ADR does not touch.

## Revisit when

Any of: the roster is populated for the pilot org (the lenient branch stops being reachable for them);
F5 lands and the state determination becomes trustworthy; or a second insurance customer onboards, at
which point "no roster" stops being a founder-adjacent edge case and becomes a default state real
strangers sit in.
