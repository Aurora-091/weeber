# Insurance Vertical — Regulatory Reference (India + US)

Single source of truth for the regulatory guardrails every insurance agent prompt (`04` through `08`)
cites — pulled out so a law changing means updating one file, not five inconsistently. Researched
2026-07-16, current as of that date; this space moves fast (see the "Known regulatory flux" note at
the end) — re-verify before relying on this for a real launch decision, same discipline as every
other compliance doc in this repo (`consent.ts`, `hipaa.ts`, `docs/global-compliance-engine-plan.md`).

Every insurance agent's hard line, unchanged: **qualify → educate generically → transfer/book. Never
quote, recommend a carrier/plan, underwrite, or collect regulated data.** Everything below is the
*why*, cited specifically, plus what each fact actually changes about the scripts or the platform.

---

## India — IRDAI

| Rule | What it actually requires | What it changes here |
|---|---|---|
| **IRDAI (Protection of Policyholders' Interests) Regulations** (2017, consolidated into simplified Master Circulars as of 2025) | Insurers/intermediaries must not mis-sell, must give policyholders accurate information, agents must be licensed and follow a code of conduct | This is the existing "IRDAI reserves advice/sale to licensed persons" line already in every script — confirmed current, not outdated |
| **Distance Marketing Guidelines for Insurance** | Insurers must **live-monitor at least 1% of telemarketing calls** and **verify at least 3% of calls that lead to a sale** | A platform/ops requirement, not a script-wording change — flagged as a known gap below, since nothing in this codebase samples/flags calls for QA review today |
| **TRAI's 1600-series mandate for IRDAI-regulated entities** (deadline Feb 15, 2026, per TRAI/IRDAI joint direction) | Every insurer's service/transactional call must originate from a dedicated **1600-series** number — this is *insurance-specific*, separate from the general 140 (promotional)/160 (transactional) series the rest of the platform's number-routing work (`docs/global-compliance-engine-plan.md` Tier 2/India plan) was scoped around | **Real platform gap, not yet built**: the existing/planned number-series routing (`orgPhoneNumbers.call_purpose`) has no `1600` series concept at all. An insurance org dialing on a generic 160-series number today would be **out of compliance** the moment this mandate is enforced. Needs its own line item — see "Platform gaps" below. |
| **2026 mis-selling reform (draft, in progress)** | Tags every intermediary-sold policy to its actual seller; forces commission disclosure | Not yet finalized — don't build against a draft, but the `crmSync`/audit-trail pattern already in every script (logging who called, what was said) is directionally aligned with where this is heading |
| **POSP (Point of Sale Person)** | A lighter-licensing intermediary tier that may solicit/sell specific simple products | Doesn't apply to any of our 5 agents — every one explicitly refuses to sell/quote, so POSP's lighter bar is irrelevant; flagging only so nobody mistakes "POSP-lite" as a loophole for the agent itself |

## US — Federal + state

| Rule | What it actually requires | What it changes here |
|---|---|---|
| **State producer licensing** (NAIC-tracked, state insurance departments) | A person soliciting/selling insurance must be licensed **in the state where the prospect resides** | **Real gap, not yet built**: every script here already refuses to solicit/sell itself and routes to "a licensed advisor" — but nothing in the platform verifies that the advisor being transferred to is *actually licensed in the lead's state*. A warm transfer to an advisor unlicensed in that state would still be a real violation, even though the AI agent itself never quoted anything. See "Platform gaps" below. |
| **NAIC Unfair Trade Practices Act (Model #880)** | Prohibits misrepresentation, false advertising, unfair discrimination — and separately, most states have a **replacement regulation** governing how an agent may discuss replacing an existing policy (mandatory disclosures/warnings, since replacement is a classic mis-selling risk) | **New guardrail needed**: none of the 5 scripts explicitly call out "replacement" as its own regulated topic today — it's implicitly covered by "no advice," but replacement specifically deserves its own named refusal line, since it's the single most litigated topic in this space. Added below. |
| **TCPA — AI/robocall consent standard** | Prior express consent required for AI-generated/prerecorded voice calls to wireless numbers for telemarketing. **The exact standard (oral vs. written) is genuinely unsettled right now** — a Fifth Circuit ruling (Feb 2026) rejected the FCC's "prior express *written*" consent requirement, while other sources describe written consent as becoming mandatory mid-2026. Real regulatory flux, not settled law. | Matches the Global Compliance Engine's existing stance (`docs/global-compliance-engine-plan.md` Tier 1 #8): build to the *stricter* reading (treat as if written proof matters) until this actually settles — the downside of over-collecting consent is small, the downside of guessing wrong is not. |
| **Call-recording consent — one-party vs. all-party states** | ~13 US states require **all-party consent** to record a call, not just a one-party notice | The existing disclosure ("this call may be recorded") is a *notice*, which satisfies one-party-consent states outright; whether it also satisfies all-party-consent states depends on whether continuing the call after notice counts as consent in that state — genuinely state-dependent, not a single answer. Flagged as a known gap, not resolved by wording alone. |
| **California AB 2905** (effective Jan 1, 2025) | Requires **upfront** disclosure that the caller is speaking with an AI, specifically — $500 penalty per undisclosed AI call | Already satisfied by the existing "at the very start of the call, before anything else" disclosure requirement (`consent.ts`'s `withDisclosure`) — confirmed compatible, no change needed here. |
| **HIPAA** (health insurance specifically) | Applies when a covered entity or business associate discusses PHI — a claim's medical details, a health condition tied to underwriting, etc. | None of the 5 agents discuss health specifics today (guardrails already say "no health details beyond what's on file" / "never collect detailed health history") — correctly scoped to avoid touching PHI at all, rather than trying to be HIPAA-compliant while touching it. Keep this boundary, don't loosen it to make a script "more helpful." |

---

## New guardrail added to every script (04-08): the "replacement" refusal

Distinct from the existing generic "no advice" line — replacement of an existing policy is
specifically regulated (NAIC Model #880 + most states' own replacement regulations) and is a named,
high-risk topic on its own, not just a subset of "advice." Every script's guardrails section now
includes:

> **Never discuss replacing, switching, or cancelling in favor of a different policy — this is a
> specifically regulated topic (NAIC replacement rules), not just general advice.** If raised:
> *"That's a decision your licensed advisor needs to walk you through properly — let me connect you
> so it's done right."* Flag it (`flagGuardrailEvent`), same as any other regulated topic.

## Platform gaps found during this research

> **STATUS (2026-07-16, later same day): #1 and #2 — BUILT.** Both were pre-launch blockers (the
> India+US launch is happening simultaneously, no calls placed yet as of this writing) — see
> "Platform gaps #1/#2 — build report" at the end of this doc for exactly what shipped. #3 and #4
> remain flagged, not built — see the acceptance notes below for why they're correctly deferred.

1. ~~**India: no 1600-series number-routing exists.**~~ **Built** — see build report. The
   number-series work scoped so far (`orgPhoneNumbers.call_purpose`, 140/160) doesn't cover
   insurance's separate 1600-series mandate. An insurance org going live in India on a generic
   160-series number is a real compliance gap the moment this is enforced (Feb 15, 2026 deadline,
   per TRAI/IRDAI — already passed as of this writing).
2. ~~**US: no producer-state-licensing check exists.**~~ **Built** — see build report. Every script
   routes to "a licensed advisor," but nothing verified that advisor is licensed in the *lead's*
   state before transferring or booking. For a multi-state agency, this was a real, previously-
   unenforced requirement.
3. **No call-monitoring/sampling exists** for India's 1%-live-monitor / 3%-verify-on-sale
   requirement — an operational/QA feature, not a script change. Correctly deferred: this is
   satisfiable manually today via existing recordings/transcripts, doesn't block launch.
4. **All-party-consent-state nuance is unresolved** — the current single disclosure line may or may
   not be sufficient in every US state depending on how "continuing the call after notice" is
   treated locally; needs actual legal confirmation per state before a serious US insurance launch,
   not just a wording tweak.

None of these four are fixed by this pass — they're platform/ops work, correctly out of scope for a
prompt-content iteration, and are being recorded here so they don't get lost the way "known gaps"
elsewhere in this repo are tracked (see `docs/global-compliance-engine-plan.md`'s own Tier 1/2 items).

## Known regulatory flux (re-verify before a real launch, don't treat this doc as permanently current)

- TCPA's AI-consent standard (written vs. oral) is actively contested in court as of this writing.
- India's IRDAI mis-selling/commission reform is a draft, not final law, as of this writing.
- Colorado's AI Act (2026) may classify voice AI as "high-risk," which could add obligations beyond
  what's captured here — not yet researched in depth for this vertical specifically.

---

## Platform gaps #1/#2 — build report (2026-07-16, same day)

Both built as dial-time gates, not mid-call tool checks — simpler, and matches the existing
DNC/calling-window architecture exactly: wired into both `workflows/scheduler.ts`'s
`dispatchScheduledCall` and `voice/routes.ts`'s manual `/calls/outbound` endpoint, the same two
places DNC/calling-window already run, so a scheduled retry and a manual call go through identical
gates. Both gates are no-ops for any non-insurance org.

**#1 — India 1600-series.** New `orgPhoneNumbers.numberSeries` column (`"140" | "160" | "1600"`,
nullable). `checkInsuranceNumberSeriesCompliance(orgId, toNumber)` in new file
`voice/compliance/insurance-gates.ts`: no-op unless the org is insurance-vertical *and* the
recipient is an Indian number; then requires at least one active phone number registered as
1600-series, or blocks with a clear reason. Merchant UI: a series dropdown per number on the
existing numbers page (`app/numbers.tsx`) via a new `PATCH /api/app/numbers/:id/series` endpoint —
any org can set this (harmless for non-insurance orgs), only insurance-vertical orgs are actually
gated on it.

**#2 — US producer-state licensing.** New `insurance_advisors` table (`orgId`, `name`, `npn`
nullable, `licensedStates` jsonb array, `linesOfAuthority` nullable, `source` enum `"manual" |
"nipr"`, `lastVerifiedAt` nullable) — deliberately shaped to accept a future NIPR integration
without a schema change (see "Why NIPR, not build-from-scratch" below), but ships today as a
manual-entry MVP with zero external dependency. `checkInsuranceProducerLicensing(orgId, toNumber)`:
no-op unless insurance-vertical *and* a NANP (+1) number; resolves the lead's state from a new,
partial `AREA_CODE_STATE` map (`@openvent/compliance`'s `packs/us.ts`, ~230 area codes across all
50 states + DC — broader than the existing 3-state mini-TCPA map, still explicitly best-effort,
same "known-weak-signal" caveat as everywhere else phone-number-based jurisdiction inference is
used in this codebase) and checks it against any advisor's `licensedStates` for that org. An
unresolved state **fails open** (allows the call) rather than blocking — blocking every call to an
unrecognized area code would be far more disruptive than the risk being guarded against, matching
`checkUsCallingWindow`'s own existing philosophy for unresolved area codes. Merchant UI: a
"Licensed advisors" section in `app/settings.tsx`'s Compliance area (only rendered for
insurance-vertical orgs) — add/remove an advisor with a comma-separated state list, backed by new
`GET/POST /api/app/insurance-advisors` + `DELETE /api/app/insurance-advisors/:id` endpoints.

**Why NIPR, not build-from-scratch (research, not assumption):** NIPR (National Insurance Producer
Registry) is the actual industry-standard source every compliance vendor in this space —
AgentSync, Sircon (Vertafore), TrustLayer — wraps around; none of them have their own independent
license data, they're all UI/workflow layers over NIPR's Producer Database (PDB). Real-time lookup
by NPN (National Producer Number), pricing found around $0.25/producer/month or $1.30/report — not
enterprise-exclusive. Not integrated in this pass (no NIPR subscriber credentials available), but
the schema (`npn`, `source`, `lastVerifiedAt` columns) is shaped so that upgrade is a new adapter
file + a background sync job later, not a schema migration — the same "opt-in extension point,
existing behavior unchanged" pattern as the Global Compliance Engine's `ConsentStorageAdapter`.

**Tests**: `insurance-gates.test.ts` (new, 12 tests) — both gates' no-op conditions, block
conditions, and the fails-open-on-unresolved-state behavior for #2.

**Verified**: typecheck clean (3/3 packages), oxlint 0/0, `bun run test` 382 pass / 0 fail (was
370, +12), build succeeds.

**Not done, correctly out of scope for this pass:** the actual NIPR API integration (needs real
subscriber credentials you don't have yet — ask if/when you want to pursue it), and per-specific-
advisor call routing (today's check is org-level — "does ANY advisor for this org cover this
state" — not "does the specific advisor `orgs.humanTransferNumber` would actually connect to cover
it," since that's a single number per org today, matching the existing granularity of that field).
