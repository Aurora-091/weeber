# ADR-081: An AI that performs the licensed act is the unlicensed agent — the boundary is the product, not a limitation of it

- **Date:** 2026-08-09
- **Status:** Accepted
- **Relates to:** `docs/agent-prompts/00-insurance-regulatory-reference.md` (US producer licensing, TCPA, PHI); agent template `insurance-final-expense-qualifier` (prompt 09); `voice/compliance/insurance-gates.ts` (`checkInsuranceProducerLicensing`)

## Context

A US final-expense agency — a real prospect, and a candidate first pilot — supplied their closer
script and asked for a Weeber agent that speaks it end to end. The script was explicitly revised
before being handed over: the isolation and pressure tactics common to that genre had been removed,
and the tone is genuinely humane. That revision addressed *manner*. It did not change *which acts
the speaker performs*.

The ask was approved by the founder in full knowledge of the exposure, with "I accept the
exposure." This ADR records why the build stopped short of it anyway, so the decision is not
re-litigated per prospect and does not depend on who happens to be reading the prompt file.

### The script is ten sections; three of them are ours

| Section | AI may speak it | Why not |
|---|---|---|
| Opening | Reworded only | Script says "I'm a licensed insurance agent here in [state]" and later reads out a license number |
| Needs analysis | Yes | Purpose, burial vs. cremation as a stated need |
| Financials | Yes, coarse | Income type, comfortable monthly band |
| Underwriting | No | Itemized conditions (COPD, diabetes, cancer, CHF, stroke, dementia) + full DOB |
| Carrier / Program | No | Carrier recommendation, Preferred/Modified explanation, "guaranteed to pay out," "rate won't increase" |
| Pitching price | No | Premium quotes and riders |
| Application | No | SSN, beneficiary designation, effective date |
| Recorded-line health | No | PHI, plus SSN for the medical/prescription background pull |
| Recap, then banking | No | Routing and account numbers |
| Solidification | No | Voice-signature ACH authorization |

Seven of ten are the licensed act itself or a regulated-data collection. The agent template already
implemented the three that are ours; the request therefore added almost no new *permitted* surface.

### Three independent reasons, any one of which is sufficient

**1. Licensing.** Recommending a carrier, explaining a program's benefit structure, quoting a
premium, and representing policy terms is the transaction of insurance. It requires a producer
licence in the prospect's state. This is criminal in most states, not a civil fine, and it attaches
to the *act*, not to the intent behind it. An AI asserting "I'm a licensed insurance agent" and
reading a license number is a false statement of licensure with no compliant phrasing — the problem
is the claim, not the words.

**2. The pattern is indistinguishable from elder financial fraud.** The population is, by the
product's own description, older and on a fixed income. The script has a synthetic voice claim
licensure, collect an SSN, collect bank routing and account numbers, and take a payment
authorization. One line asks the caller to confirm a routing number *the caller was never asked
for*: "the routing number will auto-populate — I have it as [___], can you confirm that?" That is a
pretext for harvesting account digits when a human reads it, and an enforcement exhibit when a
machine reads it ten thousand times. A regulator reviewing this reads call recordings, not
intentions, and "I accept the exposure" is not the founder's alone to accept: it lands on the people
called, on the producers whose licences are on the paperwork, and on ADLOOM X as the entity.

**3. It does not work commercially.** No carrier honours a voice signature taken by an automated
system. The resulting applications are rescindable: the policies do not persist, the commissions
claw back, and replacement liability follows. Even in the world where no regulator ever calls, this
flow books revenue that reverses, and the agency attributes the reversal to us. The compliant
version is the one that produces durable commissions.

### Refusing the seven sections outright was also wrong

The failure mode of a pure refusal is an agent that automates the easy half and leaves the agency's
closers working from a Word document — which is precisely why the "just let the AI say it" request
kept coming back. The regulated sections are where their closers' time actually goes.

