---
adr: 61
title: "Native leads layer: lean Phase 1 (ingest + api-keys re-labelled to Phase 2); orgId is the public hosted-form token; Shopify Orders migration deferred (2026-07-19)"
date: 2026-07-19
status: Accepted
---

## ADR-061 — Native leads layer: lean Phase 1; orgId as the hosted-form token; Orders migration deferred (2026-07-19)

**Context:** the native, person-centric leads/records layer (`docs/product-strategy/native-leads-layer-plan-2026-07-19.md`) was built in one pass. Three real choices between alternatives came up during the build and are recorded here (the rest of the build is routine and lives in the changelog).

---

### Decision (a) — Lean Phase 1: `ingest` + per-org API keys re-labelled Phase 1 → Phase 2

The original plan put `POST /api/leads/ingest` and per-org ingest API keys in **Phase 1 (the owned core)**. On review, the "own the data-of-record" core is: the `leads` table, promotion of captured fields at `finalizeCall`, the Leads page, and Excel export. The `ingest` endpoint is an **edge** — it only matters once an *external* source exists, and at decision time no pilot had a confirmed near-term need to push leads via API ("not sure yet").

**Decision:** re-label `ingest` + api-keys as **Phase 2**. This is a **documentation/scoping change only — nothing was removed**. The code was already written, tested, and passing, so deleting it to "re-add later" would have been pure churn (and a migration rollback) for zero benefit. Keeping it in place is zero-risk; the empty tables and unused endpoint cost nothing.

**Alternatives considered:**
- *Keep ingest/api-keys in Phase 1 (status quo).* Rejected — conflates the owned core with an edge; the core should be describable without reference to external callers.
- *Physically remove ingest/api-keys and re-add in Phase 2.* Rejected — real code churn + migration rework to un-ship working, tested code, with no upside. "Leaner" here means leaner *conceptual scope*, not less shipped code.

**Consequence:** the plan's §10 roadmap and the build trackers now show the lean core as Phase 1 and ingest/api-keys as Phase 2. Behaviour and code are unchanged.

---

### Decision (b) — The org UUID (`orgId`) is the public hosted-form token

The Phase 3 hosted intake form (`/f/:orgId`, backed by `GET/POST /api/public/leads/:orgId/form`) is public — anyone can submit a lead without logging in. It needs *some* token in the URL to name the target org.

**Decision:** use the **org's existing UUID (`orgId`)** as the public form token. It is **non-secret** (already exposed in the authenticated app), grants **only** "submit a lead to this org" (write-only, one capability), and requires **no new column or migration**.

Abuse is bounded without a secret token:
- a **honeypot** field (`_website`) — a bot that fills it gets the same `201` as a human, so it can't probe the gate;
- a **per-(ip, org) rate limit** (`hostedFormLimiter`, 10/min);
- **regulated fields are stripped** by the same `validateFields` chokepoint as every other ingest path;
- the public schema endpoint returns only field definitions + a display name — nothing org-sensitive.

**Alternatives considered:**
- *A dedicated secret form token / form-scoped API key.* Rejected for v1 — it adds a column, a migration, a rotation story, and a "where do I find my form token" support surface, to protect an endpoint whose only capability is "add a lead to a public inbox." The exposure (someone spamming an org's own lead inbox) is low-severity and already rate-limited + honeypotted. Revisit only if abuse materializes.
- *Require the `wlk_` ingest API key on the form.* Rejected — that key is a **secret**; embedding it in a public client-side form would leak it. The whole point of the hosted form is a no-secret public surface.

**Consequence:** hosted forms work with zero setup (share the `/f/:orgId` link), no migration, no key management. Accepted tradeoff: the form URL is guessable/enumerable, mitigated by honeypot + rate limit + write-only scope.

---

### Decision (c) — Migrating Shopify Orders onto the leads layer is DEFERRED

Plan item 11 was "migrate Shopify Orders onto the generic leads layer (Orders becomes a projection)."

**Decision:** **defer indefinitely** — documented-only, not built. It's a risky refactor of **working, live Shopify code** (Orders drives real cart-recovery flows), it was not requested, and no pilot needs it. The leads layer is already a superset of Orders, so this is a *later consolidation for consistency*, not a blocker for anything. Build it only when there's a concrete reason (e.g. a second ecommerce platform lands and we want one Orders codepath).

**Alternatives considered:**
- *Do the migration now for architectural purity.* Rejected — churn against working revenue-path code for a purity win with no user or pilot demand. Highest-risk item in the plan, lowest current value.

---

**Consequence / scope shipped (all three decisions):** no behaviour change from (a); (b) and (c) are as built. The full leads layer (Phases 1–3 minus item 11) shipped verified: `typecheck --force` clean, `test --force` 621 pass / 0 fail, `lint` 0/0, `build` clean.

**Related:** implements `docs/product-strategy/native-leads-layer-plan-2026-07-19.md`; extends the integrations direction in `docs/product-strategy/integrations-strategy-and-roadmap-2026-07-19.md` (Pipedream on the inbound edge, native adapters for outbound). Integration docs: `docs/integrations/leads-ingest-api.md`, `docs/integrations/pipedream-inbound-recipe.md`.
