---
doc: audit-16
status: findings — no code changed
date: 2026-08-10
scope: US-insurance-first pilot readiness — compliance gate coverage, producer licensing, DNC/consent state, billing
grounded-against: HEAD 8498e58 (`main`) + production DB (Supabase pooled)
supersedes-context: audit 15 F1 (India insurance) is descoped by the market decision, not fixed
---

# Audit 16 — the gate is on two of the five doors

Audit 15 was written on the assumption in `docs/brain/project-brief.md`: ecommerce, Shopify first,
India-first. That assumption is now dead. The stated position as of today is: **one real US-licensed
insurance agency in pilot, dialing US prospects, plus roughly five more on a waitlist. No India pilot
was landed.** This audit re-runs pilot readiness against *that* reality instead of the brief.

The conclusion is not "we are ready and the market changed." It is that the pivot moves Weeber from a
jurisdiction where our exposure is regulatory (TRAI suspends telecom resources) into one where the
exposure is **private right of action at $500–$1,500 per call with no aggregate cap** — and it does so
while the code has three defects that are individually survivable in a demo and jointly fatal in a
real campaign.

Everything below is read from source at `8498e58` or queried from the production database. Nothing is
inferred from the brief.

---

## 0. The headline

| # | Finding | Sev |
|---|---|---|
| F1 | `placeOutboundCall` has **five** call sites and compliance gates run at **two** of them. The three ungated paths include `POST /api/app/leads/:id/call-now` — the tenant-facing leads dialer, i.e. the exact endpoint a pilot uses to call a lead. Ungated means no DNC, no calling window, no FTSA attempt cap, and no insurance gates. `project-brief.md`'s invariant "DNC has no bypass anywhere, on purpose" is **false in code**. | **P0** |
| F2 | `insurance_advisors` is **empty in production**. `checkInsuranceProducerLicensing` blocks any `+1` call whose area code resolves to a state with no licensed advisor on file — so on the *gated* path the pilot's first real US campaign blocks 100% of resolvable calls, while the *ungated* leads path dials every one of them. The compliant door is shut and the non-compliant door is open. | **P0** |
| F3 | `do_not_call` = **0 rows**. `consent_records` = **0 rows**. For US outbound insurance lead calling, the consent record *is* the TCPA defense and DNC scrubbing *is* the duty of care. Both tables exist, are wired, and are empty. | **P0** |
| F4 | **Zero US calls have ever been placed.** All 11 calls all-time dialed `+91` from US Twilio DIDs. US English on Deepgram, area-code→state resolution, four-timezone calling windows, and Twilio AMD against US carriers are all completely unexercised in production. The pivot's target market has never received a call from this system. | **P1** |
| F5 | Producer licensing is decided from the **area code**, not the lead's state. US mobile numbers are portable and routinely retained across state moves, so area code is not a defensible basis for a licensing determination. ADR-087 already added `state` to the lead intake schema for exactly this class of problem, and this gate ignores it — the only lead with any enrichment carries `{"city": "Newyork"}` and no `state` at all. | **P1** |
| F6 | Nothing can be billed. `plan_name` is NULL on 4 of 4 orgs, there is no plan enforcement (`pricing-lock-2026-07-18.md` caveat), and Stripe rejected the Indian entity. The pivot's whole thesis is that US willingness-to-pay is 3–5x India's, and there is no path from a US customer's card to our account. | **P1** |
| F7 | Audit 15's F1 (India insurance legally undeliverable, TRAI 1600-series) is **descoped, not fixed**. The gate stays correct and stays unsatisfiable on Twilio. Any future India insurance conversation reopens it unchanged. | P2 |

---

## 1. F1 (P0) — five doors, two guards

`place-outbound-call.ts:86` states the contract explicitly:

```
 * Compliance gates are the caller's responsibility
 * (both call sites already run them before reaching here); this only places
 * the call and returns the session key to store state under.
```

"Both call sites" was true when written. It is now wrong by three. Every caller of
`placeOutboundCall`, from `rg`:

| Call site | Endpoint | Gated? |
|---|---|---|
| `voice/workflows/scheduler.ts:119` | scheduled-call sweep | **yes** — 6 gates at `:81`–`:85` |
| `voice/routes.ts:313` | `POST /api/voice/calls/outbound` | **yes** — DNC + window + 2 insurance + India series at `:283`–`:303` |
| `app/routes.ts:957` | **`POST /api/app/leads/:id/call-now`** | **no** |
| `app/routes.ts:645` | tenant agent preview test-call (`userOrgId` auth) | **no** |
| `voice/routes.ts:840` | `POST /orgs/:orgId/agent-configs/:templateKey/test-call-phone` (admin key) | **no** |

