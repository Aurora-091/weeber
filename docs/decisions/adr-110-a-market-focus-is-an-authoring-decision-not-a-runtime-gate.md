# ADR-110 — A market focus is an authoring decision, not a runtime gate

- **Date:** 2026-08-13
- **Status:** Accepted (implemented 2026-08-13, allow-and-warn only)

## Context

The product has been described, out loud and in the plan documents, as *"insurance is the US
market, Shopify is the India market."* That sentence is true about what has been **written** —
and it had no representation anywhere in the codebase. The question this ADR answers is not
whether the sentence is true. It is **what kind of thing** the sentence is, and therefore what
the runtime is allowed to do with it.

What is actually true in the repo, verified rather than recalled:

- `orgs.vertical` is `text("vertical").notNull().default("shopify")` (`schema.ts:86`). There is
  **no DB-level enum and no check constraint**. Only `PATCH /api/app/settings`
  (`app/routes.ts:336`) validates the pair `["shopify", "insurance"]`;
  `agentTemplates.vertical` is written unvalidated at `voice/admin-routes.ts:360`
  (`vertical: vertical.trim()`). So an unrecognised vertical string is reachable.
- **Both** org-insert paths omit `vertical` entirely and take the DB default `"shopify"`:
  `app/routes.ts:117` (signup) and `integrations/shopify/routes.ts:138` (Shopify install).
  Every org that has ever existed got its vertical from a column default, not from a choice.
- There is **no `market` axis at all.** ADR-095 proposed `orgs.market` and was never
  implemented; grep the schema and the only `market` is `shopifyContacts.marketingConsent`.
  Market, wherever it is used today, is inferred from the **callee's E.164 prefix** — which was
  ADR-095's own complaint about the status quo.

And the reason ADR-095 was written is worth restating because it is the reason it should *stay*
unimplemented for now: the only evidence the codebase had about "market" was the callee country
code, and all 11 all-time rows in `calls` were internal test calls placed from a **US** Twilio
number to **+91** numbers by an India-based team. Inferring market from that data returns
nonsense. But the fix for "the inference is bad" is not automatically "add a column" — it can
equally be "stop making the inference load-bearing."

Which is the actual finding here. Nothing in the runtime needs to know the market. The gates
that *do* need to know something about geography already resolve it themselves, from the
destination, independently:

| Gate | Keys off | shopify → US | insurance → +91 |
| --- | --- | --- | --- |
| DNC | destination, always, no bypass | runs | runs |
| Calling window | destination timezone | runs (US pack) | runs (India 9–21 IST) |
| FTSA attempt cap | **Florida area code** | runs | no-op (not NANP) |
| Insurance 1600-series | vertical + India destination | vertical no-op | **refuses** unless test mode |
| Insurance producer licensing | vertical + US destination | vertical no-op | US-only no-op |
| India DLT series | destination, behind a feature flag | flag off ⇒ off | flag off ⇒ off |

A market column would not have changed a single row of that table.

**One correction to the record, per ADR-078, entered here as a new dated statement rather than
by editing an earlier paragraph:** in working up to this decision I claimed the FTSA attempt cap
was "an insurance-only gate and therefore a no-op for Shopify." That is **wrong**.
`checkFtsaAttemptCap` is called **unconditionally** in `runOutboundGates` and is scoped by
**Florida area code**, not by vertical. A shopify-vertical call to a Florida number is capped
exactly like an insurance one. The genuinely insurance-scoped gates are the two named above
(1600-series, producer licensing). The framing that shopify→US is "the least-gated path" was
overstated: it runs DNC, the US calling window, and the FTSA cap.

## Decision

**Record the coupling as a documented authoring/GTM fact, and enforce it only as telemetry.**

New `packages/api/src/voice/compliance/market-alignment.ts`:

- `AUTHORED_MARKET_BY_VERTICAL = { insurance: "us", shopify: "india" }`, typed
  `Partial<Record<string, Market>>` **on purpose**. A vertical with no entry yields
  `unknown-vertical`, never a default. Given that `orgs.vertical` has no DB constraint and both
  insert paths rely on a column default, a map that silently defaulted would be asserting a
  market nobody chose — the same class of mistake as inferring market from a test-call prefix.
- `resolveCalleeMarket(e164)` → `"india" | "us" | "unknown"` from the prefix. It returns
  `unknown` for everything that is neither `+91` nor NANP rather than folding the rest of the
  world into `"us"` the way `checkCallingWindow` does. That fold is *correct* for a calling
  window — some window has to be picked — and wrong here, because calling a German number a
  US-market call would invent the very fact this module exists to report.
- `checkVerticalMarketAlignment(vertical, toNumber)` — **pure**, unlike every other file in
  that directory, which is what lets the dial path and a future read model share one rule
  instead of two copies. Returns `aligned`, or one of `market-mismatch` /
  `unknown-callee-market` / `unknown-vertical` with a one-line human message.
- `warnOnMarketMisalignment(...)` — the side effect, kept separate so the decision stays
  testable without capturing console output.

