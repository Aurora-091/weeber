# Insurance Vertical — Launch Readiness & Resource Guide (India + US)

Status: reference doc — what you actually need to do/gather before flipping the insurance vertical
live, given what's built (see `docs/agent-prompts/00-insurance-regulatory-reference.md` for the
regulatory research and `changelog.md`'s 2026-07-16 entries for the build report). This doc is the
"who do I call, what do I fill in" companion — no new engineering content, just the checklist +
contacts + links.

---

## 1. India — getting a 1600-series number (blocks every India insurance call until done)

**Why:** `checkInsuranceNumberSeriesCompliance` will hard-block any insurance-vertical org from
dialing an India number until at least one active phone number is marked `1600` series in the
dashboard. This isn't a platform limitation you can configure around — TRAI/IRDAI require it.

**What it actually takes to get one** (same underlying DLT infrastructure as the general 140/160
series, just a different number block + sector tagging):

1. **Register as a Principal Entity (PE) on a DLT platform.** Any TRAI-approved DLT operator works
   — commonly used ones: Vodafone Idea (vilpower.in), Airtel, Jio, BSNL/MTNL, Tata. Requires
   business KYC documents (company PAN, GST, incorporation certificate, authorized signatory ID) —
   physical/document verification is part of this step, budget a few business days.
2. **Complete telemarketer chain registration** with your telecom access provider (the entity that
   will actually issue the number) — this links your PE ID to the specific number(s) you'll use.
3. **Register your Voice Content Template(s)** on the same DLT platform — the actual script/opening
   line your agent will say needs to be registered as a template before it can be used on a
   1600-series call. Use each agent's **Conversation Starter** line from
   `docs/agent-prompts/04` through `08` as the template text you submit.
4. **Request 1600-series allocation specifically** from your telecom operator, tagging your entity
   as BFSI/insurance (IRDAI-regulated) — this is what makes the operator issue a number from the
   `1600` block instead of the general `140`/`160` blocks.
5. **Once issued:** add the number in the dashboard (Numbers page), and set its series to `1600` in
   the dropdown next to it. That's the only platform-side step — everything above happens with
   your telecom/DLT provider, not in this product.

**Heads up on timing:** the TRAI deadline for this was **February 15, 2026** — already passed as
of this writing. If you don't already have a PE/DLT registration in progress, start it now; it's
the longest lead-time item in this whole checklist (documents + operator processing, not something
that finishes same-day).

**Who to actually talk to:** your telecom operator's business/enterprise sales team (Airtel
Business, Jio Business, Vi Business) — ask specifically for "TRAI 1600-series registration for an
IRDAI-regulated entity," not just general DLT registration, so you're routed to someone who knows
this specific mandate.

---

## 2. US — adding licensed advisors (blocks a transfer/booking to a state with no coverage)

**Why:** `checkInsuranceProducerLicensing` blocks a call to a US lead if no advisor on file for
your org is licensed in that lead's state (resolved from their area code).

**What to gather per advisor**, then enter in **Settings → Compliance → Licensed advisors**:

| Field | What it is | Required now? |
|---|---|---|
| Name | The advisor's name, for your own reference in the list | Yes |
| Licensed states | Every US state (2-letter code, e.g. `NY, NJ, CT`) this specific advisor is currently licensed to sell/solicit insurance in | Yes — this is the actual field the gate checks |
| NPN (National Producer Number) | The advisor's NIPR-assigned producer number | No — not used yet, see §3 below, but worth capturing now so you don't have to re-collect it later |

**Where to get an accurate state list today** (manual, but don't guess):
- Ask the advisor directly, or your agency's compliance/licensing contact — they should already
  know this for their own commission/appointment paperwork.
- Cross-check for free at **NIPR's own public lookup**: `nipr.com/licensing-center/look-up-a-national-producer-number`
  — search by name or NPN, shows license status per state. This is the same source your gate will
  eventually pull from automatically (§3) — using it manually now costs nothing and confirms
  accuracy before you type it into the dashboard.
- State insurance department "agent lookup" tools also work per-state if you want a second source
  (e.g. Illinois: `idoi.illinois.gov/companies/agent-lookup.html`; most other states have an
  equivalent on their Department of Insurance site).

**One org, multiple advisors, multiple states:** add one row per advisor. The gate checks "does
*any* advisor for this org cover this state" — it doesn't route to a *specific* advisor per state
yet (see the build report's "not done" note), so if you have advisors split by region, all of them
still need to be entered for their calls to route correctly.

---

## 3. Later, optional — upgrading to real-time NIPR verification

Not needed for launch — the manual entry above is a real, working compliance gate today. This
section is here so the upgrade path is a clear, bounded task whenever you want it, not a mystery.

**What NIPR actually is:** the National Insurance Producer Registry's **Producer Database (PDB)** —
the authoritative, real-time source of license status, licensed states, and lines of authority for
every US insurance producer. Every compliance vendor in this space (AgentSync, Sircon/Vertafore,
TrustLayer) is a UI layer over this same data — there's no independent source to build against
instead.

**How to get access:**
- Start here: `nipr.com/industry-solutions` (their subscriber/API page) or call their support line,
  **(855) 674-6477**, and ask specifically for **PDB Gateway** access (their programmatic
  integration product) as an "industry user."
- Pricing found during research: roughly **$0.25 per producer per month** for ongoing monitoring,
  or **$1.30 per one-off detail report** — confirm current pricing directly with NIPR, this moves.
- Once you have subscriber credentials, the upgrade on our side is: a new adapter that calls NIPR's
  PDB API by NPN, populates `licensedStates`/`linesOfAuthority` automatically, sets
  `source: "nipr"` and `lastVerifiedAt`, and re-syncs periodically (so an advisor's license
  expiring or a new state being added gets picked up without anyone manually editing the dashboard
  again). The schema already has the columns for this (`npn`, `source`, `lastVerifiedAt`) —
  captured now specifically so this later step is additive, not a rebuild.

---

## 4. Quick pre-launch checklist

- [ ] India: PE/DLT registration started or complete, 1600-series number issued, marked `1600` in
      the dashboard's Numbers page.
- [ ] India: each India-facing agent's Conversation Starter line registered as a DLT voice content
      template.
- [ ] US: every advisor you transfer/book insurance calls to is entered in Settings → Compliance →
      Licensed advisors, with an accurate state list (cross-checked against NIPR's public lookup).
- [ ] Legal: all-party-consent-recording-state confirmation for the ~13 US states that require it
      (Platform gap #4, still open — see `00-insurance-regulatory-reference.md`) — this is a legal
      task, not a dashboard step, get it moving in parallel if not already.
- [ ] Optional, not blocking: decide whether to pursue real-time NIPR integration now or defer —
      no action needed either way until you're ready.
