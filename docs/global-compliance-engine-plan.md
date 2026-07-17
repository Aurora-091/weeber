# Global Compliance Engine — Priority Plan (India + US + EU)

> **STATUS (2026-07-16, later same day): Tier 0 — DONE.** All 6 items below are built, tested, and
> verified (typecheck clean across all 3 packages, lint 0/0, `bun run test` 363 pass / 0 fail — was
> 353 before this pass, +10 new tests, build succeeds). See "Tier 0 — build report" section at the
> end of this doc for exactly what shipped, what was deliberately deferred, and the file map — read
> that before re-doing any of this work in a future session. Tiers 1-3 below are unchanged, still
> not started.

Status: Tier 0 built (see report at end). Tier 1-3: PLAN — awaiting go-ahead to build.
Date: 2026-07-16
Builds on: the user-provided India Compliance Fix Plan (an uploaded reference doc, not committed to
this repo — India-specific phases, still the critical path for any India
launch) and the tradeoff analysis from this session (jurisdiction-pack architecture, per-regime
differences table). This doc reframes that analysis as an ordered backlog: what to fix now because
it's cheap and reduces real risk, what to gate behind an actual India/US/EU launch, and what to
deliberately defer until you have enough customers that the cost of not having it exceeds the cost
of building it.

**How items are scored:** Effort (S = hours, M = 1-3 days, L = 3-8 days, XL = 1-2+ weeks) × Impact
(risk-if-skipped: a real legal/financial exposure vs. a hygiene/quality improvement) × **Scale gate**
(the customer-count point where deferring it stops being reasonable). Sorted within each tier by
Effort ascending — do the cheap ones in a tier first.

---

## Tier 0 — Do now, regardless of scale (cheap, real risk today)

These reduce actual legal exposure or fix a real architectural inconsistency, cost little, and don't
depend on how many customers you have — the risk exists at customer #1.