## Decision

**The boundary sits at handoff, and the regulated half is projected onto the licensed human rather
than discarded.**

1. **The agent runs the agency's real script, in the agency's voice, up to solicitation.** Prompt 09
   now carries full persona fidelity for the permitted scope: the opener and its
   "don't-recall-inquiring" branch, needs analysis including burial/cremation and the
   "what's behind that" family probe, budget discovery, benefit timing, tobacco, banking *readiness*,
   a coarse health-readiness flag, and the business-card text (`sendSms`).
2. **General funeral-cost context is permitted; insurance figures are not.** The agent may state the
   typical national cost of a burial or cremation, always with the rider that the advisor gives real
   numbers. It may not attach any figure to a premium, coverage amount, carrier, or qualification,
   and may not convert the context into a recommendation ("so we'll look at coverage in that
   range"). The distinction is that the first is a fact about funerals and the second is a
   representation about insurance.
3. **Seven steps are advisor-only, enumerated in code.** `voice/insurance/closer-brief.ts` holds
   `ADVISOR_ONLY_STEPS` — the regulated sections in the agency's own script order, each with the
   reason it is the human's. This is the machine-readable form of a rule that previously existed
   only as prose in a prompt.
4. **The advisor receives a pre-filled closer brief at handoff**, so they resume mid-script rather
   than restarting. `buildCloserBrief` projects the call's `capturedState` into captured facts,
   explicitly-missing fields, and the advisor's ordered checklist; `formatCloserBriefText` renders it
   for a `crmSync` note or an advisor-facing panel.
5. **Regulated data appearing in `capturedState` is an incident, not data.**
   `findProhibitedCapture` scans for SSN/bank/DOB/premium/carrier/diagnosis-shaped keys and the
   brief surfaces a compliance alert instead of formatting them into a CRM record. The agent is
   forbidden from capturing these, so a hit means the prompt regressed.
6. **Referrals move to the post-sale agent, and never become dialable leads.** Prompt 07 asks once,
   only on a positive call, captures the relationship word only, and routes the follow-up through
   the policyholder. A referred third party has not contacted the agency and has given no consent to
   be called, so their number is deliberately not collected.

The boundary is revisitable — as carrier policy and AI-in-insurance rules settle, specific steps may
move. It moves by amending this ADR, with a named regulatory basis, not by editing a prompt.

## Consequences

- The pitch to the prospect changes shape and gets stronger: the AI absorbs the qualifying calls
  that consume closer hours, and the closers get a better back half than their paper script. The
  agency's own script is fully automated — split across two actors.
- The refusal is now testable. `closer-brief.test.ts` locks the seven advisor steps by key, so a
  future change cannot quietly shorten the list, and asserts the prohibited-key guard fires on every
  entry it declares.
- **Found while implementing this, and fixed here:** all nine seeded prompts instructed the model to
  call `captureField({ key, value })` while the tool has always declared `{ field, value }` — 28
  occurrences, none correct. Arguments that fail schema validation do not execute, which matches
  production exactly: `tool_calls` is empty across every call ever placed, while `captureField` is
  the most-instructed tool in the set. All nine prompts are corrected, and
  `prompt-hygiene.test.ts` now validates every prompt's tool-call examples against the tools' real
  parameter names, so the next drift fails at CI rather than silently disabling state capture.
- **Not addressed here:** the closer brief is generated but not yet surfaced anywhere. Wiring it
  into the advisor's dashboard at transfer time, and into the `crmSync` note body, is the follow-up.
  Until then the brief is a tested pure function with no caller — deliberately shipped in that state
  so the boundary and its guard land before the plumbing.
- **Also not addressed:** there is still no advisor-presence check before `transferToHuman`, so a
  qualified lead discovers "no advisor" only at connect time and falls back to booking. Unchanged by
  this ADR, and more visible now that the handoff carries a brief someone is meant to read.
