# Weeber pricing — LOCKED (internal only, not yet live) — 2026-07-18

**Status: decided, not deployed.** This is the final pricing Weeber will use — for grant decks,
investor conversations, and internal planning — but it is **not** on the live marketing site or
wired into checkout yet. Do not update `pricing.tsx`, the marketing copy, or any billing
integration off this doc without a separate explicit go-ahead. This doc exists so pricing/unit
economics don't have to be re-derived every time a deck or model needs them.

Builds directly on `docs/product-strategy/agents-ux-audit-and-cogs-2026-07-17.md`'s sourced
per-provider rates — this doc adds the final tier structure, the split-rate (standard vs premium
voice) decision, and the geo-differentiated (India vs Global) call, none of which existed yet as
of 2026-07-17.

## Core decisions

1. **Unit is minutes, not "calls."** Call length varies too much across verticals (a COD
   confirmation can be under a minute, an insurance appointment-setting call can run 3-5 minutes)
   for a flat "N calls/month" number to mean anything consistent. Plans are sold as minutes
   included, with an illustrative "~X calls at Y min avg" note for merchant-facing framing only.
2. **Split-rate by voice tier, not one blended rate.** Provider choice alone swings real COGS
   2.5-9x (Sarvam-optimized ~₹1-1.5/min vs Cartesia/Deepgram ~₹4/min vs ElevenLabs ~₹11-13/min).
   Plans are priced against a **standard stack** by default; **ElevenLabs/premium voice is a
   separate, explicitly-priced surcharge**, never silently absorbed.
3. **Geo-differentiated pricing — India and Global are separate plans, not a currency toggle.**
   COGS is dollar-flat regardless of customer geography (every AI provider bills USD), but
   willingness-to-pay differs 3-5x between the India market (Bolna/HuskyVoice/Dvaarik real rates:
   $0.02-0.07/min) and the Global market (Vapi/Retell/Bland real rates: $0.07-0.33/min). Compliance
   framing also genuinely differs (DPDP/TRAI/DLT vs TCPA/state-licensing) — these should be two
   distinct pricing pages when they do go live, not one page with a currency dropdown.
4. **Telephony is excluded from the per-minute rate wherever possible.** India merchants
   predominantly BYO their own Exotel number/account — telephony cost sits on them, not Weeber.
   Where Weeber provisions Twilio directly (mainly Global), telephony is cheap enough
   (~$0.013-0.014/min US, ~$0.0075/min India) to fold into COGS rather than metering separately.
5. **Overage rate stays healthy even when the headline plan price is aggressive.** The entry price
   is a trust/conversion lever; the overage rate is where margin is actually protected — mirrors
   how ElevenLabs/Bland structure their own tiers (cheap subscription, real-price overage).

## Locked tiers — India (₹)

Standard stack assumed = Sarvam STT+TTS (India-language-first default) **or** Deepgram+Cartesia
(English-first) depending on the agent's configured language — both count as "standard," ElevenLabs
is the only tier that triggers the premium surcharge. COGS range reflects that spread.

| Tier | Price | Minutes included | ~Calls (2.5 min avg) | Standard-stack COGS range | Gross margin range |
|---|---|---|---|---|---|
| **Starter** | **₹2,499/mo (LOCKED)** | 357 min | ~140 calls | ₹428 (Sarvam) – ₹1,428 (Cartesia/Deepgram) | **~43%–83%** |
| **Growth** | ₹12,999/mo | 1,500 min | ~600 calls | ₹1,800 (Sarvam) – ₹6,000 (Cartesia/Deepgram) | **~54%–86%** |
| **Scale** | Custom | Volume-negotiated | — | flat per-minute regardless of volume | ~40-50% at real volume (standard mix) |

- **Overage:** flat ₹8/min (standard stack) — matches the Starter tier's effective rate
  (₹2,499 ÷ 357 min ≈ ₹7/min, rounded to a clean ₹8/min sold number with a small margin cushion).
- **Premium voice (ElevenLabs) surcharge:** +₹8-10/min on top of base. Incremental COGS delta vs.
  the cheap end of standard (Sarvam, ~₹1.2/min) is ~₹10-11/min; vs. the expensive end of standard
  (Cartesia/Deepgram, ~₹4/min) is ~₹8/min. Surcharge is set to protect margin against the
  **cheaper** standard baseline (Sarvam) since that's the more likely true default for an
  India-vertical (Hindi/Hinglish) agent — all-in premium rate lands ~₹16-20/min, deliberately above
  Bolna/Dvaarik's real range since it's an opt-in upgrade, never a default.

