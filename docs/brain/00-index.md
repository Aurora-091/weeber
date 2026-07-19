---
doc: brain-index
status: evergreen
updated: 2026-07-19
---

# Brain index — task → files router

> Don't guess which doc is relevant. Find your task below, read only those files, then act. This keeps
> your context window on-target instead of loaded with 170KB of history. If your task isn't listed,
> start from `AGENTS.md`'s map table.

## The brain itself (always relevant)

- `AGENTS.md` (repo root) — entry point, rules, commands, map.
- `project-brief.md` — what Weeber is, non-negotiables, glossary, STOP-AND-ASK gates.
- `active-context.md` — current focus / next step (read every session).
- `progress.md` — done / next / known issues.

## By task

| Working on… | Read (in order) |
|---|---|
| **The call pipeline** (STT/LLM/TTS, barge-in, streaming) | `../../architecture/voice-orchestration.md` → `../reference/state-engine.md` → `../reference/configuration.md` → code in `packages/api/src/voice/` |
| **A new/changed agent persona** | `../agent-prompts/` (the persona files) → `project-brief.md` (STOP-AND-ASK #4) → `packages/api/src/database/seed.ts` (do NOT move the prompts folder — seed resolves it by relative path) |
| **A new vertical** | `../decisions/adr-031-*.md` (vertical-agnostic seam) → `packages/web/src/web/lib/verticals.ts` → `agentTemplates` in `schema.ts`. Add rows, not code paths. |
| **A new ecommerce platform** (Woo/BigCommerce/Dukaan) | `project-brief.md` (platform-agnostic rule) → the Shopify integration in `packages/api/src/integrations/shopify/` as the pattern → `../reference/contract.md` |
| **Shopify integration / weebersh contract** | `../reference/contract.md` → `packages/api/src/integrations/shopify/` → remember to bump the contract version in BOTH repos |
| **Leads / records layer / CRM ingest & sync** | `../decisions/adr-061-*.md` → `../product-strategy/native-leads-layer-plan-2026-07-19.md` → `../integrations/leads-ingest-api.md` + `pipedream-inbound-recipe.md` → `leads`/`leadIntakeSchemas`/`leadApiKeys` in `schema.ts` + `packages/api/src/voice/leads/` |
| **Integrations strategy** (inbound Pipedream vs native adapters, Pipedrive) | `../product-strategy/integrations-strategy-and-roadmap-2026-07-19.md` |
| **Scheduling / retries / outbound cadence** | `packages/api/src/voice/workflows/scheduler.ts` → `../decisions/adr-026-*.md` (session store) → `scheduledCalls` in `schema.ts`. The "queue" is the in-process sweep. |
| **Compliance (DNC/TCPA/HIPAA/GDPR)** | **STOP-AND-ASK first** → `../reference/compliance.md` → `../compliance/global-compliance-engine-plan.md` → `packages/openvent-compliance/` |
| **Database schema** | `packages/api/src/database/schema.ts` → additive-only rule → `db:push`. Semantics-changing? → write an ADR. |
| **Auth** | `../reference/security.md` → `packages/api/src/app/middleware/supabase-auth.ts`. Admin-key auth and Supabase user auth are two separate systems — don't merge. |
| **Frontend / dashboard** | `../../architecture/README.md` (the /dashboard + /app tree) → `UI-DESIGN-BRIEF.md` → `../reference/dashboard.md`. HTTP only via `web/lib/api.ts`. |
| **Telephony providers** (Twilio/Plivo/Exotel) | `../voice-quality/india-telephony.md` → `../decisions/adr-048-*.md`/`adr-049-*.md` → `packages/api/src/voice/` transport code |
| **Voice quality / latency / Hindi-Hinglish** | `../voice-quality/hindi-hinglish-voice-support.md` → `../voice-quality/llm-provider-latency-case-study-2026-07-17.md` |
| **Infra / hosting / capacity / cost** | `../reference/resources.md` (the grounded infra truth) → `../decisions/adr-034-*.md` |
| **Env / config surface** | `.env.example` → `../reference/configuration.md` |
| **Billing / payments** | `../decisions/adr-034-*.md` (Razorpay first, Dodo later behind an adapter) |
| **Understanding "why is this like this?"** | `../decisions/README.md` → the specific ADR. Almost every surprise is a documented decision. |
| **The phase roadmap (built vs open)** | `../../WEEBER-PLAN.md` |

## Where each kind of record goes

- A **decision** (chose between real alternatives; touches architecture/compliance/data-model/UX) →
  new `../decisions/adr-NNN-slug.md` + a row in `../decisions/README.md`. Never rewrite a shipped ADR.
- **Routine feature work** (new table/column, endpoint param, wiring an already-decided pattern) → a
  dated entry in the current month's `../changelog/` file.
- **Current focus / next step** → `active-context.md`.
- **Status change** (done/next/known issue) → `progress.md`.