Wiring, in `outbound-gate.ts`: a private `noteMarketAlignment(orgId, to)` runs **only on the
allowed path** of `assertOutboundCallAllowed`, after every gate has passed, and **its return
value is discarded**. `runOutboundGates` — which owns the fail-closed decision — is deliberately
untouched. Best-effort by construction, same discipline as `expiredTestModeHint`: every failure
is swallowed, because a telemetry read must never convert an allowed call into a refusal.

Cost is one PK-indexed select per allowed dial. That is **dial-time, not turn-time** — not on
the voice hot path ADR-100/-107 measure. It is deliberately *not* folded into the insurance
gates' existing `vertical` read: those gates are legal enforcement and this is telemetry, and
sharing a query would couple a thing that may be deleted to a thing that may not.

`console.warn`, **not** a `guardrail_events` row. A row implies the product refused or scrubbed
something; this refused nothing, and ADR-106's `fabricated-outbound-text` rows mean something
strictly stronger. If mismatch volume ever becomes a number worth trending, that is the moment
to persist it — not on zero customers.

## Rejected

**Adding `orgs.market` (ADR-095), which therefore stays `Proposed` and unimplemented.** Nothing
in the request needed a column. Every compliance decision already resolves geography from the
destination; a `market` column would be a second, hand-maintained source of a fact the dial
already carries, and the failure mode of a stale market column is worse than the failure mode of
a prefix inference, because a column looks authoritative. Add it when something actually
branches on it — pricing, currency, or a market-scoped template picker — and not before.

**Making vertical→market a runtime refusal.** This is the one worth spelling out, because it was
the first shape considered. Refusing shopify→US would bolt the door on the largest Shopify
merchant base on earth in order to encode a fact that is only true because we have **zero
customers**. Cart recovery is not India-specific; only COD confirmation is. Such a refusal would
have to be unpicked by the first US store that signs up, and by then it would be load-bearing —
the ADR-090 defect class approached from the other side, shipping enforcement for a constraint
nobody has yet asked for.

It is also the reason the prefix inference is *acceptable here and only here*: ported, VOIP and
diaspora numbers misclassify. That is tolerable for a log line and would be disqualifying for a
gate. If this ever becomes enforcement, the input has to change first.

**Following ADR-098's precedent, deliberately.** An absent fact is not a negative fact. "This
org's vertical was authored for another market" is not a legal finding, so it gets the same
allow-and-warn treatment the empty `insurance_advisors` roster got.

**Blocking insurance→+91 here.** Already handled, and better: the 1600-series gate refuses it
outright unless 24h test mode is on (ADR-108). A second, weaker check on the same destination
would just be noise ahead of a real refusal.

## Consequences

- The sentence "insurance = US, Shopify = India" now exists in exactly one place in code, as a
  map with a comment saying it is a GTM focus and not a constraint. Previously it existed only
  in conversation.
- Every allowed dial outside its vertical's authored market leaves a greppable
  `[compliance] outbound call is outside its vertical's authored market` line with the vertical,
  destination, reason, and a renderable message. Nothing branches on it.
- `checkVerticalMarketAlignment` is pure and exported, so the dashboard can render the same
  sentence the log emits without a second implementation of the rule.
- api tests **1,307 → 1,324**. New `market-alignment.test.ts` (13 tests) asserts the map, the
  prefix resolver's refusal to fold the world into `us`, the `unknown-vertical` path, purity —
  and, on `handoff.test.ts`'s precedent, three **source-text** assertions against
  `outbound-gate.ts` proving this can never refuse a call: `noteMarketAlignment` appears on the
  allowed path, no `market_mismatch` gate exists, it is absent from the `runOutboundGates` slice,
  and it is absent from `TEST_MODE_BYPASSABLE`. Proven non-vacuous twice — commenting out the
  call site fails exactly the allowed-path test (12 pass / 1 fail), and flipping
  `insurance: "us"` to `"india"` fails three (10 pass / 3 fail).
- All six ratchets green, none widened: lint 0/0 (500 files), `knip:gate` 61/61,
  `design:guard` exit 0 (581 remaining, unchanged), `contrast:gate` 33/42 with 9 of 9 declared,
  `persona:gate` OK, `tsc --noEmit` exit 0.

**Known and unfixed.**

- `orgs.vertical` remains an unconstrained `text` column defaulting to `"shopify"`, set by
  neither insert path. Whatever a founder believes their vertical is, a fresh signup is a
  Shopify org until someone opens Settings. This ADR documents that; it does not fix it, and a
  DB-level constraint plus an explicit vertical choice at signup is the honest follow-up.
- The market inference is a prefix test and misclassifies ported, VOIP and diaspora numbers.
  Safe only for as long as nothing enforces on it.
- The insurance templates being US-authored is asserted from reading them, not measured. No
  US insurance call has ever been placed to anyone outside the team; ADR-081's qualify-and-
  warm-transfer boundary is still the only thing standing between the persona and a licensing
  problem, and `insurance_advisors` is still empty (ADR-098, allow-and-warn).
- Mismatches are not persisted, so there is no way to answer "how often does this happen"
  without reading logs. Deliberate at zero customers; revisit when there is traffic.