`app/routes.ts:946-957` is the one that matters. Its own comment says it dials "through the same
outbound path as the manual test-call, honoring the org's outbound routing" — which is accurate about
*routing* and silent about the fact that the manual test-call route it is imitating runs six gates
first and this one runs none:

```ts
.post("/leads/:id/call-now", async (c) => {
  const orgId = c.get("userOrgId")!;
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "invalid id" }, 400);
  const result = await getOrgLead(orgId, id);
  if (!result) return c.json({ error: "not found" }, 404);
  if (!isValidE164(result.lead.phone)) {
    return c.json({ error: "Lead phone is not a valid E.164 number, can't place a call." }, 400);
  }
  const placed = await placeOutboundCall({ orgId, to: result.lead.phone });
```

E.164 shape is validated. Legality is not.

### Why this is the same defect as ADR-090's eight

`voice/routes.ts:279` carries a long comment about how thoroughly the `bypassCompliance` request-body
flag was removed — "it's stripped entirely, not just gated," "the env var is now hard-disabled in
production." That work was real and it hardened **one** of five doors. The bypass that actually exists
in production today is not a flag; it is a second endpoint that never had the gates in the first place.
This is the reachability class of defect that ADR-090 stood up the `knip` ratchet for, and `knip`
cannot see it — the gate functions *are* imported and *are* called, just not on every path.

### Severity under the pivot

In India the ungated path risks TCCCPR action against telecom resources. In the US, an ungated call to
a number on the federal DNC registry is $500–$1,500 statutory, per call, no cap, with a private right
of action and no need to prove harm — and the FCC's February 2024 declaratory ruling puts
AI-generated voices squarely inside "artificial or prerecorded voice," so every call our product makes
is in scope. TCPA class filings are running well above last year's pace (a record 211 in February 2026
per TCPAWorld's tracker; vendor/tracker-cited, not a primary docket pull). A 10,000-lead campaign
through `call-now` with no DNC scrub is a $5M–$15M theoretical exposure on one tenant's afternoon.

The multi-tenant shape makes it worse than a single-company mistake: the pilot is licensed and
presumably careful, but the waitlist is five unknown agencies and the ungated endpoint is available to
every one of them from day one.

**This is the single thing to fix before the pilot runs a campaign.** See ADR-096.

---

## 2. F2 (P0) — the compliant path blocks every US call

`insurance-gates.ts:103` `checkInsuranceProducerLicensing`:

