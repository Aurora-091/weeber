---
adr: 62
title: "Compliance audit trail — legal-shape completion + dial-time consent enforcement"
date: 2026-07-30
status: Accepted (Phase I implemented; Phases II–III deferred)
---

## ADR-062 — Compliance audit trail: legal-shape completion + dial-time consent enforcement

**Date:** 2026-07-30
**Status:** Accepted — **Phase I implemented 2026-07-30**; Phases II–III deferred until first real
outbound *marketing* volume (see Implementation status below).
**Supersedes/extends:** ADR-017 (compliance audit-trail export — the skeleton this completes). Related:
Global Compliance Engine plan (Tier 0 done; this is Tier-1-shaped audit work).

### Implementation status (2026-07-30)

**Phase I — shipped.** The export now answers the full legal question from canonical state:
- `CallAuditRecord.consentBasis` reads the consent ledger, org-scoped per call via
  `auditConsentFactory(orgId)` (`voice/compliance/adapters.ts`), tier inferred from purpose
  (`tierForPurpose`: marketing/underwriting → PEWC, rest → PEC), resolved to active/withdrawn/expired.
- `calls.disclosureFiredAt` stamped in `stream.ts` right after the greeting turn (gated on disclosure
  actually being configured; idempotent); `wasDisclosureSpoken` substring check kept as content fallback.
- `opt_out_events` table written off the `cancellation_or_opt_out` intent path in `stream.ts`
  (fire-and-forget; never blocks the call). `dncPropagatedAt` left null — propagation is Phase II.
- `renderAuditTrailText` rewritten as a per-call consent + action timeline (consent basis → disclosure
  → opt-out → DNC → transcript), plain-language ("Marketing consent (written / PEWC), granted 12 Mar 2026").
- Both `routes.ts` audit sites pass the consent factory. Migration `0043_massive_ultron.sql` (additive:
  nullable `calls.disclosure_fired_at` + `opt_out_events` table). Typecheck/lint/build green;
  `openvent-compliance` audit-trail suite 18 tests, full compliance suite 71.

**Phases II–III — deferred, not cancelled.** Decision 2026-07-30 (pre-pilot, zero real outbound
marketing volume): both phases are exposure-driven and building them now would insure calls not being
made. Explicit trigger to resume: **the first scheduled real outbound *marketing* campaign**
(Shopify cart-recovery / upsell = PEWC). At that point Phase III's dial-time `hasConsent` gate (item 9)
+ Shopify consent backfill (item 8) jump the queue ahead of everything else — until then nothing blocks
an outbound marketing dial to a number with no written consent, and the audit trail would faithfully
record a call that shouldn't have been placed. This is the one item where shipping late is a liability,
not a missing feature.

### Context

A second round of direct community feedback (r/AI_Agents thread `1uoo1ac`, comments `ow3s83i`
/u/Lucky-Sock3699 and `p0i8g70` /u/ankur-at-guava) pushed the audit-trail work past what ADR-017
shipped, on three specific points: (1) the export is only defensible if it says **under what
consent** a call was placed — the single thing our export still omits; (2) the log has to be
**tamper-evident** and **exportable to CSV/PDF on demand**, because "produce the record" is a
literal request from a lawyer/compliance officer, not a dashboard view; (3) `ankur-at-guava`'s
sharper framing — a swappable stitched stack fragments the record across providers, so the
canonical **structured state** should be the source of truth for the audit, not the transcript.
Our nearest regulated-voice competitor (Guava, goguava.ai) sells exactly this record as its whole
product.

Grounded against FCC-24-17 (Feb 2024 — every AI-generated voice is "artificial/prerecorded" under
the TCPA) and the six legally-required per-call record types (consent, call-initiation,
disclosure-timestamp, opt-out event, DNC-scrub, recording/transcript; 4–7 yr retention, 7 for
healthcare). Penalty exposure is per-call with no statutory cap ($500 negligent / $1,500 willful),
which is what makes "produce the record in under an hour" a real sales artifact for the clinic and
Shopify verticals rather than a nice-to-have.

**Code state verified 2026-07-30 (not assumed):**
- Consent ledger (`consentRecords`) exists — purpose-scoped, versioned, append-only, org-scoped —
  and `createConsentAdapterForOrg` (`voice/compliance/adapters.ts`) implements
  `hasConsent`/`grant`/`withdraw`, with admin **read** routes in `admin-routes.ts`.
