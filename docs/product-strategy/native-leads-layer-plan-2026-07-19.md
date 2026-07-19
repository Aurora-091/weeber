# Native Leads / Records Layer — Design & Roadmap

**Date:** 2026-07-19 · **Status:** plan for review (build after sign-off) · **Trigger:** insurance agents collect many details per call — where do those live, how do leads get in, and how do they get out (Excel / CRM)? Own our layer before bolting on external CRMs.

**TL;DR** — Build a **native, person-centric Leads layer** as the hub. Everything flows through **one inbound contract (`POST /api/leads/ingest`)** into a `leads` table, projected per-vertical (insurance "Leads", Shopify "Orders" migrates on later), and flows out via **Excel export (own it)** + native CRM adapters + Pipedream (long-tail edges). Own the data-of-record; use Pipedream only on the *inbound edge* for breadth, never as the store.

---

## 1. Decisions locked (from brainstorm, 2026-07-19)

| Decision | Choice |
|---|---|
| Data model | **Dedicated `leads` table** — person-centric, deduped by phone, own pipeline/status, manual edits. Not a derived view. |
| Intake fields | **Per-vertical default schema, editable per-org, per-agent overrides.** Compliance-guarded. |
| Scope | **Generic native Records/CRM layer**, insurance Leads is the first projection; Shopify Orders migrates onto it later. |
| Store vs Excel | **DB is source of truth; Excel is an export/projection**, never the store. |
| Native intake form | **Later** — v1 ships the `ingest` endpoint (the contract) + leads page; forms are a thin client added free afterward. |
| Pipedream inbound | **v1** — as a ready-to-activate recipe template feeding `ingest`; endpoint independently testable so v1 isn't blocked on Pipedream infra. |
| Session output | This doc first → build after review. |

---

## 2. The core insight: two directions, one hub

Leads have an **input** side and an **output** side. Both plug into one owned layer.

```
INBOUND (lead sources)                 NATIVE LAYER                 OUTBOUND
──────────────────────                 ────────────                 ────────
Our own agent calls        ┐                                     ┌  Excel export      (own it)
Client web form / landing  ├──►  POST /api/leads/ingest  ──►  leads table  ──►├  Native CRM adapters (own it)
Client's CRM / form tool    │        (the ONE contract)         + calls[]    │  (HubSpot/SF/GHL/Pipedrive)
Pipedream (1000s of apps)  ┘        schema-validated,           + pipeline   └  Pipedream (long-tail edges)
                                     deduped, idempotent
```

**Why this shape:** the native layer is the **data-of-record**. Every source is just a caller of `ingest`; every destination is just a reader of the table. No source or sink is special-cased into the core. This is what "own our layer first" means concretely — external tools attach at the edges, never in the middle.

**Why Pipedream lives on the INBOUND edge (corrected framing):** earlier I framed Pipedream as *outbound* CRM sync and said keep it native. That still holds for outbound. But for **inbound lead sources**, breadth beats control — a client's leads could originate in any of 1000s of tools, and Pipedream's pre-built auth means we don't write an adapter per source. Pipedream just calls our `ingest`. It feeds the owned layer; it never *is* the layer.

---

## 3. Insurance is person-centric (why not clone Orders as-is)

Shopify Orders = **one row per cart/attempt** (a cart is a throwaway event; `scheduledCalls` row = the unit). Insurance is a **relationship**: one policyholder/lead → many interactions (lead follow-up → appointment → welcome → renewal → feedback). Cloning "one row per call" fragments the same person across 5 rows.

So the unit is the **person (deduped by `orgId` + phone)**, aggregating every call + every captured field onto one lead record. That's the Records/CRM layer — and it's a superset of Orders, so Orders becomes a projection of it, not a parallel thing.

---

## 4. Where the "many details" get set — the Intake Schema

Today `captureField` writes **free-form snake_case keys the LLM invents** into `calls.capturedState`. Great for in-call memory, useless as a structured leads table — you can't render columns for keys you don't know exist.