- no-op unless `to` is NANP-shaped and `orgs.vertical === "insurance"` ✓ (pilot is both)
- honors the self-expiring 24h `callingWindowTestModeUntil` bypass — **all four orgs' windows have
  expired** (`krisn`'s lapsed 2026-08-04; the other three are NULL)
- `resolveUsState(toNumber)` → if unresolved, **fails open** and allows
- otherwise requires some row in `insurance_advisors` for this org whose `licensedStates` contains
  that state

Production:

```
select org_id, count(*) from insurance_advisors group by 1;   →  (0 rows)
select id, org_id, name, licensed_states from insurance_advisors;  →  (0 rows)
```

`advisors.some(...)` over an empty array is `false`. So for every US lead whose area code resolves to
a state — which is most of them — the gated path returns 403 with
`"No licensed advisor on file for this org is licensed in {STATE}"`. The pilot is a licensed agency;
their licences exist in the real world and in no row of our database, and there is no evidence any
onboarding step asks for them (`assigned_advisor_id` is NULL on all 4 leads).

### The perverse outcome

Put F1 and F2 together and the product actively teaches the pilot to use the illegal path:

- `POST /api/voice/calls/outbound` → **403, blocked**, correctly, for a paperwork gap
- `POST /api/app/leads/:id/call-now` → **dials**, no DNC, no window, no licensing

A pilot who hits the 403, gets no clear remediation UI, and finds that the leads screen's "Call now"
button just works will use the button. We will have built a compliance system whose only observable
effect on a paying customer is to route them around itself.

---

## 3. F3 (P0) — the defense file is empty

```
select count(*) from do_not_call;      →  0
select count(*) from consent_records;  →  0
```

`checkOutboundCallCompliance(to, dncAdapter)` runs on the gated path and is scrubbing against nothing.
The federal DNC registry is not loaded; there is no internal suppression history because no US call has
ever been made; and `consent_records` — the table that would hold the "prior express written consent"
that makes an AI-voice insurance call lawful — has no rows, so today no call this platform places
could be defended on consent-of-record.

Two things follow that are product decisions, not bugs:

1. **Where does consent come from?** The pilot buys or generates leads. Their consent lives in the
   lead vendor's or their own web form's records, not ours. If we do not ingest it at lead-import
   time and bind it to the phone number, our `consent_records` table is decorative and the pilot's
   TCPA defense sits in a spreadsheet somewhere else. ADR-089 already made CSV import previewable;
   consent provenance is the obvious next column, and it does not exist.
2. **DNC scrubbing is a subscription, not a feature.** Federal DNC registry access is per-area-code
   licensed and priced; internal + wireless + litigator lists are commercial feeds. Nobody has
   scoped or bought this. "Compliance-first is the moat" is currently an architecture, not a
   dataset.

---

## 4. F4 (P1) — the target market has never been dialed

All 11 production calls, all-time:

```
presistentads  outbound  +917905681369  completed  healthy   319s  2026-08-10 16:10
presistentads  outbound  +916393688162  completed  healthy   237s  2026-08-10 15:04
krisn          outbound  +919359848364  completed  healthy    89s  2026-08-10 10:42
krisn          outbound  +919359848364  completed  healthy    67s  2026-08-10 10:40
presistentads  outbound  +916393688162  completed  degraded   54s  2026-08-09 17:06
krisn          outbound  +919359848364  completed  healthy    19s  2026-08-09 13:41
rishipawar8999 outbound  +919359846364  completed  healthy    20s  2026-08-08 17:30
krisn          outbound  +919359848364  completed  healthy    20s  2026-08-08 16:24
krisn          outbound  +919359848364  completed  healthy    22s  2026-08-06 10:48
krisn          outbound  +919359848364  completed  healthy    19s  2026-08-06 10:46
```

`to_number` is `+91` on every row. `scheduled_calls` is empty — no campaign has ever run, only
one-off dials. The two calls today at 5:19 and 3:57 are the only conversations of real length in the
system's history.

This is fine as testing. It is not fine as evidence. Everything the pivot depends on is untested in
production:

- **Deepgram Nova-3 on US English telephony** — likely our best case, but unmeasured here. Audit 15
  had paper evidence it is Tier III on *Indian* speech; that finding is now largely irrelevant, and
  we have no equivalent evidence either way for the market we are entering.
- **`resolveUsState` on real lead data** — never executed against a resolvable US number in prod.
- **US calling windows across four timezones** — `packs/us.ts`'s area-code→state→timezone map has
  never gated a real call. India needed one timezone; the US needs the map to be right.
- **Twilio AMD** (`machineDetection: "DetectMessageEnd"`, async) — US answering-machine and carrier
  behavior is the environment it was written for and has never run there. Roughly half of US cold
  calls hit voicemail; if AMD misfires the agent talks to a machine for its full turn budget.
- **Latency as judged by a US buyer.** Audits 13 and 14 stand unfixed: the literal-greeting fast path
  is 0-for-11, p50 1539 ms of avoidable TTFT, and the agent does not know the current date. A US
  agency benchmarking against Vapi/Retell will hear that immediately, and the price umbrella that
  made India forgiving does not exist here.

Related but now demoted: all 11 calls dialed Indian consumers *from* US DIDs, which is the pattern
TRAI/TCCCPR treats as unregistered telemarketing. **Confirmed by the founder on 2026-08-10: all 11
rows are founder/internal testing to known numbers**, so the regulatory exposure is nil and the rows
carry no market evidence. Recorded here only so nobody later reads `calls` as traction, and so the
`presistentads` rows to two different `+91` numbers are not mistaken for a live campaign.

---

## 5. F5 (P1) — area code is not a state

`checkInsuranceProducerLicensing` resolves jurisdiction with `resolveUsState(toNumber)`. Its own doc
comment concedes this is "best-effort." For a *calling window* that is defensible: guessing wrong
shifts a call by an hour or two and `checkUsCallingWindow` already fails safe. For **producer
licensing** it is the wrong test entirely — number portability means a `+1 212` mobile may have lived
in Texas for a decade, and "we inferred the prospect's state from their area code" is not a story any
carrier's compliance officer or state DOI will accept as the basis for who solicited whom.

The fix already half-exists. ADR-087 added `state` to the lead intake schema precisely because the
opener needed it. The gate does not read it. And the intake is not populating it either — the only
enriched lead in production is:

```json
{"city": "Newyork", "budget_band": "1k-3k", "existing_policy": "true",
 "product_interest": "health", "best_callback_time": "Now", "preferred_language": "en"}
```

`city: "Newyork"` — free text, misspelled, no `state` key, and `leads.fields` is unvalidated `jsonb`.
The correct precedence is stated lead state → area-code inference → block-or-flag, with the source of
the determination recorded on the call so it is auditable afterwards. Note this makes licensing
*stricter*, not looser: unresolved state currently fails open, and for a licensing question that is
the wrong default once there is a real advisor roster to check against.

---

## 6. F6 (P1) — there is no way to take their money

`plan_name` is NULL on all four orgs. No plan/tier enforcement exists anywhere (an explicit caveat in
`pricing-lock-2026-07-18.md`). Stripe rejected the Indian entity; Razorpay is weak on international
card acceptance; Dodo/Paddle (merchant-of-record) were being evaluated and are not integrated.

The pivot's core financial claim is that Global Starter at $79 / $0.10 overage yields ~49–65% margin
against India Starter's 43% floor. That claim is unrealisable until a US company can pay an Indian
private limited for a SaaS subscription. `billing-metering-spec-2026-08-09.md` exists; the gateway
decision does not. **This is now the gating commercial item, ahead of any feature**, because a pilot
that goes well and cannot be converted is worse than no pilot.

---

## 7. What the pivot actually costs — for the record

The market decision itself is sound and is recorded separately in ADR-097. The honest ledger:

**What US-first wins:** 3–5x willingness-to-pay against the same dollar COGS; the only vertical where
a customer has actually asked; a compliance-heavy buyer for whom our DNC/consent/licensing machinery
is the product rather than overhead; a market where the 11th Circuit's January 2025 vacatur of the FCC
one-to-one consent rule (Insurance Marketing Coalition v. FCC) left lead-gen consent *easier* than the
FCC intended.

**What it costs:**

- `project-brief.md`'s "Launch vertical: ecommerce, Shopify first" is now false. So is the Shopify-→
  Woo/BigCommerce/Dukaan sequencing. Three of nine templates (cart recovery, COD confirmation,
  feedback) are parked, `weebersh` is parked, and COD confirmation has no US market at all — COD is
  essentially absent from US ecommerce. That is not wasted work; it is work sequenced first that
  should have been sequenced second.
- The entire Indic layer becomes dead capital in the near term. It already was — Sarvam ran on 0 of
  11 calls — but the Sarvam Startup Program credits and the "10+ Indian languages" narrative now have
  no customer attached. Grants (IIMA/NSRCEL/SISFS/IIMK) are entity-scoped so eligibility survives,
  but we would be pitching an India-first Indic story to panels while billing only US customers, and
  a competent panel will ask. Decide now whether the grant narrative becomes "Indian company selling
  into the US" — which is a legitimate and well-understood story — rather than getting caught
  mid-pitch.
- Liability shifts onto us. Platforms get named under direct-participation theories. Before any
  tenant dials 10,000 US numbers we need MSA indemnity, a consent-of-record requirement in the
  contract, and E&O cover. None of that is written.
- Ops hours invert: US calling windows are roughly 6:30pm–7:30am IST. One-person on-call means every
  incident is a night incident.
- We lose the price umbrella that made latency defects tolerable. Audits 13 and 14 stop being
  technical debt and become sales objections.

---

## 8. Sequence

Ordered by "what blocks the pilot's first real campaign," not by size.

1. **Gates to the chokepoint** (ADR-096). Move the six gates inside `placeOutboundCall` and make it
   fail closed, so no fifth door can be added later without them. Highest severity, smallest diff.
2. **Advisor roster onboarding + licensing precedence** (F2, F5). The pilot cannot make a legal US
   call until their licensed states are rows in our database, and the gate should read the lead's
   stated state before it guesses from an area code.
3. **DNC feed + consent provenance at import** (F3). Scope and buy the registry access; add consent
   source/timestamp/text to CSV import and refuse insurance-vertical imports without it.
4. **One real US call, then a real US campaign** (F4). Everything in §4 is unexercised. Do this
   before, not after, the pilot's first campaign.
5. **Billing gateway** (F6). Parallel track, no code dependency, but it gates revenue.
6. **Audits 13/14 fixes** — now customer-facing quality, not internal polish.
7. **ADR-095's `orgs.market`** — still the right structural fix, and cheaper now: with US-first
   decided, `market` has a real default and a real second value instead of being an abstraction.

Not in scope and deliberately parked: audit 15's F1 India 1600-series (unsatisfiable on Twilio, no
India customer to satisfy it for), the Indic language work, and the Shopify/COD templates.

---

## Appendix — production state as queried, 2026-08-10

```
orgs (4)
  krishna35672's workspace   shopify    country_code —    outbound —             plan —
  presistentads's workspace  insurance  country_code —    outbound +18573706834  plan —
  rishipawar8999's workspace insurance  country_code IN   outbound +17754554413  plan —
  krisn                      insurance  country_code —    outbound +17126257861  plan —

org_phone_numbers (4)   number_series NULL on all; 3 active + 1 released; all +1
calls (11)              all outbound, all to +91, 1 degraded, first 2026-07-18, last 2026-08-10
scheduled_calls         0 rows
leads                   4 rows (3 auto-created from calls, 1 manual with city="Newyork", no state)
insurance_advisors      0 rows
do_not_call             0 rows
consent_records         0 rows
callingWindowTestModeUntil  expired on krisn (2026-08-04), NULL on the other three
```
