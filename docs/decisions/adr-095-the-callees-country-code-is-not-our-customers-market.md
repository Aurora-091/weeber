# ADR-095: The callee's country code is not our customer's market

- Status: Proposed
- Date: 2026-08-10
- Supersedes: none
- Amends: none
- Related: ADR-031 (vertical-agnostic seam), ADR-060 (Indic smart provider
  default, mid-call switching rejected), ADR-072 (a provider contract is what
  the server accepts), ADR-086/ADR-091 (template visibility), ADR-093 (a
  vertical switch left the old vertical's agents live)
- Source: `audit/2026-08-10-audit-15-the-market-is-a-column-nobody-reads.md`
  (F1, F2, F5, F9)

## Context

Weeber has a first-class **vertical** axis. `orgs.vertical` drives which
templates an org sees, which metrics the dashboard renders, which terminology it
uses, and which compliance gates fire — and ADR-031 made adding a vertical a
data change rather than a code change. That seam works. ADR-093 even taught it to
clean up after itself when an org switches.

It has no equivalent for **market**. And market is now doing real work in every
decision document while existing nowhere in code:

- `agent-frame.ts:53`, in a comment on `RECOMMENDED_LANGUAGES`: *"India-first
  list since that's the primary market."*
- `pricing-lock-2026-07-18.md` decision #3, locked: *"Geo-differentiated pricing
  — India and Global are separate plans, not a currency toggle"* — two tier
  tables (₹2,499/₹12,999 vs $79/$499), two pricing pages, different compliance
  framing per market.
- `docs/agent-prompts/09-insurance-final-expense-qualifier-agent.md`: *"US,
  English-only… unlike the 04–08 insurance agents, which are bilingual EN/HI for
  the India+US launch."*

Three market-scoped decisions, expressed in a code comment, a strategy doc, and a
prompt-authoring doc respectively. No runtime reads any of them.

### What exists, and what reads it

`orgs` carries `country_code`, `currency`, `timezone`. Every consumer:

| site | what it does with them |
| --- | --- |
| `app/routes.ts:257-258`, `:369-370` | echoes them in `GET /me` |
| `app/routes.ts:311` | accepts them in `PATCH /api/app/settings` |
| `voice/org-queries.ts` | selects them into a result object |
| `web/pages/app/settings.tsx:64` | renders the form, defaulting `countryCode` to `"IN"` |

**Zero reads under `packages/api/src/voice/`.** The only hits in that directory
are `listAvailableNumbers(orgId, countryCode, …)`
(`twilio-provisioning.ts:198`, `admin-routes.ts:192`), which is a Twilio number
*search filter*, unrelated to the org's market. `orgs.currency` never reaches a
prompt either — `workflows/variables.ts` reads `context.currency` off the
workflow payload (Shopify's cart currency), not the org's.

They are write-only columns. In production, 3 of 4 orgs have all three NULL.

### What decides jurisdiction instead

`packages/weeber-compliance/src/calling-window.ts:30` — `isIndianNumber(e164)`
→ `packs/india.ts` (09:00–21:00 IST, single `Asia/Kolkata` window) if `+91`,
`packs/us.ts` (area-code → state → per-state window) otherwise. The file's own
comment acknowledges the limitation.

**For calling windows this is correct and must not change** — the window is a
statement about the *callee's* local time, so the callee's number is the right
input. The defect is that this single inference is the only market signal in the
system, so it has been silently promoted into decisions it cannot make:

| decision | correct input | current input |
| --- | --- | --- |
| calling window | callee locale | callee prefix — **correct, keep** |
| which regulator's consent/licensing rules bind us | the **business's** regulator | callee prefix |
| which templates an org may enable | the business's market | nothing; all 9 templates are public to all orgs |
| currency in a spoken quote | the business's market | Shopify webhook payload, or nothing |
| default language and STT/TTS provider | the business's market | per-config `language`, NULL on 14/17 rows |
| which pricing plan family applies | the business's market | not implemented |

### The two failures this already causes in production

**Templates leak across markets.** `agent_templates` and `org_agent_configs` have
no `region`/`market`/`jurisdiction` column (verified via `\d`), so a template's
market scope exists only as prose inside `default_persona_prompt`. Result:
`insurance-final-expense-qualifier` — 19,480 characters, explicitly US-only and
English-only — is `enabled` on **2 of 3** insurance orgs, including the one org
that has actually declared `country_code = IN` / `timezone = Asia/Kolkata`. It is
the direct explanation for the USD burial-cost figures in calls 24 and 25. No
mechanism could have prevented it: the org cannot declare a market in a form code
reads, and the template does not declare one at all.

**A locked pricing decision has nothing to attach to.** Geo-differentiated plans
were decided three weeks ago. Billing cannot select a plan family, the dashboard
cannot pick a currency, and no code path can behave differently for an Indian
customer than an American one — because there is no field that says which one an
org is.

### The adjacent finding that this ADR does *not* fix

`insurance-gates.ts:74` requires an active `number_series = "1600"` row for any
insurance org dialling India (TRAI Direction 16 Dec 2025, F. No.
G-6/(8)/2025-QoS-Part(I), clause (iii) — consent does not cure it; the 15 Feb
2026 deadline has passed). All four production numbers are US Twilio DIDs with
`number_series` NULL, and Twilio does not allocate 1600-series numbers. That gate
is correct and stays. It is a **telephony-relationship** gap (Exotel/DLT), not a
schema gap, and no decision in this ADR changes it. It is recorded here only
because a declared market is what makes the gap *visible before dial time*
instead of at it.

## Decision

**Market becomes a first-class, org-owned field that the runtime reads. The
callee's country code is demoted from source of truth to cross-check.**

1. **`orgs.market`** — a small closed enum (`"IN" | "US"` to start; additive-only,
   grows the way `vertical` does), set at onboarding next to vertical, with the
   existing `country_code`/`currency`/`timezone` columns kept and derived-or-set
   alongside it. Not renamed, not dropped (additive-only invariant). `market` is
   the field code reads; the legacy three stay for display and are backfilled.
2. **Optional per-agent override** on `org_agent_configs`, same precedence
   discipline as providers and language: an explicit per-agent value wins over
   the org value, which wins over the platform default. A multi-market agency org
   is a real shape and this is where it is expressed.
3. **`agent_templates.market`** — nullable, where NULL means market-agnostic.
   Template eligibility is then `vertical` **and** market, resolved in
   `visibleTemplatesForOrg` / `loadVisibleTemplate` (ADR-091's single by-key
   read path), so a US-only template cannot be enabled by an India-market org.
   Existing rows: `09-final-expense` → `"US"`, the rest → NULL until authored
   otherwise.
4. **`market` drives, from one resolution point:** the compliance pack for
   business-side rules (licensing, consent basis, disclosure requirements — *not*
   the calling window), template eligibility, currency in the prompt's facts
   block, the default `language`, the resulting STT/TTS provider default via
   `prefersSarvam`, and the pricing plan family. Emitted into the prompt as its
   own labelled segment (`agent.ts:363-429` already composes by segment), never
   as prose inside a persona blob.
5. **Callee prefix stays where it belongs.** `isIndianNumber` keeps deciding the
   calling window, unchanged. It additionally becomes a **mismatch detector**:
   dialling outside the org's declared market is logged and surfaced (and, for
   regulated verticals, gate-able) rather than silently reinterpreted as a
   different jurisdiction.

## Consequences

**What gets better.** The US-only template stops being enableable by an
India-market org, which is the actual observed defect. Geo pricing acquires
something to key off. An India-market org gets Hindi/Hinglish and therefore
Sarvam by default rather than by remembering to type a language code into a
free-text box (audit 15 F5). The 1600-series gap becomes knowable at onboarding
instead of at dial time.

**What this costs.** Three additive columns and a resolution function threaded
into template listing, prompt composition, and provider defaulting. Existing rows
need a backfill decision — `org_68497dd7` is `IN`, the other three are
undeclared and dial US numbers, so the honest default is `"US"` with an explicit
onboarding prompt rather than an inferred value. Every org's *visible* template
list changes once step 3 lands; that is the point, and per ADR-093's precedent
the rule is disable, never delete.

**What is deliberately not decided here.**

- Whether the primary market for the next 90 days is US or India. That is a
  business decision (audit 15 §9 item 1); this ADR makes either one expressible,
  and is worth doing under either answer.
- Any change to `packages/weeber-compliance`. Extending disclosure coverage
  beyond `en`/`hi`/`hinglish` (audit 15 F6) is a **STOP-AND-ASK** item and is not
  bundled in.
- Mid-call language switching. Still rejected, still correct (ADR-060). Market
  selects the language *before* the call; it does not make it dynamic.
- Whether agent authoring is self-serve or a service (audit 15 F7). Unrelated
  axis, separate decision.
