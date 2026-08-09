# Weeber billing & metering spec — hybrid plans + PAYG + auto-recharge (2026-08-09)

**Status: proposal, not decided, not deployed.** This extends `pricing-lock-2026-07-18.md` /
ADR-057 — it does **not** replace the locked tier prices. Nothing here is wired into product,
schema, or checkout. Needs an explicit go-ahead + a new ADR before any of it is built.

**Why this doc exists:** ADR-057 locked *what a plan costs*. It did not define (a) what a billable
minute actually is, (b) what happens between plans and overage (top-ups / PAYG / auto-recharge),
(c) how spend is capped, or (d) which rail charges the card. Audit 09 finding **F1 — no spend
ceiling anywhere in the product** is unfixable until (a) and (c) are decided, so this comes first.

**Method:** source-level reading of `cf929b0` plus public payment-rail documentation. No production
data, no invoices, no measured call durations. Every COGS number is inherited from ADR-057 and
carries its caveats.

---

## 0. Three defects in the current state, before any new design

These are not new opinions — they are contradictions inside the repo as it stands.

### 0.1 The dashboard shows pricing you already rejected — **P1**

`packages/web/src/web/pages/app/billing.tsx:53-99` hardcodes:

| Shown to merchant today | ADR-057 locked |
| --- | --- |
| Starter ₹999 / 100 min | Starter ₹2,499 / 357 min |
| Pro ₹3,999 / 500 min | Growth ₹12,999 / 1,500 min |
| Enterprise "Unlimited call minutes" | Scale, volume-negotiated |

`getPlanLimit()` (`billing.tsx:20-27`) is the *only* place a plan's minute allowance exists in the
entire codebase — a `switch` statement in a React component, defaulting unknown plans to 500
minutes. `orgs.planName` (`database/schema.ts:74`) is free-text with no constraint, so the plan a
merchant is on and the entitlement that plan carries are connected by a client-side string
comparison and nothing else.

"Unlimited call minutes" on Enterprise is an unbounded liability written into the product UI.

**Fix:** plan definitions move server-side as the single source of truth (§4). `billing.tsx`
renders what the API returns and hardcodes nothing.

### 0.2 GST is missing from the locked economics — **P1**

ADR-057 quotes ₹2,499 without stating whether that is inclusive or exclusive of the 18% GST on
domestic SaaS. It materially changes the answer:

| ₹2,499 Starter | Net revenue | Worst-case COGS (357 × ₹4) | Gross margin |
| --- | --- | --- | --- |
| GST-**exclusive** (₹2,499 + ₹450) | ₹2,499 | ₹1,428 | **43%** (as ADR-057 claims) |
| GST-**inclusive** | ₹2,118 | ₹1,428 | **33%** |

**Recommendation:** all India prices are **GST-exclusive**, displayed as "₹2,499 + GST". This is
normal for B2B India (the merchant claims input credit, so it costs them nothing real) and it is
the only reading under which ADR-057's published margin range is true. If prices are ever made
GST-inclusive, ADR-057's margin table must be reissued.

Global ($) pricing under a Merchant-of-Record (§6) is tax-inclusive-handled-by-MoR — no equivalent
issue, but the MoR fee is a real 4%+ haircut that ADR-057's margin math also omits.

### 0.3 The current usage number is not billable — **P1**

`computeUsage()` (`voice/org-queries.ts:423-444`) computes minutes as `endedAt − startedAt`.
`startedAt` is set at row creation, i.e. at **dial**, not at answer — and there is no `answeredAt`
column anywhere in `database/schema.ts`. So today's "minutes used" includes ring time on calls that
were never answered.

For the Shopify cart-recovery vertical — where most dials go unanswered — this metric is wrong in
both directions at once: it would overcharge the merchant for calls that never happened, and it
overstates COGS in internal models. It also silently counts failed and cancelled calls.

**No plan, quota, cap, or invoice in this document is enforceable until a billable-seconds
definition is persisted per call.** That is the actual prerequisite, and it is §1.

---

## 1. The unit — definition of a billable minute

**Sold unit: answered minutes.** (Confirms ADR-057 §1; adds the definition it lacked.)

### 1.1 Billable vs non-billable

A call is billable **only if it was answered by a human or voicemail and the media stream
connected.** Concretely, billable requires: `answeredAt IS NOT NULL` **and**
`billableSeconds >= 5`.

Never billable:

