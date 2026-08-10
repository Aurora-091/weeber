---
adr: 097
title: The market that answered is not the market we planned
date: 2026-08-10
status: Proposed
supersedes: the "Launch vertical: ecommerce, Shopify first" line in docs/brain/project-brief.md
related: ADR-031 (vertical-agnostic seam), ADR-095 (orgs.market), ADR-096
---

# ADR-097 — the market that answered is not the market we planned

## Status

**Proposed.** Requires the user's explicit acceptance, because it reverses a founding decision.

## Context

`docs/brain/project-brief.md` states: *"Launch vertical: ecommerce, Shopify first (cart recovery + COD
confirmation + feedback)"*, with clinic, insurance and hotel "on the board," and India as the primary
market (`agent-frame.ts:53`, "India-first list since that's the primary market";
`pricing-lock-2026-07-18.md` decision #3 locking India and Global as separate plan families).

What actually happened over roughly three weeks of production existence:

- **No India pilot was landed.** Not ecommerce, not clinic.
- **One US-licensed insurance agency is in pilot**, dialing US prospects, with about five more
  agencies on a waitlist.
- Production reflects the insurance skew already: 3 of 4 orgs are `vertical=insurance`, all four
  outbound DIDs are US Twilio numbers, and the 19,480-character explicitly-US-only final-expense
  template is `enabled` on 2 of 3 insurance orgs. The one shopify org has placed no calls.
- Nothing has been billed: `plan_name` NULL on 4 of 4.

Market evidence, independent of who happened to sign up:

- **US Shopify voice is the worst quadrant available**, so the original plan's US extension was never
  viable either. COD is effectively absent from US ecommerce, which removes the COD-confirmation agent
  entirely. Cart recovery competes against SMS at ~2.65% conversion for fractions of a cent, already
  installed on every US Shopify store via Klaviyo/Postscript — a $0.10/min call must beat that by an
  order of magnitude. And an AI-voice cart-recovery call to a US mobile is a marketing call requiring
  prior express *written* consent under the FCC's February 2024 ruling; a checkout email field is not
  that consent.
- **India insurance is legally undeliverable as built.** TRAI's Direction of 16 December 2025
  (F. No. G-6/(8)/2025-QoS-Part(I), primary PDF fetched) clause (iii) bars IRDAI-regulated entities
  from any service or transactional voice call from a non-1600-series number after 15 February 2026,
  and consent does not cure it. Twilio cannot allocate that series. Our own
  `checkInsuranceNumberSeriesCompliance` correctly blocks it and nothing on our stack can satisfy it.
- **India ecommerce is real but contested and thin.** COD/RTO pain is genuine and the 1600-series
  Direction does not cover retailers. But the effective ceiling is ~₹7/min against a locked 43%
  worst-case margin, and Bolna raised $6.3M led by General Catalyst in January 2026 positioned
  explicitly on India's cost sensitivity, while Sarvam — our own Indic model supplier — has opened a
  self-serve conversational voice-agent platform, i.e. became a competitor at the application layer.
- **US insurance is the only quadrant with observed pull and margin headroom.** A customer asked. The
  locked Global Starter ($79 / $0.10 overage) yields ~49–65% margin on the same dollar COGS that
  leaves 43% in India. And the buyer is compliance-obsessed, which makes our DNC/consent/licensing/
  disclosure machinery the product rather than overhead — the one place our existing investment is a
  differentiator instead of a tax.

## Decision

**US insurance outbound is the launch market and launch vertical. Everything else is parked, not
deleted.**

1. `project-brief.md`'s launch-vertical line is replaced: launch vertical is **insurance**, launch
   market is **US**. Ecommerce/Shopify, clinic, and hotel move to "on the board." The
   Shopify→Woo/BigCommerce/Dukaan sequencing is unscheduled.
2. **Nothing is deleted.** ADR-031's vertical-agnostic seam means the three Shopify templates, the
   Indic language layer, the Sarvam adapters, the India compliance pack, the 1600-series gates and
   `weebersh` all stay in the tree, tested, unreferenced by any active customer. Parking costs us
   almost nothing precisely because of ADR-031; deleting would cost us the option.
3. **India remains the second market, not an abandoned one** — reopened on either a real India
   ecommerce pilot or an India insurance customer who already holds 1600-series numbers. The
   preconditions are written down (below) so this is a decision to revisit, not a door slammed.
4. **ADR-095's `orgs.market` is now cheaper and should ship with this.** With US-first decided,
   `market` has a real default (`us`) and one real alternative (`in`) rather than being a speculative
   abstraction, and it is what lets the parked India work stay in the tree without leaking into a US
   customer's prompts — which is exactly how the US-only final-expense template ended up enabled on
   the `country_code=IN` org.
5. **The grant/investor narrative is explicitly restated** as "Indian company, Indian engineering
   cost base, selling into the US insurance market" — not India-first Indic voice. Grants
   (IIMA/NSRCEL/SISFS/IIMK, DPIIT) are entity-scoped so eligibility is unaffected, and the Sarvam
   Startup Program and NVIDIA Inception credits remain valid; what changes is that we stop telling a
   panel a customer story we do not have. Decide this deliberately now rather than being caught
   mid-pitch.

### Preconditions before the pilot runs a real campaign

This ADR is a market decision, and it is worthless if the pilot's first campaign is unlawful or
unbillable. In dependency order:

1. **ADR-096** — gates at the chokepoint. Blocking.
2. **Advisor roster onboarding** — `insurance_advisors` is empty, so producer licensing blocks every
   resolvable US number on the gated path. Blocking.
3. **DNC feed + consent provenance at lead import** — `do_not_call` and `consent_records` are both
   empty. Blocking for outbound at volume.
4. **One real US call, then one real US campaign.** No US number has ever been dialed by this system;
   US English STT, area-code→state resolution, four-timezone calling windows and Twilio AMD are all
   unexercised in production.
5. **A payment path that accepts a US company's card for an Indian private limited** (Stripe rejected;
   Dodo/Paddle undecided). Non-blocking for the pilot, blocking for revenue.