**Fix: a Lead Intake Schema** — a defined field set the merchant configures ("what should this agent collect?").

- **Per-vertical default** (insurance ships with a sensible set — see §5).
- **Per-org editable** (a client adds/removes fields in Settings).
- **Per-agent overrides** (renewal agent vs lead-followup agent collect different things).
- The agent's `captureField` targets these defined keys; the Leads page renders them as real columns/sections.
- Field types: text, number, enum (dropdown), boolean, date-ish (callback time). Each field: `key`, `label`, `type`, `required?`, `piiClass`.

**Compliance guardrail (hard):** the schema editor **refuses/blocks regulated fields** — SSN, PAN, Aadhaar, bank/card, full DOB, health condition. Same regulatory boundary the agents enforce, now enforced at the data layer too, so the native layer can't become a backdoor collecting what agents are forbidden to. A blocklist + a warning on suspicious labels ("PAN", "aadhaar", "policy number containing…") at save time.

---

## 5. Insurance default intake schema (starting set — editable)

Non-regulated, genuinely useful for a licensed-advisor handoff. (No user-supplied list yet — this is a first draft to react to.)

| Field | Type | Notes |
|---|---|---|
| `full_name` | text | |
| `city` | text | region for advisor routing |
| `product_interest` | enum | term / health / motor / etc. (generic) |
| `existing_policy` | boolean | already covered? |
| `budget_band` | enum | rough monthly/annual band, **not** exact financials |
| `best_callback_time` | text | |
| `preferred_language` | enum | en / hi / hinglish (ties to the language work) |
| `lead_notes` | text | free summary |

**Explicitly NOT collected (blocked):** PAN, Aadhaar, SSN, bank/card, full DOB, health details, exact policy financials.

---

## 6. Data model

**`leads` table** (new):
- `id`, `orgId`, `phone` (dedup key with orgId), `name`
- `fields` jsonb — validated against the org/agent intake schema
- `status` enum — `new → contacted → qualified → booked → closed` (+ `lost`)
- `source` enum — `call | form | webhook | pipedream | crm | manual`
- `assignedAdvisorId` (nullable) — licensed advisor assignment
- `firstSeenAt`, `lastActivityAt`, `createdAt`, `updatedAt`
- unique index `(orgId, phone)` for dedup/upsert

**`leadIntakeSchemas`** (new) — per-org (+ optional agentId) field definitions; falls back to the vertical default when none set.

**Link to calls:** `calls.leadId` (nullable FK) so a lead aggregates its conversation history. Backfill/associate by `(orgId, phone)`.

**Relationship to existing tables:** `scheduledCalls` stays the *queue*; `calls.capturedState` stays the *raw per-call capture*; the `leads` row is the *deduped person-of-record* that captured fields get promoted into on call completion. No existing table changes shape — this sits alongside.

---

## 7. The inbound contract — `POST /api/leads/ingest`

The single most important thing in v1. Get this right and every future source is free.

- **Auth:** per-org API key (new, scoped to lead ingest) — safe to hand to a client's form/CRM/Pipedream.
- **Body:** `{ phone, name?, fields{}, source, externalId?, triggerWorkflow? }`.
- **Behavior:** validate `fields` against the org's intake schema (reject/flag regulated keys) → **upsert** by `(orgId, phone)` → **idempotent** on `externalId` (so a retrying source doesn't double-create) → optionally enqueue a workflow/call → return the lead id.
- **Independently testable:** full curl/unit coverage with no external dependency. This is why v1 isn't blocked on Pipedream.

Note: this is the **inbound twin** of the webhook-*out* outbox we already ship (`voice/webhooks.ts`). Same reliability mindset, opposite direction.

---

## 8. The Leads page (insurance projection)

A `lib/verticals.ts` entry — same config-driven pattern as Orders (nav, glossary, copy per vertical, zero JSX branching). v1 features (all selected in brainstorm):