- **But:** the audit export (`routes.ts` → `buildCallAuditRecord`) is passed only the call-audit +
  DNC adapters, **never the consent adapter** — so the record omits consent entirely.
- **And:** `dispatchScheduledCall` (scheduler.ts) gate chain is DNC → calling-window → FTSA
  attempt-cap → insurance number-series → insurance producer-licensing → India DLT number-series →
  place. `hasConsent` is **never called** — consent is recorded but **not enforced at dial time**.
- The Shopify `marketingConsent` → `consentRecords` **backfill has not been run** (schema comment
  only) — a hard prerequisite before any live dial-time marketing-consent gate.
- No disclosure fired-**timestamp** (only text/version persisted + a spoken-substring check), no
  per-call **opt-out event** record, no per-call **DNC-scrub** record, no **tamper-evidence** hash
  chain, no **CSV/PDF** export (text + JSON only).

### Decision

Complete the audit trail to the six-record-type legal shape and enforce consent at dial time, in
three independently-shippable phases. All work reuses existing adapter/route/dashboard patterns —
it is a wiring + formatting layer on data and adapters already present, not new data collection.

**Phase I — Close the export to legal shape (highest leverage).**
1. Extend `CallAuditRecord` with `consentBasis` (purpose, tier PEC/PEWC, grantedAt, version,
   channel, withdrawnAt); add a consent read to the audit assembly and pass
   `createConsentAdapterForOrg(call.orgId)` into `buildCallAuditRecord`/
   `buildPhoneNumberAuditTrail` at both `routes.ts` call sites.
2. Add `calls.disclosureFiredAt` (nullable), written when the agent speaks the disclosure; keep
   `wasDisclosureSpoken` as fallback confirmation.
3. New `opt_out_events` table (callId, phoneNumber, orgId, triggerPhrase, firedAt,
   dncPropagatedAt), written off the existing `cancellation_or_opt_out` intent path; include in the
   record.
4. Rewrite `renderAuditTrailText` as a per-call **consent + action timeline** (consent basis first,
   then each check result inline with timestamps, then transcript).

**Phase II — Defensibility + export formats.**
5. Append-only **SHA-256 hash chain** over audit entries (`prevHash` + `contentHash`) — tamper-evidence.
6. `?format=csv` and `?format=pdf` on both audit routes (PDF via existing headless Chrome / render
   route, no heavy dependency).
7. New `dnc_scrub_log` (callId, scrubbedAt, registryVersion, listHash) written at the DNC check in
   `dispatchScheduledCall`. National-registry sync stays stubbed until an FTC SAN exists.

**Phase III — Dial-time enforcement + vertical routing.**
8. Run the Shopify consent **backfill** (`marketingConsent = true` → `consentRecords`,
   purpose=`marketing`, channel=`shopify`) — prerequisite for #9.
9. Insert a `hasConsent` gate into `dispatchScheduledCall` (after DNC, before place) for
   marketing-purpose workflows; new `DispatchResult` reason `consent` (sweep cancels, manual
   surfaces the error).
10. Drive `/dashboard/audit` labels/columns off the org's **vertical**; 7-yr retention for clinic
    orgs (split from the GDPR data-min clock, as consent already is); add a biometric-voiceprint
    consent preflight (IL/WA/TX) mirroring `assertHipaaPreflight`.

**Out of scope:** working FTC National DNC SAN sync (paid, no free API); bulk/all-numbers export;
live streaming compliance dashboard.

### Consequences

- Phase I makes the export answer the exact feedback quote ("who, when, under what consent, what was
  disclosed, did they opt out, what was said") and is shippable now as a pilot sales artifact
  regardless of call volume.
- Phases II–III are outbound-marketing-exposure-driven. **Open sequencing question:** if there is no
  real outbound *marketing* volume yet (clinic pilot is inbound/opted-in reminders), ship Phase I and
  hold II–III until a client requires them — don't gold-plate compliance for calls not being made.
- Each phase leaves typecheck/build/lint green and adds tests in `openvent-compliance` +
  `voice/compliance`, following ADR-017's regression pattern (401 without admin key, 404 unknown id,
  correct ordering, consent-present/absent, hash-chain integrity, opt-out-event presence).
- Estimated ~6–8 dev-days total (I ≈ 2–3, II ≈ 2, III ≈ 2–3), single dev.