6. **MSA indemnity, contractual consent-of-record requirement, and E&O cover** before any tenant
   dials at volume. One bad tenant on the waitlist is $5M–$15M of theoretical statutory exposure and
   platforms get named under direct-participation theories.

### Preconditions to reopen India

Any one of: an India ecommerce pilot with a signed paid commitment; an India insurance customer that
already holds 1600-series numbers and DLT registration; or an Indian telephony partner (Exotel/
Ozonetel/similar) integrated to the point of placing a real call — `plivo-client.ts` and
`exotel-client.ts` both still carry "no live prototype call yet" caveats.

## Consequences

**Good.** Effort concentrates on the one quadrant with a customer, the best margin, and a buyer who
values our compliance work. The latency and correctness defects in audits 13/14 get an owner, because
a US agency benchmarking against Vapi/Retell will hear them.

**Costs, stated plainly.**

- Roughly the last month of Shopify/COD/Indic work has no customer attached. It was sequenced first
  and should have been second. The Indic layer was already dead capital in practice — Sarvam ran on 0
  of 11 production calls — but this makes it explicit.
- We lose the price umbrella that made a 1.5s time-to-first-token survivable.
- Liability moves from regulatory (TRAI suspending telecom resources) to private and uncapped
  ($500–$1,500 per call, no aggregate cap, no need to prove harm). Our compliance architecture is
  good and our compliance *data* is empty; the gap between those two is now the main risk in the
  company.
- On-call inverts to Indian night hours.
- We have one pilot and a waitlist. A waitlist is not traction and should not be described as clients
  in any deck until money moves.

**What this does not decide.** It does not change `orgs.vertical` semantics or ADR-031, does not
delete any template or package, does not set pricing (the locked doc stands, Global tiers simply
become the active ones), and does not touch `packages/weeber-compliance`.