- **List + search** leads with their captured fields as columns.
- **Per-lead detail** — aggregates all that person's calls/conversations + all captured fields.
- **Status pipeline** — new → contacted → qualified → booked → closed (editable per lead).
- **Assign to licensed advisor.**
- **Call now / trigger follow-up** — reuse the Orders page's `call-now` pattern.
- **Export to Excel** — reuse `app/export.ts` pattern; export the leads table view.
- (Manual add/edit a lead — include; it's cheap once the table + upsert exist.)

Insurance gets a `Leads` nav entry (mirrors how Shopify got `Orders`, gated in `verticals.ts`).

---

## 9. Pipedream inbound recipe (v1, edge only)

A documented, ready-to-activate template — not core code:
- **Recipe:** "When a lead appears in [any Pipedream-supported app: Typeform, Google Sheets, a CRM, a Facebook Lead Ad, …] → `POST` to Weeber `/api/leads/ingest` with the org API key."
- Ships as a template + docs; flip on when a client needs a source we don't natively cover.
- If a Pipedream account is available during build, point it at a staging `ingest` for one real end-to-end test; if not, the endpoint + recipe still ship (endpoint tested standalone).
- Compliance/cost note: Pipedream Connect is SOC 2 Type II / HIPAA (BAA) / GDPR; still keep it on the edge, and never let it carry regulated fields (the `ingest` schema validation blocks those regardless of source).

---

## 10. Phased roadmap

**Phase 1 — the owned core (build first):**
1. `leads` + `leadIntakeSchemas` tables (+ migration), `calls.leadId`.
2. Insurance default intake schema (§5) in `verticals.ts`-style config.
3. `POST /api/leads/ingest` — validated, deduped, idempotent, source-tagged, per-org key. Full tests.
4. Promote `capturedState` → `leads.fields` on call completion; associate calls by `(orgId, phone)`.
5. Leads page projection: list/search, detail, pipeline, assign, call-now, Excel export, manual add/edit.

**Phase 2 — edges & config polish:**
6. Pipedream inbound recipe template + docs (activate against a real source).
7. Per-org / per-agent intake schema **editor** UI (Phase 1 ships the config; this makes it merchant-editable) with compliance blocklist.
8. Inbound webhook-in docs (client's own system → `ingest`).

**Phase 3 — reach:**
9. Native hosted/embeddable intake **form** (thin client of `ingest`, zero backend change).
10. **Outbound** CRM mirror: push `leads` → Pipedrive/HubSpot/etc via existing native adapters (the earlier integrations-roadmap doc). Leads table is source of truth; CRM is the mirror.
11. Migrate Shopify Orders onto the generic leads layer (Orders becomes a projection).

---

## 11. Guardrails (fixed regardless of source/sink)

- **DB is source of truth. Excel/CRM/Pipedream are projections and edges, never the store.**
- **Regulated fields blocked at the schema layer** (SSN/PAN/Aadhaar/bank/full DOB/health) — enforced on *every* ingest path, including Pipedream/webhook, not just agent calls.
- **One inbound contract (`ingest`).** No source special-cased into the core.
- **Per-org scoped API keys** for ingest; a leaked key affects one org, is revocable, and can't read other orgs.
- **Idempotent ingest** (dedup by `(orgId,phone)` + `externalId`) so retrying sources don't duplicate leads.

---

## 12. Open questions to resolve during build

- Advisor model: is `assignedAdvisorId` a real user/team-member record, or a free-text name for now? (Affects whether we need a team/advisor table.)
- Pipeline stages: are the 5 (new/contacted/qualified/booked/closed + lost) fixed, or per-org configurable later?
- Do we auto-advance status from call dispositions (e.g. booked disposition → `booked`), or leave status fully manual in v1?
- Does `ingest` triggering a call need to respect the same compliance dial-gates (DNC/TCPA/quiet hours) as agent-initiated calls? (Answer is almost certainly yes — flag to wire it through the existing gate.)
