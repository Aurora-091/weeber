# Weeber Integrations Strategy & Roadmap — Pipedrive, Pipedream, and the connector layer

**Date:** 2026-07-19 · **Status:** direction doc for roadmap update · **Author trigger:** "we already give a webhook for automation — can we build both (native + connector) in our favour?"

TL;DR — **Yes, build both, but they're two different layers, not competitors.** We already have the hard parts. Pipedrive is one more *native adapter* (a day of work). Pipedream is a *connector layer* for the long tail. Keep the sensitive, high-volume CRM path native and owned; use a connector platform only for the everything-else tail. Pipedrive ≠ Pipedream — one is a CRM our merchants use, the other is integration infra we could use.

---

## 1. What we already have (grounded in the codebase, not assumed)

This matters because it changes the answer. We are **not** starting from "notes land in a call record for a human to read." That was old state. Today:

| Capability | Where | State |
|---|---|---|
| **Outbound webhooks** — durable outbox, retry + exponential backoff, dead-letter, per-call URL override + global `WEBHOOK_URL`, 7 event types (`call.started/completed/transcript/tool_call/recording_ready/retries_exhausted/voicemail_detected`) | `voice/webhooks.ts` | **Live.** This is the "n8n / Zapier / Make" escape hatch, explicitly. |
| **Webhook nodes in the workflow graph** — merchant can drop a `webhook` node on a branch (e.g. "interested → POST to their URL") | `voice/workflows/graph-engine.ts`, `seed-graph.ts` | **Live.** |
| **Native CRM sync tool** — `crmSync` looks up the org's connected CRM and pushes contact + call note | `voice/tools/crmSync.ts` | **Live.** |
| **Native CRM adapters** — GoHighLevel, Salesforce, HubSpot (search contact by phone → create if missing → attach note) | `voice/integrations/{gohighlevel,salesforce,hubspot}.ts` | **Live, 3 adapters.** |
| **Google Calendar** adapter (booking) | `voice/integrations/google-calendar.ts` | **Live.** |
| **Per-org credential store** — `orgIntegrations` table (provider + credentials + enabled) | `database/schema.ts` | **Live.** |
| **Resilient fetch** — retry + circuit breaker wrapper all adapters use | `voice/integrations/resilient-fetch.ts` | **Live.** |

**Conclusion:** the `CrmProvider`-style abstraction effectively already exists (a provider switch + per-org creds + a common adapter shape + resilient fetch). Adding a CRM is now *filling in a template*, not building infrastructure.

---

## 2. Pipedrive vs Pipedream — settle the naming confusion first

| | **Pipedrive** | **Pipedream** |
|---|---|---|
| What it is | A **sales CRM** (deal pipeline tool) | An **integration/automation platform** (Zapier/Make/n8n, but code-first) |
| Our relationship | A CRM **our merchants use** → we push call outcomes into it | Infra **we could use** to reach many apps at once |
| Where it slots | A 4th entry next to HubSpot/Salesforce/GoHighLevel | The **connector layer** behind `crmSync` / webhooks for the long tail |
| Effort to adopt | ~1 day (one adapter) | Days–weeks (SDK, embedded auth UI, billing, ops) |

They are unrelated companies with confusingly similar names. Both can be true "yes" answers — to different questions.

---

## 3. The three-layer integration model (this is the "build both" framing)

Think of merchant integrations as three concentric rings, cheapest-to-own outward:

**Ring 1 — Native adapters (own these).** Turnkey, first-party, zero merchant config beyond pasting a key/OAuth. This is where the *core, sensitive, high-volume* path lives: call outcome → CRM contact + activity. We own the data path, cost is fixed, compliance is clean. Pipedrive belongs here. Roadmap: HubSpot ✅, Salesforce ✅, GoHighLevel ✅, Google Calendar ✅ → **Pipedrive next**, then Zoho CRM, then vertical-specific (practice-management for clinics, e.g. a booking system).

**Ring 2 — Webhooks (already shipped).** The DIY escape hatch. Any merchant with n8n/Zapier/Make can wire *anything* themselves off our events. This is our "we don't have a native adapter for your tool? here's the raw event, go nuts" answer. **No further build needed — it exists.** Just document it well.

**Ring 3 — Connector layer (optional, later).** A platform like Pipedream Connect (or Nango/Paragon/Merge) gives instant breadth to 1,000s of apps without us writing each adapter. Use **only** for the low-volume, non-sensitive long tail ("also append a Google Sheet / ping our Slack / create a Trello card"). This is the "build both" upside — but it's a *supplement* to Ring 1, never a replacement for the core CRM path.

The strategic point: **Rings 1 and 2 we already largely have. "Building both" = adding Pipedrive to Ring 1 now, and evaluating a Ring-3 connector platform later.** These compound — a merchant gets a native, polished path for the CRM they actually run, plus a webhook/connector fallback for everything else.

---

## 4. Pipedrive — how it fits and what it takes

**Object mapping** (same shape as our existing adapters):

| Weeber | Pipedrive |
|---|---|
| Lead / policyholder / customer | Person (+ Organization) |
| Call outcome + notes (`crmSync`) | Activity (type: call) + Note on the Person |
| `captureField` values (rating, docs_received, complaint) | Person/Deal custom fields, or note body |
| Qualified → transfer/book | Deal advanced to a pipeline stage |