## Locked tiers — Global ($)

| Tier | Price | Minutes included | Standard-stack COGS (incl. Twilio) | Gross margin |
|---|---|---|---|---|
| **Starter** | **$79/mo (LOCKED)** | 790 min | ~$0.049-0.052/min → ~$40 | **~49%** |
| **Growth** | $499/mo | 3,500 min | ~$0.05/min → ~$175 | **~65%** |
| **Scale** | Custom | Volume-negotiated | flat per-minute regardless of volume | ~40-50% at real volume |

- **Overage:** flat $0.10/min all-inclusive (telephony+STT+TTS+LLM bundled as one number, no
  stacking) — undercuts Retell/Vapi's *real* effective cost ($0.11-0.33/min after their own
  pass-through fees) while remaining clearly above their misleading low headline numbers, so the
  claim holds up against a competitor's actual invoice, not just their marketing page.
- **Premium voice (ElevenLabs) surcharge:** +$0.08/min. All-in premium rate lands ~$0.28-0.32/min —
  squarely inside Retell/ElevenLabs' real-world range, meaning Growth/Scale tiers globally could
  reasonably bundle premium voice by default later if desired, since headroom exists there in a way
  it doesn't for India Starter.

## Final quick sanity check — India Starter at ₹2,499 (locked number)

- 357 minutes included, ₹2,499/mo.
- Worst case for margin (agent runs the pricier "standard" option, Deepgram+Cartesia, not Sarvam):
  COGS = 357 × ₹4/min ≈ **₹1,428** → margin ≈ **43%**.
- Best case (agent runs Sarvam, the actual India-language default): COGS = 357 × ₹1.2/min ≈ **₹428**
  → margin ≈ **83%**.
- Both ends are positive and workable. The wide spread itself is the reason the split-rate
  (standard vs. ElevenLabs premium surcharge) decision matters — it's what keeps the *floor* of
  this range from ever going negative, which an ElevenLabs-by-default setup would risk.
- Sanity-checked against real competitor rates: ₹2,499/357min ≈ ₹7/min effective, sitting between
  Dvaarik's ₹2/min (much cheaper, but bare-bones per-minute PAYG with no vertical depth) and
  Bolna's real ~₹4-10/min range — a defensible, non-scary entry price for a first-time buyer.

## Explicit caveats — carry these into any deck/model built from this doc

- COGS figures are **sourced-or-estimated per provider's public pricing pages**, not reconciled
  against Weeber's actual invoices — treat as directional, re-verify before using in a funding-
  round financial model (not just a grant deck, where directional is acceptable).
- Avg call length (2.5 min) is an **assumption**, not measured — `voice/cost-estimate.ts` (shipped
  2026-07-18) now logs a real estimated cost per call in production, so this should be replaced
  with actual measured averages once there's a meaningful sample size.
- LLM token cost is treated as a small, roughly-flat per-minute add-on across all scenarios above —
  real per-call token usage still isn't tracked (same gap noted in `cost-estimate.ts` and the prior
  COGS doc) — reconcile once that's built.
- No plan/billing-tier enforcement exists in the product yet — an org can select ElevenLabs
  regardless of which tier they're nominally on. The UI now discloses the cost tradeoff at the
  point of choice (shipped 2026-07-18), but nothing blocks it. Real enforcement (checking a plan's
  provider allowance before saving an agent config) is a separate, not-yet-scoped follow-up.
- These numbers assume the described margin structure holds at the described volumes — Scale-tier
  margin compression (~40-50%) at real high volume is normal (matches how every competitor's
  enterprise tier behaves) but should be revisited once there's an actual large account to model
  against, not just extrapolated.

## What to do with this doc

Use these locked numbers directly in: grant applications (IIMA/NSRCEL/SISFS/IIMK), investor
one-pagers, internal financial models, and any "unit economics" slide. Do **not** treat this as
permission to update the public pricing page, checkout flow, or any customer-facing copy — that's
a separate, explicit decision when you're ready to go live with it.
