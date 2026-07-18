---
adr: 57
title: "Pricing locked (internal only, not deployed): geo-differentiated tiers, split by voice cost, minutes not calls (2026-07-18)"
date: 2026-07-18
status: Accepted
---

## ADR-057 — Pricing locked (internal only, not deployed): geo-differentiated tiers, split by voice cost, minutes not calls (2026-07-18)

**Context:** following up on `docs/product-strategy/agents-ux-audit-and-cogs-2026-07-17.md`'s sourced
COGS findings (provider choice alone swings real per-minute cost 2.5-9x — Sarvam-optimized
~₹1-1.5/min vs. Cartesia/Deepgram ~₹4/min vs. ElevenLabs ~₹11-13/min), plus fresh competitor
pricing research (Bolna, HuskyVoice, Dvaarik, Vapi, Retell, Bland, ElevenLabs — real effective
rates, not headline marketing numbers) and a review of Dvaarik AI specifically as a sharper India
competitive reference than Bolna (solo-founder, ₹2/min, done-for-you onboarding, honest `/compare`
pages — see chat history for the full breakdown).

**Decision:** final locked pricing — full detail, unit economics, and explicit caveats in
`docs/product-strategy/pricing-lock-2026-07-18.md`. Summary:
- Unit is **minutes**, not "calls" (call length varies too much across verticals for calls to be a
  meaningful sold unit).
- **Split-rate by voice tier**: plans price against a standard stack (Sarvam or Deepgram/Cartesia)
  by default; ElevenLabs/premium voice is an explicit, separate surcharge, never silently absorbed —
  this directly closes the margin risk ADR/finding from the 2026-07-17 COGS audit (the agent config
  UI recommends ElevenLabs for Hindi/Hinglish with no cost guardrail; the UI-disclosure fix shipped
  2026-07-18, see `changelog.md`, but pricing itself needed to account for it too).
- **India and Global are geo-differentiated, separate pricing pages** (not a currency toggle) —
  COGS is dollar-flat across geography, but willingness-to-pay differs 3-5x, and compliance framing
  genuinely differs (DPDP/TRAI/DLT vs. TCPA/state-licensing).
- **India Starter locked at ₹2,499/mo**, 357 minutes included, ₹8/min overage. Margin range 43-83%
  depending on which standard-stack option (Sarvam vs. Cartesia/Deepgram) the agent actually runs.
- **Global Starter locked at $79/mo**, 790 minutes included, $0.10/min all-inclusive overage
  (deliberately undercuts Retell/Vapi's *real* effective cost, not just their headline number).
- Growth/Scale tiers for both markets, and full unit-economics math, are in the linked doc.
- Telephony is excluded from the per-minute rate wherever the merchant BYOs their own number
  (the India-default assumption, mainly Exotel) — folded into COGS only where Weeber provisions
  Twilio directly (mainly Global), since Twilio's own rate is cheap enough to absorb rather than
  meter separately.

**Consequence:** **this is a decided-but-not-deployed pricing structure** — explicitly not yet
reflected on the live marketing site, not wired into checkout/billing, and no plan-tier enforcement
exists in the product (an org can still pick ElevenLabs regardless of nominal tier; only the
cost-disclosure UI fix from 2026-07-18 exists today, not an enforcement gate). Use these locked
numbers for grant applications, investor materials, and internal financial models going forward —
don't re-derive pricing from scratch each time. Any future session updating the public pricing page
or wiring real billing off these numbers should treat that as a separate, explicit go-ahead, not
implied by this ADR.

---

*Next entry number: ADR-058. Add new entries above this line, keeping numbering sequential and dates
accurate to when the decision was actually made.*
