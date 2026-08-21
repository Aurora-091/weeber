# Phase E — Market split and scale

**Status:** Blocked on Phase D
**Blocks:** nothing — this is the last phase before pilot
**Preconditions:** Phase D's exit gate met, including the recorded p95.
**Evidence:** `docs/audits/2026-08-21-first-two-production-calls.md` (the `orgs` row and the
US-number-to-`+91` observation)
**Governing ADRs:** **ADR-119** (the market question is asked at onboarding, not inferred) — this phase
implements it; ADR-110 (market inference refused, and the trigger ADR-119 fires); ADR-095 (superseded
by ADR-119)

---

## Why this phase exists

Production has exactly one org: HDFC, `vertical = insurance`, and `country_code`, `timezone`,
`currency` and `plan_name` are **all empty strings**. Both calls dialled `+91` mobiles from a **US**
Twilio number, `+16893584869`.

So the system does not know what market its only customer is in, has never asked, and is routing India
traffic through US telephony. Every product decision that depends on market — which TTS provider, which
currency, which onboarding copy, which templates — is currently resolved by accident or by inference,
and ADR-110 refused inference for good reasons that ADR-119 restates.

This is last because it is the only phase that is genuinely cheaper before customers exist and more
expensive after — the founder's own argument, and the reason ADR-119 exists at all. It is *last* rather
than *first* because splitting the product by market before the product is correct means maintaining two
copies of unfinished behaviour.

---

## The work

### E1. Ask the market question at onboarding

Implements ADR-119 directly. Read that ADR before starting; the constraints in it are not restated here
in full.

**Where:**

- `packages/api/src/database/schema.ts` — add `market` to `orgs`: **nullable, no default**. Nullable is
  the whole point: `NULL` means *not asked*, which is a fact the current empty-string columns cannot
  express.
- The onboarding flow in `packages/web/src/...` and its API route in `packages/api/src/app/`.
- **Both org insert paths.** ADR-110 recorded as a known-unfixed item that both paths take the column
  default for `vertical`; find them (`rg -n "insert(orgs)" packages/api/src`) and make **both**
  `market` and `vertical` explicit onboarding choices. Fixing one path is the bug.
- `packages/api/src/database/seed.ts` — seeded orgs must state their market explicitly too, not inherit
  a default.

**How:**

1. One question at onboarding, answered by a human, stored as given. **Never inferred** — not from the
   callee prefix, not from `AUTHORED_MARKET_BY_VERTICAL`, not from the Twilio number. ADR-119 rejects
   each of those individually and says why.
2. **No backfill.** The single existing org gets `NULL` until a human answers. Dashboards render `NULL`
   as "not asked", never as a market.
3. Validate at the single write path, not with a DB enum — consistent with `orgs.vertical` under
   ADR-110, and deliberate: the failure being prevented is a *fabricated* value, not an unrecognised
   one.
4. `checkVerticalMarketAlignment` stays prefix-based **telemetry** and continues to branch nothing
   (ADR-110). Do not repoint it at `orgs.market` and do not let it gate anything.

**Test:** an org cannot be created without an explicit `market` and `vertical`; a `NULL` market renders
as "not asked"; the seed path sets both explicitly.

---

### E2. The re-ask flow for pre-existing orgs

ADR-119 names this as its own open gap: orgs created before it ships have no prompt to answer the
question, and there is deliberately no backfill.

**Where:** the settings/onboarding surface in `packages/web`, plus wherever org context is loaded for
the dashboard.

**How:** an org with `market = NULL` is prompted — persistently but not blockingly — to answer, in
settings and on the dashboard. It must not be dismissible into permanent silence, because a
never-answered market is exactly the state ADR-119 exists to prevent becoming permanent. It must also
not block calling: an org mid-pilot cannot be locked out by a missing product-surface attribute.

**Test:** an org with `NULL` market sees the prompt; answering clears it; dismissing it does not clear
it permanently.

---

### E3. Market gates product surface — and nothing that can refuse a call

**Where:** `packages/api/src/voice/tts/index.ts` (`resolveTtsProvider` and the Sarvam Indic branch),
currency and pricing surfaces, onboarding copy, template pickers.

**How:** ADR-119 is explicit and this is the line most likely to be crossed by accident. `market` gates
**product surface**: providers offered, currency, payment methods, onboarding copy, template selection.

**No compliance gate keys off `market`.** Every gate in ADR-110's table continues to resolve geography
from the **destination number**, unconditionally. The failure mode of a stale `market` on a compliance
gate is a call that should have been blocked and was not, and that risk is not taken.

