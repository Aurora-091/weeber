# Marketing Pages + Consent/Compliance Settings UI — Plan

> **STATUS (2026-07-16, later same day): BUILT.** Both Part A and Part B shipped — see "Build
> report" at the end of this doc. Verified: typecheck clean (3/3), oxlint 0/0, `bun run test`
> 370 pass / 0 fail (was 363, +7), build succeeds. One item explicitly deferred: the
> insurance vertical marketing copy is a **draft awaiting your sign-off**, not final — see the
> report for exactly what needs review before it's treated as approved.

Status: Built (see report at end).
Date: 2026-07-16
Grounded directly in the current code (`packages/web/src/web/pages/{landing,about,faq,pricing}.tsx`,
`lib/marketing-config.ts`, `components/marketing/MarketingFooter.tsx`, `pages/dashboard/compliance.tsx`,
`pages/dashboard/dnc.tsx`, `pages/app/settings.tsx`), not assumed from memory.

---

## Part A — Marketing pages

### What's already there
Landing, About, FAQ, Pricing pages exist and are genuinely good — About's origin story already
leans hard into the compliance-first narrative ("a $12,000 TCPA lawsuit," "consent enforced at the
infrastructure level, not a disclaimer"). `VERTICALS` covers **Local & service (clinics)** and
**D2C & e-commerce (Shopify)** live today; `UPCOMING_VERTICALS` lists Hotels, Hospitals, Real
estate, Logistics as "coming soon."

### Gaps found (checked against the actual code, not assumed)

| # | Gap | Why it matters |
|---|---|---|
| 1 | **Insurance vertical isn't represented anywhere** — not in `VERTICALS`, not even in `UPCOMING_VERTICALS` | You've now built 8 full agent prompts + insurance-specific compliance guardrails (IRDAI language, licensed-advisor routing) — more engineering investment than either live vertical got, and it's invisible on the site. |
| 2 | **`/privacy` and `/terms` are dead links** — `FOOTER_COLUMNS` links to them (including a `/terms#tcpa` anchor), but no route or page component exists for either in `app.tsx` | Every visitor who clicks "Privacy Policy" or "TCPA Compliance" from the footer hits a 404 today. For a compliance-first brand, that's a specifically bad look. |
| 3 | **About's compliance claim needs a fidelity check, not a rewrite** — "consent enforced at the infrastructure level... you cannot dial a number that hasn't passed the consent gate" was true for DNC before this session, and is now *more* true (purpose-scoped consent ledger shipped) — but still not fully wired into any real dial-time route yet (per the Global Compliance Engine Tier 0 report). Don't let marketing copy claim more than what's live. | Marketing promises need to track actual capability, especially for a compliance-positioned brand — overclaiming here is the exact failure mode the brand story is built against. |
| 4 | **No FAQ content on India/US/global compliance** despite it being the core differentiator | Prospects evaluating this vs. Bolna/Vapi/Retell will ask "how do you handle TCPA/DPDP/DND" — nothing answers that today. |
| 5 | **Pricing has no insurance-specific note** | Insurance is likely a different sales motion (agency/broker seats, not pure self-serve SMB call volume) — worth a decision, not silently forcing insurance into the same 3-tier SMB pricing shape. |

### Recommended changes (ordered, cheap → structural)

1. **Add `/privacy` and `/terms` pages** — real gap, currently broken links, cheapest fix with the
   highest "don't look broken" payoff. Content should state what's *actually* true today: DNC
   enforcement (no bypass), the disclosure requirement (versioned + localized, per this session's
   Tier 0 work), TCPA/TRAI calling-window enforcement, and — written carefully — the consent ledger
   as "how we handle consent" without overclaiming it's wired into every workflow yet.
2. **Add Insurance to `VERTICALS`** (not `UPCOMING_VERTICALS` — it has real, working agent content
   today, arguably more built-out than the other two live verticals). Needs: a headline/problem/
   solution blurb (I'd draft this, but the licensing language needs your sign-off given the
   regulatory sensitivity — same review bar as the agent prompts themselves).
3. **Add a compliance-focused FAQ section** (India DPDP/TRAI + US TCPA/mini-TCPA, in plain language)
   — directly reuses the actual mechanisms you now have, not aspirational copy.
4. **Fidelity-check About's compliance claims** against what Tier 0 actually shipped — likely just
   a small wording tweak (e.g. "every dial is consent- and DNC-checked" only once it's true end to
   end; today it's "DNC-checked, with a consent framework in place" — precise, not lesser).
5. **Pricing — open question, not a default I'll pick**: does insurance get its own pricing note/
   tier, or is it out of scope for the public pricing page until there's a real insurance customer?
   (See question below.)

---

## Part B — Consent Ledger / Compliance Settings UI

### What exists today (checked, not assumed)
- **Admin**: `dashboard/compliance.tsx` — a real, working page: global DNC count/list, guardrail
  events by org, undispositioned-calls audit. Backed by `GET /api/voice/compliance/overview`.
- **Admin**: `dashboard/dnc.tsx` — DNC list management (add/remove/search), the UI pattern to mirror.
- **Merchant**: `app/settings.tsx` already has a `<Section icon={ShieldAlert} title="Compliance">`
  block — today just the calling-window test-mode toggle (self-expiring, per ADR pattern).
- **Nothing exists yet for the consent ledger** — the whole `ConsentStorageAdapter`/`consent_records`
  layer shipped this session has zero UI, and (per the Tier 0 report) zero backend *read* endpoint
  for a UI to call yet either — today's Tier 0 work only built the write/check path (grant, withdraw,
  hasConsent), not a query API.

### What's needed

**New backend work first (not built in Tier 0, a prerequisite for any UI here):**
- `GET /api/voice/compliance/consent?principal=<phone>` (admin) and an org-scoped merchant
  equivalent — list every consent record for a given data principal (mirrors `listForPrincipal`,
  which exists on the adapter but isn't exposed over HTTP yet).
- Optionally: `GET /api/voice/compliance/consent/summary` — aggregate counts per purpose per org,
  for a dashboard stat-card view (mirrors `dashboard/compliance.tsx`'s existing stat-card pattern).

**Admin UI (extend `dashboard/compliance.tsx`, or a new `dashboard/consent.tsx` tab):**
- A consent-records table: data principal, purpose, granted/withdrawn/expired status, version,
  channel, source, timestamps — same list/search shape as `dnc.tsx`.
- Per-org breakdown (since consent is org-scoped, unlike the global DNC list) — likely needs an org
  picker, similar to other admin cross-org views.

**Merchant UI (extend `app/settings.tsx`'s existing Compliance section):**
- A summary view of their own contacts' consent state (e.g. "142 marketing, 38 withdrawn, 12
  underwriting" — purpose-by-purpose counts), not necessarily a full row-by-row ledger — that's
  more useful to an admin auditing the system than a merchant running their store day to day.
- Reference/explainer for the 5 purposes (service/transactional/marketing/underwriting/feedback) so
  a merchant understands what's actually being gated when they see a call blocked with "no consent
  on record."
- **Does NOT need** a disclosure-language picker as a separate control — disclosure language already
  derives from the agent's configured `language` field (Tier 0's `resolveDisclosure({language})`);
  adding a second, separate language toggle would just create a place for the two to drift out of
  sync. Worth confirming this reasoning with you before ruling it out entirely, though (see question
  below).

**Open, still needs your decision (from Tier 0's own deferred list, resurfacing here since it
blocks any UI making sense):** which `ConsentPurpose` applies to which existing workflow/agent
template. Until that's decided, a "142 marketing consents" stat card has nothing real to count from
(no route passes a purpose to the consent check yet). This is the actual prerequisite to sequence
before the UI, not a UI problem itself.

---

## Questions before I build anything from this plan

1. Insurance vertical marketing copy — should I draft the headline/problem/solution blurb for your
   review (same review bar as the agent prompts), or do you want to write/approve the positioning
   language yourself first given the regulatory sensitivity?
2. Pricing page — give insurance its own note/tier, or leave it out of public pricing until there's
   a real insurance customer?
3. Sequencing — backend read-endpoints for the consent ledger first (prerequisite for any UI), or
   do you want to nail down the purpose-classification-per-workflow decision first, since the UI is
   fairly pointless without real data flowing into it?
4. Priority between Part A (marketing) and Part B (consent UI) — same sitting, or one first?

---

## Build report (2026-07-16, same day as the plan)

Defaults picked (you said "yes" to starting with sensible defaults rather than answering all 4
questions first): draft the insurance copy (flagged for review, below), leave insurance out of
public pricing for now, build backend read-endpoints first without inventing purpose
classifications, do both Part A and Part B in one pass.

### Part B — shipped

**New backend read endpoints** (the actual prerequisite Tier 0 didn't build):
- `GET /api/voice/compliance/consent?principal=<e164>&orgId=<optional>` (admin) — every consent
  record for a data principal, queried directly against `consent_records` (same pattern as
  `/compliance/overview` querying `doNotCall` directly, not through the org-scoped
  `createConsentAdapterForOrg` factory, since this is a cross-org admin surface).
- `GET /api/voice/compliance/consent/summary` (admin) — active/withdrawn counts per org per
  purpose. "Active" uses the exact same semantics as `ConsentStorageAdapter.hasConsent` (granted,
  not withdrawn, not expired) — deliberately kept in sync rather than a simpler-but-wrong
  "just count granted rows" query.
- `GET /api/app/compliance/consent-summary` (merchant, org-scoped via `userOrgId`) — same
  bucketing, scoped to the merchant's own org only.
- 7 new tests in `admin-routes.test.ts` (auth gates, validation, list happy-path, and 3 tests
  specifically on the summary bucketing math: active grant counted, withdrawn grant excluded from
  active, expired-but-not-withdrawn grant excluded from active).

**Admin UI** — `dashboard/compliance.tsx` gained a "Consent Ledger" section: summary cards (active
counts per org per purpose) plus a search-by-phone-number box that lists every record found
(purpose, channel, source, granted/withdrawn/expiry timestamps, active/withdrawn/expired badge) —
same list-row visual pattern as the existing "Recent Global DNC Additions" panel.

**Merchant UI** — `app/settings.tsx`'s existing Compliance section (the one with the calling-window
test-mode toggle) gained a "Consent on file" sub-section: active/withdrawn counts per purpose for
the merchant's own org, with a one-line explainer that consent is purpose-scoped (marketing consent
doesn't cover underwriting, etc).

**Still true, not solved by this pass (flagged in Tier 0, still open):** none of this UI has real
data to show yet, because no existing workflow/route passes a `purpose` into the consent check —
the summary endpoints will correctly show zero records until that classification decision is made
and wired in. This was flagged as the real prerequisite in the plan above and remains true after
shipping the UI around it.

### Part A — shipped

- **`/privacy` and `/terms` pages now exist** (`pages/privacy.tsx`, `pages/terms.tsx`, routed in
  `app.tsx`) — the footer's links to them, including `/terms#tcpa`, are no longer dead. Content
  describes what's actually true today (DNC/calling-window always enforced, purpose-scoped consent
  ledger real but being rolled out per-workflow, not a blanket "every call is consent-checked"
  claim) — written with the same "don't overclaim" discipline as the compliance code's own comments
  (`consent.ts`, `hipaa.ts`). Explicitly flagged in both pages as good-faith descriptions, not a
  substitute for legal review.
- **Fixed a real overclaim, found while grounding the plan**: `marketing-config.ts`'s
  `HOW_IT_WORKS` step 1 and the FAQ's "How does consent work?" both said *"every number is checked
  against your consent records before a call goes out"* — true for the Do-Not-Call check (always
  enforced, no exceptions, verified in code), but not yet true for the purpose-scoped consent
  ledger (opt-in, not wired into any route yet, per the Tier 0 report). Tightened both to
  distinguish "DNC — always checked, no exceptions" from "purpose-scoped consent — real
  infrastructure, being rolled out." Added a new FAQ entry on calling-hour enforcement
  (TCPA baseline + FL/OK/WA mini-TCPA + TRAI) since that's a real, concrete answer now.
  Same fidelity tweak applied to `about.tsx`'s origin-story paragraph (Do-Not-Call + calling-window,
  not a vaguer "consent gate").