| Case | Why |
| --- | --- |
| `no-answer`, `busy`, `failed`, `canceled` | no conversation happened; carrier mostly doesn't charge us either |
| answered but media never connected (`billableSeconds < 5`) | our failure, not their usage |
| calls placed while `callingWindowTestModeUntil` is active | founder demo minutes (`schema.ts:115`) — must not become an invoice line |
| calls the platform ended via force-end from admin ops | our intervention |
| calls where `providerFailoverCount > 0` **and** the call ended abnormally | our outage; a *successful* failover is still billable |

Every non-billable call still writes a usage row with a `billingExcludedReason`, so exclusions are
auditable rather than invisible. This matters the first time a pilot merchant disputes an invoice.

### 1.2 Rounding — and why it differs by telephony arrangement

Rounding must mirror how *we* are billed, or short calls destroy the margin. Indian carriers
(Exotel, Twilio India) bill in 60-second pulses. STT/TTS/LLM bill per second or per character.

| Arrangement | Rounding | Rationale |
| --- | --- | --- |
| **BYO telephony** (merchant's own Exotel/Twilio account) | round up to next **6 seconds** | we carry no per-minute carrier floor — only per-second AI cost. Fine-grained billing costs us nothing. |
| **Weeber-provisioned number** | round up to next **60 seconds**, minimum 1 minute | we eat a full carrier pulse on a 20-second call; billing 0.33 min would be a real loss on cart-recovery volume |

This is worth stating on the pricing page, not hiding: *"Bring your own number and we bill you by
the 6 seconds instead of by the minute."* It is a genuine, costless-to-us reason for a merchant to
BYO, and BYO is already the India default assumption in ADR-057 §4.

### 1.3 Source of truth for duration

Prefer the **provider-reported duration** (Twilio `CallDuration`, Plivo `duration`, Exotel
`ConversationDuration`) over our own `endedAt − answeredAt`, because that is what we get invoiced
on. Persist both plus which one was used — when they disagree by more than ~2s on a meaningful
share of calls, that discrepancy is itself the signal that something in call teardown is wrong.

### 1.4 Voice tier attribution

Each call is stamped `voiceTier = "standard" | "premium"` at finalize, derived from the TTS
provider actually used (ElevenLabs ⇒ premium; Sarvam/Cartesia ⇒ standard). Premium minutes are
metered on a **separate counter** from standard minutes — a plan's included minutes are standard
minutes only, and premium consumption bills at base + surcharge (ADR-057 §2). Without per-call
tier attribution the split-rate decision is unenforceable, which is exactly the state ADR-057's
final caveat admits to.

---

## 2. Hybrid commercial structure

Locked tier prices from ADR-057 are unchanged. Everything below is the missing scaffolding around
them.

### 2.1 India (₹, all prices **+ GST**)

| Offer | Price | Included (standard minutes) | Overage / rate | Premium voice | Concurrency |
| --- | --- | --- | --- | --- | --- |
| **Trial** | ₹0, 14 days | 15 min | hard stop, no overage | blocked | 1 |
| **PAYG** (no subscription) | ₹0/mo | none — wallet only | **₹12/min** | +₹10/min | 2 |
| **Starter** | ₹2,499/mo *(locked)* | 357 min | ₹8/min | +₹8-10/min | 2 |
| **Growth** | ₹12,999/mo *(locked)* | 1,500 min | ₹8/min | +₹8/min | 8 |
| **Scale** | custom | negotiated | flat negotiated | negotiated | negotiated |

Design notes:

- **PAYG at ₹12/min is deliberately worse than Starter's ₹7/min effective rate.** PAYG exists to
  remove the "I don't want to commit to a subscription" objection and to price experimentation,
  not to be the cheap door. If PAYG undercuts the plan, nobody subscribes and revenue becomes
  unforecastable.
- **Trial is 15 minutes, not 14 days of unlimited.** At ₹1.2-4/min COGS, 15 minutes costs us
  ₹18-60 to hand a stranger. A time-boxed unlimited trial is an uncapped spend hole with no
  payment method on file — the same F1 problem wearing a marketing hat.
- **Premium voice is plan-gated *and* surcharged.** Trial and PAYG cannot select ElevenLabs at all
  (no payment guarantee behind an ₹11-13/min COGS). Starter and above can, at the surcharge. Gating
  needs a server-side check on agent-config save; today the UI merely discloses the cost and
  nothing blocks it.
- **Weeber-provisioned telephony is a surcharge, not a discount.** ADR-057 §4 already assumes BYO
  for India, so the locked prices are the BYO prices. Orgs that want us to supply the number pay
  **+₹1.5/min** (covers ~₹0.65-1.2/min carrier plus 60-second pulse rounding) plus the number's
  monthly rental at cost. Framing this as a "BYO discount" would mean quietly cutting the locked
  prices for the default case.

### 2.2 Top-up packs and auto-recharge (India)

| Pack | Price | Standard minutes @ ₹8 |
| --- | --- | --- |
| Small | ₹1,000 | 125 |
| Medium | ₹5,000 | 625 |
| Large | **₹15,000** | 1,875 |

**₹15,000 is not a round number — it is the RBI AFA-free recurring-debit ceiling** (§3.2). Capping
the largest auto-recharge pack there means an automatic top-up never triggers an OTP, and therefore
never fails silently at 2am. A merchant wanting more buys two packs.

Wallet credit is denominated in **currency, not minutes** (₹5,000 of credit, not "625 minutes"), so
that a premium-voice or bundled-telephony call can draw the correct amount from the same balance
without a second unit. The dashboard displays "≈ N minutes at your current rate" for comprehension.

Credit expires **12 months** from purchase. Unused credit is not refundable to cash (state this in
terms before selling any).

### 2.3 Global ($, MoR-inclusive)

| Offer | Price | Included | Overage | Premium | Top-ups |
| --- | --- | --- | --- | --- | --- |
| **Trial** | $0, 14 days | 20 min | hard stop | blocked | — |
| **PAYG** | $0/mo | wallet only | **$0.15/min** | +$0.08/min | $20 / $50 / $150 |
| **Starter** | $79/mo *(locked)* | 790 min | $0.10/min | +$0.08/min | same |
| **Growth** | $499/mo *(locked)* | 3,500 min | $0.10/min | bundled (ADR-057 notes headroom) | same |
| **Scale** | custom | negotiated | negotiated | negotiated | — |

No RBI constraints apply to non-Indian cards, so auto-recharge can fire on a true low-balance
threshold. Global overage is all-inclusive of telephony (ADR-057 §4) — Weeber provisions the number
by default here.

### 2.4 Consumption order

Strict precedence, evaluated per finalized call:

1. Plan **included** standard minutes for the current period.
2. Wallet **credit** balance.
3. If `autoRechargeEnabled` and a valid mandate exists → attempt recharge (§3.2), which cannot be
   instantaneous in India.
4. If no credit and no successful recharge → **hard stop** (§3.1).

Premium minutes and bundled-telephony surcharge always draw from step 2 onward — never from
included minutes, which are defined as standard-stack minutes only.

---

## 3. Enforcement — this is the part that closes audit F1

Pricing without enforcement is a spreadsheet. Today the *only* control on spend is
`voice/middleware/rate-limit.ts` at 30 calls/min/org ≈ 1,800 calls/hour/org, with no daily cap, no
monthly cap, no concurrency limit (`rg maxConcurrent|MAX_CONCURRENT|concurrency` → zero hits) and
no alerting.

### 3.1 Four ceilings, in order of how much they save you

1. **Per-org concurrency cap** (2 / 8 / negotiated, per §2.1). Cheapest and most effective single
   control: it bounds the *rate* at which any bug or abuse can spend, independent of billing state.
   Enforced at dispatch in `voice/workflows/scheduler.ts` by counting live calls for the org.
2. **Per-org balance hard stop.** Outbound dialling halts when included minutes and wallet credit
   are both exhausted. **Inbound keeps answering** — cutting a merchant's inbound support line over
   ₹200 of credit is a churn event, not a collections strategy; inbound is also naturally bounded
   by their own customers' behaviour. Inbound overdraft is capped at 60 minutes negative, then
   inbound stops too.
3. **Per-org daily minute cap**, defaulting to `2 × (includedMinutes / 30)`. A merchant with a
   funded wallet and a broken workflow can still burn the whole wallet in an hour; the daily cap is
   what turns a catastrophe into a ticket. Merchant-adjustable upward within their plan, logged.
4. **Platform-wide daily spend kill switch**, env-configured, using the existing per-call
   `estimatedCostCents` from `voice/cost-estimate.ts`. The backstop for a failure mode that spans
   orgs. `cost-estimate.ts` is display-only today; summing it into a rolling daily aggregate is a
   small change with a large downside removed.

### 3.2 Auto-recharge under RBI — the constraint that shapes the design

India's e-mandate framework requires a **pre-debit notification at least 24 hours before every
recurring debit**, and permits AFA-free recurring debits only **up to ₹15,000 per transaction**
(sources: Razorpay UPI Autopay documentation; RBI e-mandate framework coverage, 2026). The same
24-hour rule applies to UPI Autopay and card e-mandates alike.

**Consequence: "auto-recharge when the wallet hits zero" cannot exist in India.** By the time the
balance is zero, the earliest legal debit is tomorrow.

So auto-recharge must be **predictive**:

- Trigger when `walletBalance < 2 × (trailing 7-day mean daily burn)` — i.e. roughly two days of
  runway left, not zero.
- On trigger: send the pre-debit notification, schedule the debit at T+25h, and mark the wallet
  `rechargePending`.
- Do not re-trigger while a recharge is pending (idempotency on a single pending recharge per org).
- If the debit fails, retry once at T+24h with a fresh notification, then disable auto-recharge and
  email. Never retry in a tight loop against a card that is declining.
- Cap auto-recharge at ₹15,000 per debit and at **3 recharges per calendar month** by default —
  otherwise auto-recharge becomes its own unbounded-spend vector, which is F1 again with a friendly
  name.
- New orgs have no trailing burn history: use the plan's included-minutes-per-day as the estimate
  for the first 7 days.

Orgs that decline a mandate get manual top-ups with reminder emails at 50% / 80% / 95% of balance.
This will be a meaningful share of Indian SMBs, so manual top-up is a first-class path, not a
fallback.

### 3.3 Alerting

`voice/call-health.ts` already classifies `silent-failure` / `degraded` and persists it, and the
only consumer is an admin list view (audit F13). Repeat that mistake with spend and you will find
out about a runaway bill from a bank statement. Every ceiling above must emit: merchant email at
80% and 100%, and an internal alert (Sentry/ops channel) on any hard stop, any failed auto-recharge,
and any platform-wide-cap breach.

---

## 4. Data model (proposal — no migration written)

Six new tables. Names indicative; `orgs.planName` stays for display but stops being the source of
entitlement.

| Table | Purpose | Key columns |
| --- | --- | --- |
| `plans` | server-side entitlement, seeded not user-editable | `code`, `geo`, `currency`, `priceMinor`, `includedStandardMinutes`, `overageRateMinorPerMin`, `premiumSurchargeMinorPerMin`, `allowedTtsProviders[]`, `concurrencyLimit`, `dailyMinuteCap`, `telephonySurchargeMinorPerMin` |
| `subscriptions` | which plan an org is on, and its period | `orgId`, `planCode`, `status`, `currentPeriodStart/End`, `gateway`, `gatewaySubscriptionId`, `cancelAtPeriodEnd` |
| `usage_events` | append-only meter, one row per call | `orgId`, `callId` **UNIQUE**, `answeredAt`, `billableSeconds`, `voiceTier`, `rateSnapshotMinor`, `amountMinor`, `fundedFrom` (`included`/`wallet`/`overage`), `billingExcludedReason`, `createdAt` |
| `wallets` | credit balance + recharge config | `orgId`, `balanceMinor`, `currency`, `autoRechargeEnabled`, `autoRechargeAmountMinor`, `mandateId`, `rechargePendingUntil`, `monthlyRechargeCount` |
| `wallet_transactions` | every balance movement | `walletId`, `type` (`topup`/`debit`/`refund`/`adjustment`/`expiry`), `amountMinor`, `gatewayPaymentId`, `idempotencyKey` **UNIQUE**, `createdAt` |
| `spend_limits` | per-org overrides of §3.1 | `orgId`, `dailyMinuteCap`, `monthlyMinorCap`, `concurrencyLimit`, `updatedBy` |

Non-negotiable properties:

- **`usage_events.callId` is unique.** Call finalization can be retried by a provider webhook; a
  meter that double-bills on retry is worse than no meter. Same for
  `wallet_transactions.idempotencyKey` against gateway webhook replay.
- **The ledger is append-only.** Balance is a materialized column reconciled against the sum of
  transactions by a periodic job that alerts on drift. Never a mutable number with no audit trail.
- **All money is integer minor units** (paise, cents) with an explicit currency. No floats.
  `cost-estimate.ts` returns a float today, which is fine for a display estimate and must not leak
  into the ledger.
- **New `calls` columns:** `answeredAt`, `billableSeconds`, `providerReportedSeconds`,
  `durationSource`, `voiceTier`. `answeredAt` is the one that unblocks everything.
- Metering runs at **call finalize**, in the same path that already computes `estimatedCostCents`.
  Enforcement reads a cached per-org counter, not a `SUM()` over `usage_events` on every dial.

---

## 5. What we bill vs what we spend — keep them separate

`voice/cost-estimate.ts` is our **cost** model (what providers charge us). `usage_events` is our
**revenue** model (what we charge the merchant). They must never be the same number or derived from
each other. Two different questions, two different consumers: cost feeds margin dashboards and the
platform kill switch, revenue feeds invoices.

Both should be visible side by side internally per org, because the metric that actually matters
pre-pilot is **realized gross margin per org**, and ADR-057 explicitly can't tell you that — it
assumes a 2.5-minute average call length that has never been measured. The first pilot's real
average call duration is the number that either confirms or breaks the whole locked tier structure.

---

## 6. Payment rails — answering the Razorpay + Dodo question

**Razorpay for India, Dodo for international: yes, and for the right reasons.** Stripe is closed to
you as an Indian entity, Razorpay is the only serious domestic option for UPI/RuPay/net-banking plus
mandates, and Dodo as Merchant-of-Record means ADLOOM X does not need a foreign entity or VAT/sales-
tax registrations to sell globally. That last point is the real value and it is worth the fee.

The costs of that choice, stated plainly:

- **Two integrations, two webhook models, two subscription state machines, two refund flows, two
  reconciliation jobs — pre-revenue.** That is the actual price, not the percentage.
- **Dodo is ~4% + $0.40.** On a $79 Starter that is ~$3.56, an effective **4.5%**, straight off a
  49% gross margin → ~46.5%. ADR-057's global margin table does not include it. Razorpay domestic
  is ~2% + GST on the fee.
- **Dodo is a young company holding your money as MoR.** Fine at pilot scale; re-evaluate before it
  is material revenue. Have a stated fallback (Paddle) rather than discovering you need one.

The architectural rule that makes this survivable:

> **Weeber's ledger is the source of truth. Gateways are dumb charge executors behind one
> interface.**

Do not use Razorpay Subscriptions' or Dodo's own usage-based/metered-billing features. If you meter
in two vendors' systems you own two irreconcilable answers to "how many minutes did this org use",
and switching provider becomes a data migration. Meter internally; call the gateway only to (a)
charge a fixed plan amount on a schedule, (b) charge a fixed top-up amount, (c) set up and debit a
mandate. Three verbs. That is what the `gateway: null` placeholder in
`voice/org-queries.ts:442` should grow into.

Sequencing: **Razorpay first, Dodo when the first non-Indian customer is actually in the pipeline.**
Building both now doubles the surface with no revenue on either side.

---

## 7. Open questions I can't answer from the repo

1. **Is ADLOOM X GST-registered, and above the ₹20L threshold?** Determines whether GST is charged
   from day one or from crossing the threshold, and whether input credit on provider invoices
   (Sarvam, Twilio, OpenAI) is claimable — that credit is a real few percent of COGS.
2. **Do the ADR-057 rates assume Sarvam's startup-program credits?** Those credits make early
   margin look better than steady-state. If the ₹1.2/min Sarvam figure is credit-subsidized, the
   post-credit number is the one that belongs in a financial model.
3. **What is the real average call duration?** Every plan's minute allowance is derived from a
   2.5-minute assumption that has never been measured. If cart-recovery calls average 45 seconds,
   357 minutes is ~475 calls, not ~140, and Starter is underpriced per outcome delivered.
4. **Refund policy on unused wallet credit** — needed in terms of service before selling a single
   top-up, and it interacts with MoR rules on the global side.
5. **Does the first pilot get billed at all?** A free pilot is a legitimate choice, but it must be a
   choice with an end date and a spend cap, not an absence of billing infrastructure.

---

## 8. Recommended sequence

Ordered by risk removed per unit of work, not by product appeal.

| # | Work | Why it's here |
| --- | --- | --- |
| 1 | `calls.answeredAt` + `billableSeconds` + `voiceTier` at finalize | nothing else is possible without it; also fixes the wrong number in today's dashboard |
| 2 | Per-org **concurrency cap** + platform daily kill switch | closes the worst of F1 with no billing system at all. Do this even if pilots are free. |
| 3 | `plans` table + delete `getPlanLimit()` from `billing.tsx` | stops the product contradicting ADR-057; makes entitlement server-side |
| 4 | `usage_events` ledger (metering only, no charging) | start accumulating real usage data before you need to bill on it. Answers Q3. |
| 5 | Razorpay: plan subscription + one-off top-up | first real money |
| 6 | Wallet + hard stop + 50/80/95% alerts | overage becomes safe to allow |
| 7 | Predictive auto-recharge with mandates (§3.2) | most complex, most regulated — last |
| 8 | Dodo + global tiers | only when a non-Indian customer exists |

Steps 1-2 are worth doing regardless of whether you charge anyone this quarter. Steps 3-4 are the
ones that make ADR-057 true instead of aspirational.

---

**Not decided by this doc.** ADR-057 remains the locked pricing. If this structure is accepted, it
needs its own ADR recording: GST-exclusive pricing, the billable-minute definition, the hybrid
PAYG/top-up layer, the four ceilings, and Razorpay-then-Dodo — since each of those is a decision
ADR-057 explicitly left open.