One concrete benefit, from ADR-119's consequences: the Indic TTS branch becomes **structurally absent**
for US orgs rather than runtime-avoided — one provider, one confidence scale, which is also the cheapest
version of the cross-provider confidence work.

**Test:** a compliance-gate test asserting the gate's decision is unchanged by `orgs.market`, including
when market and destination disagree.

---

### E4. US replica on Railway

**Where:** deployment config (`start:railway` in `package.json:14`, the Railway project), and the
Supabase region — production is currently `aws-0-ap-northeast-1` via the pooler.

**How:** US orgs served from a US region; India later, as a second step, not simultaneously.

1. Stand the US replica up **before** pointing any org at it, and verify with a test call measured by
   `bun run latency:report` (Phase B) that the region actually helped. Both production calls were
   US-origin to `+91`, so some of the C baseline is transit — this is where that gets isolated rather
   than argued about.
2. `orgs.market` selects the surface; **region is a separate decision** (ADR-119 explicitly rejected
   making the India replica a precondition of the market column). Do not conflate them in
   configuration — an org's market must not silently determine its region, or moving one moves the
   other.
3. Telephony origin is part of this: a US-origin number dialling `+91` is a cost and latency choice that
   should be deliberate per market, and it interacts with the compliance gates in E3, which keep keying
   off destination.

**Test:** deployment smoke test per region, plus a `latency:report` comparison recorded in the commit.

---

### E5. Clean up the empty-string columns

**Where:** `packages/api/src/database/schema.ts` — `orgs.country_code`, `timezone`, `currency`,
`plan_name`.

**How:** all four are `''` in production, which cannot express "not asked" — ADR-119 lists this as a
real inconsistency with the discipline it argues for, and does not fix it. Fix it here: make them
nullable with no default, migrate `''` → `NULL`, and have every reader treat `NULL` as *not asked*
rather than defaulting silently.

Also in this pass, from the audit's smaller items:

- **`calling_window_test_mode_until` expired 2026-08-21 11:10 UTC** and expired silently (ADR-108's
  known behaviour). An expiring bypass should announce its expiry; at minimum it must be visible in the
  dashboard.
- **`consent_records` is empty** despite both calls firing a disclosure
  (`disclosure_version = v2-2026-07-19`). Either the writer is broken or the disclosure is not recorded
  as consent. For an insurance pilot this needs an answer before a paying customer, not after.
- **`orgs.twilio_auth_token` is plaintext at rest** and differs from the env value. Encrypt at rest and
  resolve which of the two is authoritative. Deliberately deferred from Phase A because it touches the
  credential path; it does not get deferred past pilot.

**Test:** a `NULL`-vs-`''` assertion per column, and a test that an expired test-mode window is
surfaced rather than silently lapsing.

---

## Exit gate

```bash
cd /home/user/weeber
bun run latency:report
bun run lint
bun run typecheck
cd packages/api && bun run test && cd ../..
bun run knip:gate
bun run persona:gate
bun run design:guard
bun run contrast:gate
```

Conditions:

1. **No org can be created without an explicit `market` and `vertical`**, on **both** insert paths and
   in the seed.
2. **`orgs.market` is never written by inference.** Asserted by test, and grep-verified: no code path
   derives it from a phone prefix, from `AUTHORED_MARKET_BY_VERTICAL`, or from the Twilio number.
3. **The existing production org is either `NULL` (prompted) or holds a human-supplied value.** It was
   not backfilled.
4. **No compliance gate reads `market`** — asserted by test, including the disagreement case.
5. **A US replica serves US orgs**, with a `latency:report` before/after comparison recorded in the
   closing commit. India replica may remain unstarted; say so.
6. **All four empty-string columns are nullable with `''` migrated to `NULL`**, and `consent_records`
   either has rows for disclosure-firing calls or a written explanation of why disclosure is not consent.
7. `bun run persona:gate` and `knip:gate` pass without widening any baseline.

---

## Explicitly out of scope

- **The India replica.** Second step, after the US one is measured. Named here so it is not forgotten.
- **A DB-level enum or check constraint on `market`.** Rejected in ADR-119.
- **Repointing `checkVerticalMarketAlignment` at `orgs.market`.** It stays prefix-based telemetry per
  ADR-110. The two representations answer different questions — "what we authored" vs "who this customer
  is" — and ADR-119's consequences require any code reading both to say which.
- **Any change to compliance geography resolution.** Destination-based, unconditionally, forever as far
  as this plan is concerned.
- **Multi-currency billing.** `market` selects the currency surface; actual billing is a separate
  project.
