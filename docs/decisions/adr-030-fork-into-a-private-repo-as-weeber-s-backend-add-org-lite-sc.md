---
adr: 30
title: "Fork into a private repo as Weeber's backend, add org-lite scoping + the Shopify vertical (cart recovery, COD confirmation, feedback)"
date: 2026-07-09
status: Accepted
---

## ADR-030 — Fork into a private repo as Weeber's backend, add org-lite scoping + the Shopify vertical (cart recovery, COD confirmation, feedback)

**Date:** 2026-07-09

**Context:** Per the "Weeber's Voice Runtime" decision report (LiveKit vs. Pipecat vs. ElevenLabs Agents vs.
Vent), Weeber's backend is being built on this codebase rather than migrating to an external platform — the
compliance layer here is the actual product differentiator and already exists, tested. This repo (`openvent`,
private) is that fork: same architecture, same compliance package, extended with what Weeber specifically
needs that a generic self-hosted framework doesn't: org scoping and the Shopify vertical's three call flows.

Two scope decisions were made deliberately narrow, on explicit direction, to ship faster:

1. **Full multi-tenant isolation (per-tenant Twilio sub-accounts, per-org DNC lists, per-org billing
   entities, full RBAC/multi-seat accounts) is out of scope for this round.** Individual Shopify merchants
   don't need any of that on day one — one owner login per merchant, one shared pool of Twilio numbers, one
   shared DNC list. What's NOT droppable: basic `orgId` scoping on every table that holds merchant data
   (`calls`, `scheduledCalls`, `shopifyContacts`) — retrofitting that onto an already-single-tenant schema
   later is a materially bigger, riskier migration than building it in now while the tables are new. This is
   the actual scope of "org-lite" throughout this ADR and the schema: enough to never leak Merchant A's data
   into Merchant B's queries, nothing more.
2. **The builder is form-based agent config, not a visual flowchart/canvas.** No visual builder exists in
   this codebase at all today (verified — no flow/canvas component anywhere in `packages/web`); agent
   behavior is currently `AGENT_PERSONAS`/`WORKFLOWS` env-var JSON, code-first, no UI. A form-based config UI
   (persona/tone/tools/KB fields, one per agent) is a smaller build than a node-based canvas and is
   sufficient for three fixed, curated agent templates — a canvas only earns its cost if merchants need to
   design their own conversation branching, which isn't the v1 pitch ("zero merchant setup").