| # | Item | Effort | Impact | Status | Why now |
|---|---|---|---|---|---|
| 1 | Close `BYPASS_COMPLIANCE` in prod (env + request-body variant) | S | **High** | ✅ Done | A client-supplied flag that disables every legal gate is live today. Zero customers doesn't reduce this risk — one bad request is enough. |
| 2 | Store disclosure text + version per call | S | Med | ✅ Done | Cheap audit-trail improvement; you can't prove what was said without it, and it costs almost nothing to add now vs. retrofitting after calls have already happened without it. |
| 3 | Localize disclosure text per call language (Hindi draft already written last round) | S | Med | ✅ Done (Hindi draft still needs human sign-off before real calls) | Same file, same change window as #2 — bundling these is nearly free. |
| 4 | Refactor `calling-window.ts`'s hardcoded India/NANP branch into the jurisdiction-pack shape | M | **High (structural)** | ✅ Done | This is the fork in the road: every day you don't do this, calling-window logic and any future EU/US addition gets bolted on as another if/else instead of a pack. Structural only — no new legal surface, just makes items below additive instead of compounding complexity. Do this *before* Tier 1's US/EU work, not after. |
| 5 | Enforce mini-TCPA per-state variance (FL/OK/WA: 8pm cutoff not 9pm; max-3-attempts/24h cap) | M | **High** | ✅ Done 2026-07-17 — window-hours + Florida FTSA attempt-cap both enforced (see `voice/compliance/attempt-cap.ts`, wired into `workflows/scheduler.ts`'s `dispatchScheduledCall`) | This is a real, current gap independent of any "global" ambition — if you ever place a single US call today, this is already wrong. Not gated by customer count at all. |
| 6 | Consent ledger, Phase 1 from the India plan (`consent_records` table, purpose-scoped, withdrawal wiring) | L | **High** | ✅ Foundation done — not yet wired into any real dial-time route (see report) | Foundational for every other jurisdiction too — DPDP purpose-limitation, TCPA's "prior express consent," and GDPR's consent-as-one-of-6-lawful-bases all need a real per-purpose consent record, not a single boolean. Building it once, generically, now avoids building an India-only version and reworking it for US/EU later. |

**Tier 0 total effort estimate: ~6-10 dev-days.** Recommended order: 1 → 2+3 (same sitting) → 4 → 5 → 6. Items 1-3 are the "afternoon" work already scoped as India Plan Phase 0 — doing them generically (not India-only) costs nothing extra since the code paths are shared.

---

## Tier 1 — Before you take a paying customer in that specific market

Gate: **the first real customer/pilot in that market**, not a fixed count. Don't build the US pack
before you have a US customer in the pipeline; don't build DLT/number-series before an India launch
that actually dials India numbers commercially.

| # | Item | Effort | Impact | Gate |
|---|---|---|---|---|
| 7 | India Phase 2 — DLT/number-series (`call_purpose`, 140/160 pools, DLT-scrub adapter) | L | **High** | First India outbound-calling customer. No Western equivalent exists — this is the actual legal gate for India, not optional hygiene. |
| 8 | US pack — formal TCPA consent-standard baseline (build to the *stricter* reading given the current Fifth Circuit/FCC split) + wire into the jurisdiction-pack resolver from #4 | M | **High** | First US customer. The consent standard is legally unsettled right now (Feb 2026 circuit ruling) — build conservative rather than wait for it to settle; the downside of over-collecting consent is small, the downside of a TCPA violation is $500-1,500/call. |
| 9 | EU pack — formalize existing GDPR retention/erasure + AI-disclosure work into the pack interface, add a lawful-basis concept alongside pure consent | M | Med | First EU customer. Lowest-lift of the three packs since most of the underlying mechanism already exists; mainly a refactor into the shared interface plus adding "contract"/"legitimate interest" as valid bases, not just consent. |
| 10 | Retention split: minimal proof-of-consent record kept long (7yr, India requirement) vs. underlying call data on the shorter GDPR-minimization clock | M | **High** | Needed the moment you have both an India customer (wants 7yr consent proof) and a GDPR-subject customer (wants short retention) — these directly conflict without this split, so build it before you have both, not after a complaint. |
| 11 | India Phase 5 — one real live call through Exotel + Plivo, end-to-end compliance test, exportable audit pack | M | **High** | Before India launch, full stop — this is the "does it actually work on a real call" gate, not a nice-to-have. |
| 12 | Explicit recipient-country field (Shopify shipping country / clinic intake form) as the primary jurisdiction signal, phone-prefix as fallback only | S | Med | Before US/EU launch specifically — phone-prefix detection alone is a known-weak signal (ported numbers, VOIP, diaspora); cheap to add if you already capture this data from the vertical's own intake flow. |

**Not a single blob of work** — each row only triggers when that market's first real customer is imminent. Doing #7 before an India customer exists, or #8 before a US one, is effort spent on a market that isn't real yet.

---

## Tier 2 — Defer until ~50+ customers

Gate: **~50 customers**, or the first enterprise-shaped deal (whichever comes first) — the point
where manual/ad-hoc handling of these starts actually costing more than building them.

| # | Item | Effort | Impact | Why deferrable to here |
|---|---|---|---|---|
| 13 | India Phase 3 — reputation hygiene (per-number rate limits, exponential backoff, velocity metrics dashboard) | M | Med | At low volume, a single number getting flagged is a manageable, individually-fixable incident. At 50+ customers dialing at real volume, it becomes a systemic risk worth a dashboard rather than manual monitoring. |
| 14 | India Phase 4 — data residency enforcement (India-region storage for recordings/PII) | M | Med-High | Genuinely needed for enterprise/health/insurance deals specifically (as flagged before), which correlates with scale, not a fixed date. A handful of early customers can likely be handled with a documented data-flow answer; enforcing region-pinned storage infrastructure is worth the build once it's blocking real deals. |
| 15 | Legal review of the actual jurisdiction-pack rules per market (real outside counsel, not engineering judgment) | L (cost, not dev-time) | **High** | Worth the spend once you have paying customers whose contracts/liability actually depend on it — spending real legal budget pre-revenue on a plan that might still change with customer feedback is premature; not spending it once you have 50+ paying customers across markets is negligent. |
| 16 | Jurisdiction-conflict resolution for orgs operating in multiple markets simultaneously (an org with both India and US customers, strictest-wins merge logic actually exercised, not just designed) | M | Med | The *design* from #4/#8/#9 should already support this; actually needing it in practice — a single org with customers in 2+ jurisdictions at once — is a scale-correlated event, not urgent for a single-market pilot. |

---

## Tier 3 — Defer until ~1000+ customers / true multi-market scale

Gate: **~1000 customers**, or operating as a real multi-market platform (not "India + one US pilot"),
whichever comes first. Building these earlier is optimizing for a scale you don't have yet, at the
cost of time you could spend on the product itself.

| # | Item | Effort | Impact | Why this late |
|---|---|---|---|---|
| 17 | Formal DLT PE/TM registration as first-class managed infrastructure (vs. today's "BYO, documented as a user responsibility") | XL | Med | Worth automating only once enough India customers are hand-holding through this manually that the ops cost of doing it per-customer exceeds building self-serve infra for it. |
| 18 | Redundant/multi-provider compliance data paths (e.g., DND-scrub via more than one source, cross-checked) | L | Med | A single well-chosen DND-scrub source is fine until volume is high enough that a single provider's downtime/staleness becomes a real dial-time risk, not a theoretical one. |
| 19 | Dedicated compliance monitoring/alerting product surface (real-time dashboard: consent coverage %, DND-scrub freshness, calling-window violations attempted-and-blocked, per-jurisdiction audit-pack export volume) | L | Med | At low customer counts this is "look at the logs when something seems off." Worth a dedicated surface once there's enough traffic that a human can't reasonably eyeball it. |
| 20 | Per-jurisdiction dedicated legal counsel retained on an ongoing basis (vs. a one-time review from Tier 2) | XL (cost) | **High**, but only once you're actually there | Ongoing counsel is an operating cost that only makes sense once you're a real multi-market business with regulatory exposure at real dollar volume — retaining this at 10 customers is spending scale-appropriate money on a business that isn't at that scale yet. |
| 21 | Formal SOC2/ISO27001-style certification covering the compliance engine itself (as a sellable trust signal, not just internal practice) | XL | Med (mostly a sales enabler at this point, not a legal necessity) | This becomes a genuine deal-closer once enterprise buyers are actually asking for it at volume — before that it's a cost center with no attached revenue signal. |

---

## Summary — what to actually do next

**This week (Tier 0, ~6-10 dev-days):** close the bypass footgun, store+localize disclosure, refactor
`calling-window.ts` into the jurisdiction-pack shape, fix the mini-TCPA state gaps, build the
consent ledger generically (not India-only). This is the highest-leverage set — cheap, reduces real
risk that already exists today, and is the prerequisite for everything in Tier 1.

**Per-market, as each market's first real customer approaches (Tier 1):** build that market's pack
(India DLT, US TCPA-conservative, EU lawful-basis) only when that market is actually about to go
live — not all three at once speculatively.

**At ~50 customers or first enterprise deal (Tier 2):** reputation hygiene, data residency
enforcement, and a real legal review spend become worth it.

**At ~1000 customers or true multi-market operation (Tier 3):** managed DLT infra, redundant
compliance data paths, a dedicated monitoring surface, retained counsel, and formal certifications —
all genuinely premature before this point, don't build them early out of anxiety.

Tier 0 is done — see the build report below before starting Tier 1. Tiers 1-3 are still the ordered
backlog awaiting go-ahead.

---

## Tier 0 — build report (2026-07-16, same day as the plan above)

Read this before touching any of Tier 0's items again — everything below is built, tested, and
verified. Re-doing it from scratch would be redundant; extending it (e.g. wiring the consent ledger
into a real Shopify route, or building the attempt-cap enforcement) is Tier 1/next-session work, not
a re-build of what's here.

### What shipped

**#1 — `BYPASS_COMPLIANCE` hardened.** `packages/api/src/voice/routes.ts`'s `/calls/outbound`:
the request-body `bypassCompliance` flag is never honored, in any environment (previously any
caller could disable every legal gate on their own request). The env var itself is hard-disabled
whenever `NODE_ENV === "production"`, regardless of its value. Outside production it still works
for local testing, same as before. Tests: `routes.test.ts`, new `describe("Voice routes -
BYPASS_COMPLIANCE hardening")` block, 4 tests.

**#2/#3 — disclosure text + version, per call, per language.** `packages/openvent-compliance/src/
consent.ts` rewritten: new `DISCLOSURE_VERSION` constant, `DISCLOSURE_TEXT_BY_LANGUAGE` map (`en`
+ a draft `hi` Hinglish line — Devanagari script, English loanwords kept in Latin per this
codebase's existing convention, **still needs human review before it's ever spoken on a real
call**), `normalizeLanguageTag()` (handles `hi-IN` → `hi`), and `resolveDisclosure(options)`
returning `{text, version}` — the single source of truth `getDisclosureLine`/`withDisclosure` both
now delegate to. `packages/api/src/voice/agent.ts`'s `ResolvedAgentConfig` gained
`disclosureText`/`disclosureVersion`, populated in every code path that builds one (the
org+template branch, `buildPreviewAgentConfig`, and both no-config fallback branches — the
fallback paths have no language signal available so they resolve to the English default, which is
unchanged prior behavior, not a regression). `packages/api/src/database/schema.ts`'s `calls` table
gained `disclosure_text`/`disclosure_version` columns (migration `0030_add_call_disclosure_
fields.sql`). `packages/api/src/voice/stream.ts` persists both, fire-and-forget, the moment
`agentConfig` resolves (same pattern as the existing `sttReconnectCount` update). Tests:
`consent.test.ts` (new, 11 tests) + typecheck (fixed a real `noUncheckedIndexedAccess` issue in
`normalizeLanguageTag` along the way).

**#4 — jurisdiction-pack refactor.** `calling-window.ts` used to hardcode the India-vs-NANP branch
directly in one function. Split into `packs/types.ts` (shared `CallingWindowResult`/
`CallingWindowOptions`/`getHourInTimezone`), `packs/india.ts` (`checkIndiaCallingWindow`,
`isIndianNumber`), and `packs/us.ts` (`checkUsCallingWindow` + the area-code/timezone map).
`calling-window.ts` is now a ~30-line resolver that picks a pack and delegates — same exported
function name/signature/return shape as before, so every existing caller (`workflows/
scheduler.ts`, `voice/routes.ts`, this package's own `checkOutboundCallCompliance`) needed zero
changes. All 9 pre-existing `calling-window.test.ts` tests pass unchanged, confirming the refactor
is behavior-preserving. Adding a future jurisdiction (EU, etc) is now a new pack file + one
resolver branch, not another if/else.

**#5 — mini-TCPA state overrides, partial.** Done: Florida/Oklahoma/Washington area codes (a
partial, extend-as-needed map, same convention as the timezone map) now cap the calling window at
8pm local instead of the federal 9pm baseline, inside `packs/us.ts`. An explicit `endHour` option
still overrides it. Tests: `packs/us.test.ts` (new, 6 tests). **NOT done, flagged not silently
skipped:** Florida's FTSA max-3-attempts-per-24h cap. This needs a call-history lookup (has this
number been dialed N times in the last 24h) — a stateful, DB-backed check that doesn't fit this
pack's pure-function shape. Belongs in `workflows/scheduler.ts`'s dispatch path, alongside the
existing per-recipient `scheduledCalls.attempt` tracking. Left for a future session rather than
rushed — see "Deliberately not done" below.

**#6 — consent ledger, foundation.** Built generically (not India-only), per the earlier decision.
`packages/openvent-compliance/src/storage.ts`: new `ConsentPurpose` type (`service` |
`transactional` | `marketing` | `underwriting` | `feedback`), `ConsentRecord` type, and
`ConsentStorageAdapter` interface (`hasConsent`/`grant`/`withdraw`/`listForPrincipal`) — mirrors
`DncStorageAdapter`'s shape exactly. `adapters/memory.ts`: `createMemoryConsentAdapter()` reference
implementation. `index.ts`: `checkOutboundCallCompliance` gained a new **optional** 4th param,
`consentCheck?: {adapter, purpose}` — omitting it keeps today's DNC+calling-window-only behavior
unchanged (verified by a dedicated test); passing it adds a consent gate with its own
`failedCheck: "consent"` result, checked *after* DNC (DNC still has zero bypass, verified by a
dedicated test proving DNC blocks even when consent is separately satisfied). `packages/api`:
`database/schema.ts` gained a `consent_records` table (org-scoped, purpose-scoped, indexed on
`(org_id, data_principal, purpose)`, migration `0031_add_consent_records.sql`) —
**deliberately NOT wired into `gdpr.ts`'s purge sweep**, since its 7-year retention requirement
directly conflicts with GDPR's data-minimization pull on the underlying call data; they're two
separate retention clocks on purpose (see Tier 1 #10 above — still not implemented, this doc entry
is just confirming the schema-level separation is already correct). `voice/compliance/adapters.ts`:
new `createConsentAdapterForOrg(orgId)` **factory** (not a single shared instance like `dncAdapter`
— the package's interface is intentionally org-agnostic, but this app's consent data is genuinely
per-org, so the org-scoping happens at this call site, not in the package). Tests:
`index.test.ts` (+11 consent-ledger tests in the compliance package) and a new
`consent-adapter.test.ts` (+6 tests) in the API package, exercising real org-isolation (a grant
for org-a never satisfies org-b's check).

### Deliberately not done (Tier 1-shaped, not skipped by accident)

- **Attempt-cap enforcement** (part of #5) — **DONE 2026-07-17.** `voice/compliance/attempt-cap.ts`'s
  `checkFtsaAttemptCap` counts real dial attempts to a recipient (from `calls.startedAt`, across
  every workflow/trigger, not just one) in the last rolling 24h and blocks a 4th for a Florida
  number, wired into `dispatchScheduledCall` alongside the existing DNC/calling-window/insurance
  gates — covers both the automatic sweep and the manual "call now" button (they share this one
  function). A blocked attempt defers 6h rather than failing permanently, since the cap resolves
  on its own as the 24h window rolls forward. 7 new tests (`attempt-cap.test.ts`).
- **Wiring the consent ledger into any real dial-time route** (part of #6) — the ledger, adapter,
  and the opt-in check in `checkOutboundCallCompliance` all exist and are tested, but no existing
  Shopify/COD/cart-recovery route passes a `consentCheck` yet. Doing that requires deciding which
  `ConsentPurpose` each existing workflow trigger actually is (cart recovery = `marketing`, COD
  confirmation = `transactional`, etc) — a product/business classification decision, not something
  to guess silently while wiring code. Flagged for Tier 1, not done here.
- **Backfilling `shopifyContacts.marketingConsent` into `consent_records`** (documented as a TODO
  directly in the schema comment) — a one-time data migration, separate from this schema change.
  Do this before wiring any real `hasConsent('marketing')` check into a live Shopify workflow, or
  every already-consented contact would look unconsented.
- **The Hindi disclosure line is a draft**, not yet human-approved for real calls — see #2/#3
  above.

### Verification (run fresh at the end of this session, not carried over from memory)

- `bun run typecheck` — clean, all 3 packages.
- `bun run lint` (oxlint) — 0 warnings, 0 errors, 323 files.
- `packages/openvent-compliance`: `bun test --isolate src/` — 62 pass / 0 fail (was 26 before this
  session's additions — consent.test.ts, packs/us.test.ts, and the new consent-ledger tests in
  index.test.ts).
- `packages/api`: `bun run test` (the package's real script, `bun test --isolate src/`) — 363 pass
  / 0 fail (was 353 before this session — routes.test.ts's 4 new BYPASS_COMPLIANCE tests +
  consent-adapter.test.ts's 6 new tests).
- `bun run build` — succeeds, all dist assets emitted.

### File map

- `packages/openvent-compliance/src/consent.ts` — rewritten (disclosure versioning + localization).
- `packages/openvent-compliance/src/consent.test.ts` — new.
- `packages/openvent-compliance/src/calling-window.ts` — rewritten as a thin resolver.
- `packages/openvent-compliance/src/packs/types.ts` — new (shared pack types).
- `packages/openvent-compliance/src/packs/india.ts` — new (extracted from calling-window.ts).
- `packages/openvent-compliance/src/packs/us.ts` — new (extracted + mini-TCPA additions).
- `packages/openvent-compliance/src/packs/us.test.ts` — new.
- `packages/openvent-compliance/src/storage.ts` — added `ConsentPurpose`/`ConsentRecord`/
  `ConsentStorageAdapter`.
- `packages/openvent-compliance/src/adapters/memory.ts` — added `createMemoryConsentAdapter`.
- `packages/openvent-compliance/src/index.ts` — added the optional `consentCheck` param to
  `checkOutboundCallCompliance`, new `"consent"` failedCheck variant.
- `packages/openvent-compliance/src/index.test.ts` — +11 consent-ledger tests.
- `packages/api/src/voice/routes.ts` — `BYPASS_COMPLIANCE` hardening.
- `packages/api/src/voice/routes.test.ts` — +4 tests.
- `packages/api/src/voice/agent.ts` — `ResolvedAgentConfig` + all construction sites.
- `packages/api/src/voice/stream.ts` — persists disclosure fields per call.
- `packages/api/src/database/schema.ts` — `calls.disclosureText`/`disclosureVersion`,
  new `consentRecords` table.
- `packages/api/drizzle/0030_add_call_disclosure_fields.sql` — new migration.
- `packages/api/drizzle/0031_add_consent_records.sql` — new migration.
- `packages/api/src/voice/compliance/adapters.ts` — added `createConsentAdapterForOrg`.
- `packages/api/src/voice/compliance/consent-adapter.test.ts` — new, 6 tests.