- **Insurance vertical added to `VERTICALS`** — ***DRAFT, needs your sign-off before treating as
  final*** (flagged inline in the code comment too). Replaced the previous generic "Enterprise /
  regulated teams" slot rather than adding a 4th grid column (the landing page's vertical grid is
  hard-coded to 3 columns, `md:grid-cols-3`) — Insurance has real, built-out content behind it (8
  agent prompts) where "Enterprise" was a placeholder. Note: the 3rd vertical card's "Talk to us"
  button is hardcoded by array index (`i === 2`) to open the existing `EnterpriseDialog` — that
  dialog's own copy ("Enterprise inquiry," "our enterprise team") is generic enough to not be
  actively wrong for an insurance inquiry, but wasn't renamed as part of this pass; flag if you want
  it retitled.

### Verification
- `bun run typecheck` — clean, 3/3 packages.
- `bun run lint` (oxlint) — 0 warnings, 0 errors, 325 files.
- `packages/api`: `bun run test` — 370 pass / 0 fail (was 363, +7 new consent-endpoint tests).
- `bun run build` — succeeds, all dist assets emitted.

### File map
- `packages/api/src/voice/admin-routes.ts` — 2 new consent read endpoints.
- `packages/api/src/voice/admin-routes.test.ts` — +7 tests.
- `packages/api/src/app/routes.ts` — 1 new merchant consent-summary endpoint.
- `packages/web/src/web/pages/dashboard/compliance.tsx` — Consent Ledger section.
- `packages/web/src/web/pages/app/settings.tsx` — Consent-on-file sub-section.
- `packages/web/src/web/pages/privacy.tsx` — new.
- `packages/web/src/web/pages/terms.tsx` — new.
- `packages/web/src/web/app.tsx` — routes for `/privacy`, `/terms`.
- `packages/web/src/web/lib/marketing-config.ts` — Insurance vertical (draft), HOW_IT_WORKS +
  FAQ consent-claim fidelity fixes, new calling-hours FAQ entry.
- `packages/web/src/web/pages/about.tsx` — origin-story fidelity fix.