The Shopify vertical's three agents are derived directly from the already-versioned wire contract with the
`weebersh` connector app (github.com/Aurora-091/weebersh, `docs/contract.md` v1.4) — not invented for this
round. That contract already assumes an `org_id` concept (`ShopOrgLink` table on weebersh's side) and defines
exactly which Shopify events exist and what Weeber must do with each: **cart recovery** (checkouts
created/updated), **COD confirmation** (orders placed with a cash-on-delivery/pending-payment gateway), and
**feedback** (orders fulfilled, delayed). weebersh also holds and refreshes the actual Shopify access token
itself — Weeber never touches it directly, only calls back into weebersh's own write-back endpoints
(annotate/cancel/create-discount) authenticated by a separate rotatable secret.

**Decision:**

*Schema (additive only, no renames/drops):*
- `orgs`, `shopLinks` (mirrors weebersh's `ShopOrgLink`, shop -> org lookup), `shopifyContacts` (customer
  upsert target, unique on `(orgId, e164)`), `shopifyDiscountCodes` (idempotency ledger for issued discount
  codes), `shopifyWebhookEvents` (generic idempotency ledger for the at-least-once webhook contract, unique
  on `(shop, topic, idempotencyKey)`).
- `orgId` (nullable text) added to `calls` and `scheduledCalls`; `metadata` (nullable JSON) added to
  `scheduledCalls` for vertical-specific workflow context (e.g. `{ shop, orderId, checkoutToken }`) — generic
  by design so any future vertical/workflow reuses the same column instead of growing the table per feature.

*Core engine changes (small, additive, documented here because they touch shared files, not just new ones):*
- `CallSession` (session-store.ts) gained `orgId`/`workflowMetadata` fields, threaded through
  scheduler.ts -> stream.ts/routes.ts -> `runWorkflowForOutcome` -> engine.ts's retry-insert, so a workflow
  retry chain (e.g. COD confirmation's 3 attempts) keeps its Shopify context on every attempt, not just the
  first. Without this, a retried call would lose track of which `shop`/`orderId` it was calling about.
- `WorkflowAction`'s `retry` variant gained an optional `onExhausted` (`webhook` or `addToDnc`), fired once
  when a retry chain gives up. This is what lets COD confirmation cancel an unconfirmed order after N failed
  attempts (via a webhook back into this repo's own `/internal/cod-confirmation-exhausted` route) without
  putting Shopify-specific logic inside the generic workflow engine — `onExhausted` is a generic "give up
  after N tries, then do X" primitive any future workflow can reuse the same way.
- Both changes are backward compatible: `orgId`/`metadata`/`onExhausted` are all optional, so existing
  self-hosted OpenVent workflow configs and calls with none of this set behave identically to before.

*New module — `packages/web/src/api/integrations/shopify/`:*
- `routes.ts` — all 9 outbound-direction contract endpoints (`/connected`, `/webhooks/checkouts`,
  `/orders/create`, `/orders/fulfilled`, `/webhooks/customers`, `/uninstalled`, `/customers/redact`,
  `/shop/redact`, `/customers/data_request`), each authenticated via `X-Weeber-Secret`
  (`secret-auth.ts`) and idempotency-checked (`idempotency.ts`) per the contract's at-least-once delivery
  guarantee, mounted at `/api/integrations/shopify/*`.
- `client.ts` — the inbound direction (Weeber calling weebersh's `/orders/annotate`, `/orders/cancel`,
  `/discounts/create`), authenticated via the separate `X-Weeber-Callback-Secret`.
- Two new voice tools (`offerCartRecoveryDiscount`, `confirmCodOrder`) following the existing
  `bookAppointment`/CRM-integration tool pattern (real API call inside `execute`, resilient to failure without
  crashing the call). The feedback agent needs no new tool — it reuses the existing generic `captureField`
  tool, since post-delivery feedback is just free-form fact capture, already built.
- All three agents are just `scheduledCalls` rows with a `workflowName` — zero scheduler changes needed
  beyond what's described above; the existing sweep (DNC + calling-window gated) already handles dispatch,
  retries, and now (via `onExhausted`) give-up behavior uniformly.

*Infra (Vercel + Railway + Supabase, per explicit direction):*
- **Vercel** — frontend only (the existing static Vite build, `vercel.json` unchanged). Note: splitting
  frontend (Vercel) from backend (Railway) means the dashboard's fetch calls need an absolute API base URL
  instead of same-origin relative paths — not yet done, flagged as a small mechanical follow-up in
  WEEBER-PLAN.md.
- **Railway** — the backend (Bun/Hono server, Twilio Media Streams WebSocket, the scheduler sweep). Runs
  directly via `bun run start:railway` (new script), deliberately NOT through `pm2`/`ecosystem.config.cjs` —
  Railway's own container supervisor already handles restarts (`railway.json`'s `restartPolicyType`), and
  running pm2 inside a platform-supervised container is redundant and can interfere with graceful
  SIGTERM handling during deploys.
- **Supabase** — Storage (KB PDF uploads, a private `kb-documents` bucket, migration included) and Auth
  (intended to back real merchant login later, replacing labeled admin keys for the merchant-facing
  dashboard specifically — `ADMIN_API_KEY`/`admin_keys` stays as-is for Weeber's own internal ops access) and
  Edge Functions (one example stub, `gdpr-redact-notify`, NOT yet wired to the redact route — a real,
  scoped follow-up, not a hidden gap). **The core relational DB stays on Turso/libSQL** — `drizzle.config.ts`'s
  `dialect: "turso"` is unchanged. Migrating the whole schema to Supabase Postgres was considered and
  rejected for this round: it's a real dialect-level Drizzle migration (`sqliteTable` -> `pgTable`, new
  migration files) with zero functional benefit right now, since Turso already works and nothing here needs
  Postgres-specific features. Supabase is used only where it's genuinely the best tool (Storage, Auth,
  Functions), not adopted wholesale just because it was mentioned.

**Consequences:** This repo can now receive real weebersh traffic end-to-end for all three Shopify call
flows, gated by the same compliance layer (DNC + TCPA calling window) every other call in this codebase
already goes through — no separate, weaker path was created for the Shopify vertical. Known, explicitly
flagged gaps (not silently skipped): checkout-recovery cancellation matches on phone number only, not
`checkout_token` (the token isn't its own indexed column, only inside `scheduledCalls.metadata`); order-value
attribution (marking a recovered call with the order's value) isn't implemented; GDPR erasure for Shopify
contacts is org-scoped but doesn't yet reach into `calls`/`transcripts` (those use the existing, phone-number-
keyed, non-org-scoped erasure path from the base repo); outbound calls for all Shopify agents currently place
from the single global `TWILIO_PHONE_NUMBER`, not a per-org pooled number. Each of these is sized and listed
in `WEEBER-PLAN.md`'s "Phase 2 / immediate follow-ups" section, not left implicit.