**Auth:** two options, both supported by our `orgIntegrations` creds model.
- **API token** — simplest; fine for a *private* integration (merchant pastes their token, like our HubSpot adapter). Fastest path to shipping.
- **OAuth 2.0** — *mandatory* if we ever want to be listed in the Pipedrive Marketplace (public app). Bigger lift (dev sandbox → Developer Hub → app review). Only worth it later as a distribution channel, same logic as our Shopify unlisted-app decision.

**Build estimate:** `pipedrive.ts` adapter (search Person by phone → create if missing → add Activity + Note), one `case` in the `crmSync` switch, add `"pipedrive"` to the providers array, an Integrations-settings credential field, and tests mirroring `hubspot.test.ts`. **~1 day.** Start with API-token (private); defer OAuth/Marketplace.

**Fit note:** Pipedrive is *sales-CRM-shaped*, great for ecommerce merchants and insurance **brokers** running a sales pipeline. It is **not** HIPAA-scoped and not built for PHI — which is fine because our agents already never write regulated data (SSN/PAN/Aadhaar/health/financials) to any CRM. Keep that boundary; a clinic likely runs a practice-management system, not Pipedrive.

---

## 5. Pipedream — corrected assessment (my earlier compliance caveat was too strong)

Earlier I flagged "a third party in the call-data path is a compliance problem for a regulated product." Research update — **Pipedream Connect is SOC 2 Type II, offers HIPAA with a BAA, and is GDPR-compliant**, and their **Connect API Proxy** can route custom API calls through their managed auth without persisting our payloads. So the compliance objection is materially weaker than I first said. It's a viable Ring-3 option.

**What Pipedream Connect gives us:** one SDK, ~2,500 app integrations, embedded auth so *our merchants* connect *their* accounts inside *our* dashboard, and we trigger actions on their behalf. That is exactly the shape of "every merchant uses a different tool."

**Real tradeoffs (both directions):**
- **For:** instant breadth, far less integration code, managed OAuth for thousands of apps, compliance certs exist.
- **Against:** credit-based cost (≈$29/mo entry, 1 credit / 30s compute — scales with volume, unlike our fixed native cost), a third-party dependency in the path (uptime + pricing risk), and independent critiques (e.g. truto.one, Nango) that Pipedream is workflow-first and *not purpose-built for embedded white-label customer-facing integrations* — worth weighing, though those are competitors. Alternatives purpose-built for embedded SaaS: **Nango, Paragon, Merge** — evaluate against Pipedream if/when we go Ring 3.

**Recommendation:** don't put Pipedream (or any connector) on the *core CRM sync* — keep that native (cheaper at scale, fully owned, compliance-clean). Reach for a connector platform only when the long-tail request volume justifies it, and bake-off Pipedream vs Nango/Paragon/Merge at that point.

---

## 6. Recommended roadmap update

**Now (this sprint) — Ring 1:**
1. Ship **Pipedrive native adapter** (API-token/private, ~1 day). 4th CRM.
2. One-line docs: our webhook events + payload shape (Ring 2 already exists — just make it discoverable to merchants).

**Next (1–2 sprints) — deepen Ring 1:**
3. Add **Zoho CRM** (India-heavy merchant base → high fit) and evaluate a clinic-vertical booking/PM integration.
4. Enrich `crmSync` beyond a note: push `captureField` values as structured custom fields + advance a Deal stage on qualified/booked outcomes (closes the "who actions the note" loop natively).

**Later (evaluate, don't commit yet) — Ring 3:**
5. When long-tail "connect my X" requests pile up, run a **connector-platform bake-off: Pipedream Connect vs Nango vs Paragon vs Merge**. Criteria: embedded-UX quality, per-active-connection cost at our scale, data-path/compliance posture (BAA), app coverage for our merchants' actual tools.
6. If adopted, wire it **behind the same `orgIntegrations` seam** as a fallback provider — never on the core CRM path.

**Distribution (opportunistic):**
7. Only if Pipedrive/HubSpot marketplaces become a real lead channel, invest in the OAuth public-app + review lift for a Marketplace listing (mirrors the Shopify unlisted-app call).

---

## 7. Guardrails that stay fixed regardless of platform

- **No regulated/sensitive data leaves to any CRM or connector** — SSN/PAN/Aadhaar/bank/full DOB/health. Unchanged; our agents already enforce this.
- **Core CRM sync stays native and owned.** Connectors are for the long tail only.
- **Everything routes through `orgIntegrations` + `resilient-fetch`** — one seam, one credential model, one retry/circuit-breaker path. No integration bypasses it.
- **Webhooks remain the universal fallback** so we're never blocked by a missing native adapter.

---

## 8. One-line answer to the original question

We already ship the webhook (Ring 2). "Building both" = add **Pipedrive** as a native adapter now (Ring 1, ~1 day, high leverage), and keep **Pipedream/connector platforms** in our pocket for the long tail (Ring 3, evaluate later, bake-off first). They compound in our favour; they don't compete.
