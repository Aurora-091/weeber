# ADR-119 — The market question is asked at onboarding, not inferred

- **Date:** 2026-08-21
- **Status:** Accepted (decision recorded; implementation is Phase E in `docs/plans/phase-e-market-split.md`)
- **Supersedes:** ADR-110's deferral of `orgs.market`, and closes ADR-095 (`Proposed` since 2026-08-11)

## Context

ADR-110 rejected adding `orgs.market` and was right to. Its reasoning is worth restating exactly,
because this ADR agrees with all of it:

> Add it when something actually branches on it — pricing, currency, or a market-scoped template
> picker — and not before.

That was a **trigger condition**, not a permanent refusal. Two things have happened since.

**First, the trigger fired.** The product now needs market to branch three things that ADR-110 did not
have in front of it:

- **Provider set.** US orgs get Cartesia/ElevenLabs and Twilio. They get **no Sarvam, no Hindi, no
  Hinglish** — not "available but unused", *absent*. ADR-060 already rejected mid-call Indic switching;
  this removes the branch entirely for US orgs rather than avoiding it at runtime.
- **Payment methods and currency.** `orgs.currency` and `orgs.plan_name` are both empty strings on the
  only production org (`docs/audits/2026-08-21-first-two-production-calls.md`). Billing cannot be built
  on a fact nobody has.
- **Compliance surface.** Which pack applies is currently resolved per-gate from the destination. That
  is correct for gates and useless for deciding what to *show* an operator at signup.

**Second, the production data confirms ADR-110's own complaint rather than resolving it.** ADR-110
observed that inferring market from callee prefix "returns nonsense" because all traffic was a US Twilio
number dialling `+91` by an India-based team. The first two real calls (2026-08-20) are *exactly that
same shape*. The inference has not gotten better and will not: `orgs.country_code` and `orgs.timezone`
are empty strings, so there is no second source to cross-check against.

So the choice is not "column vs inference". It is **"ask the human, or keep inferring from a prefix that
was already declared nonsense."**

## Decision

**Ask the market at onboarding. Store the answer. Never derive it.**

1. **`orgs.market` is added, `NULL`-able, with no default.** A nullable column with no default is the
   whole point. ADR-098 established that an absent fact is not a negative fact; ADR-112 refused to
   backfill `source` for the same reason. `NULL` here means **"nobody has been asked yet"**, which is
   the truth for every org that exists today.

2. **No backfill. Ever.** The single existing org stays `NULL` until a human answers the question. It
   would be trivial to write `UPDATE orgs SET market = 'india'` based on the `+91` calls and the
   founder's location, and that is precisely the fabrication ADR-110 refused. It would also be **wrong**:
   the org is `vertical = insurance`, which is the US-authored vertical.

3. **Onboarding asks it as a required choice, not a smart default.** No pre-selection from IP, locale,
   phone prefix or vertical. A pre-filled guess that the user clicks past is indistinguishable in the
   database from an answer they gave, which is the failure mode that made `orgs.vertical` unreliable —
   ADR-110 recorded that **both** org-insert paths omit `vertical` and take the column default, so
   "whatever a founder believes their vertical is, a fresh signup is a Shopify org."
   `market` must not repeat that. This ADR therefore also requires that **`vertical` becomes an explicit
   choice in the same onboarding step**, closing ADR-110's own "known and unfixed" item.

4. **Reads fail closed on `NULL`.** A `NULL` market must never resolve to a market. Feature gating on
   `NULL` shows the un-gated union and warns; it does not pick one. Any code that needs a definite market
   and finds `NULL` refuses and says why.

5. **`checkVerticalMarketAlignment` keeps its prefix inference and stays telemetry-only.** It is not
   rewritten to read the new column. ADR-110's reasoning holds unchanged: a prefix test is fine for a log
   line and disqualifying for a gate. When `market` is populated the log line gets *more* informative
   (authored vs declared vs dialled), and still branches nothing.

6. **What this does NOT authorize.** No compliance gate keys off `market`. Every gate named in ADR-110's
   table continues to resolve geography from the destination, unconditionally. `market` gates **product
   surface** — providers offered, currency, payment methods, onboarding copy — and nothing that can
   refuse a call. The failure mode of a stale `market` on a compliance gate is a call that should have
   been blocked and wasn't; that risk is not taken.

## Rejected

**Keeping the deferral.** The honest argument for waiting is "you have 1 org and 2 calls, so build
nothing." But the cost curve is asymmetric and that is the founder's stated concern: adding an
onboarding question when there are zero orgs to migrate is a form; adding it after five pilots means
five customer conversations reconstructing a fact from memory, or a backfill script that fabricates it.
The thing that gets expensive later is not the column, it is **acquiring the fact honestly** — and that
gets strictly harder with every org that signs up unasked. This is the one place where "we are pre-launch
so do it now" is the *conservative* choice.

**Inferring from the callee prefix and letting the operator correct it.** Rejected on ADR-110's own
grounds, reinforced by the audit: a wrong value that looks authoritative is worse than a `NULL`. And an
operator who is never shown the field never corrects it.

**Deriving market from `vertical` via `AUTHORED_MARKET_BY_VERTICAL`.** That map is a *GTM authoring*
fact — "we wrote the insurance templates for the US" — and ADR-110 deliberately typed it
`Partial<Record<...>>` so an unmapped vertical yields `unknown-vertical` rather than a default. Reusing
it as a market source would convert a documented editorial intention into a customer attribute, and
would break the moment a US Shopify store or an Indian insurer signs up. Cart recovery is not
India-specific; ADR-110 already refused to bolt that door.

**A DB-level enum or check constraint on `market`.** Consistent with `orgs.vertical` (unconstrained
`text`, per ADR-110) and deliberately so: the failure this ADR is preventing is a *fabricated* value, not
an *unrecognised* one. Validation belongs at the single write path.

**Making the India replica a precondition.** Region and market are separate decisions — see Phase E.

## Consequences

- The sentence "insurance = US, Shopify = India" now has two distinct representations that must not be
  confused: `AUTHORED_MARKET_BY_VERTICAL` (what we wrote, telemetry only, ADR-110) and `orgs.market`
  (what this customer is, product surface only, this ADR). Any future code reading both must say which
  question it is asking.
- Every org in production is `market = NULL` on the day this ships, including the only one. Dashboards
  must render that as "not asked", never as a market.
- The Indic TTS branch in `resolveTtsProvider` (`tts/index.ts`) becomes **structurally absent** for US
  orgs rather than runtime-avoided, which is also the cheapest version of the cross-provider confidence
  work — one provider, one confidence scale.
- ADR-095 moves from `Proposed` to `Superseded by ADR-119`. It asked for the right column with the wrong
  source (callee country code); this takes the column and changes the source to a human.
- ADR-110 is **not** reversed and its implementation is untouched. This ADR fires the trigger ADR-110
  wrote down. Both are correct in sequence, which is the point of recording triggers instead of verdicts.

**Known and unfixed:**

- Nothing prevents an operator from answering the onboarding question wrong. A declared fact can be
  false; it just cannot be *invented by us*, which is the only property being bought here.
- Orgs created before this ships have no prompt to answer it. There is no backfill *and* no re-ask flow
  designed yet; Phase E owns that and it is the obvious follow-up gap.
- `orgs.country_code`, `timezone`, `currency` and `plan_name` remain empty strings rather than `NULL`, so
  they cannot express "not asked" at all. This ADR does not fix them, and `''` vs `NULL` on those four
  columns is a real inconsistency with the discipline argued above.
