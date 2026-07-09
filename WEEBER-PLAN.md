# WEEBER-PLAN.md — Shopify Vertical Build Plan

This is the working plan for turning this fork into Weeber's live Shopify-vertical backend. See ADR-030 in
`DECISIONS.md` for the full reasoning behind every decision below — this doc is the assignable, execution-
level version of it.

## What's already scaffolded in this repo (read before building)

- `packages/web/src/api/database/schema.ts` — `orgs`, `shopLinks`, `shopifyContacts`,
  `shopifyDiscountCodes`, `shopifyWebhookEvents` tables, plus `orgId`/`metadata` columns on
  `calls`/`scheduledCalls`. Run `bun run db:generate && bun run db:push` (from `packages/web`) to apply.
- `packages/web/src/api/integrations/shopify/` — `routes.ts` (all 9 contract-defined webhook receivers),
  `client.ts` (calls back into weebersh), `secret-auth.ts`, `idempotency.ts`.
- `packages/web/src/api/voice/tools/offerCartRecoveryDiscount.ts`,
  `packages/web/src/api/voice/tools/confirmCodOrder.ts` — the two new agent tools.
- Workflow engine (`packages/web/src/api/voice/workflows/`) extended with `onExhausted` on retries and
  `orgId`/`metadata` threaded through the full call lifecycle.
- `railway.json`, `supabase/` (config.toml, KB bucket migration, one example edge function), `.env.example`
  updated with every new var this needs.

## The 3 Shopify agents

| Agent | Trigger | Direction | Delay (default) | Max attempts | Tool(s) | Ends by |
|---|---|---|---|---|---|---|
| **Cart Recovery** | `checkouts/create`\|`update` webhook | Outbound | 45 min after abandonment | 2 | `offerCartRecoveryDiscount` | Caller completes purchase (auto-canceled if `orders/create` arrives first), or max attempts exhausted (no action — a missed cart recovery just means no recovery call, no punitive follow-up) |
| **COD Confirmation** | `orders/create` webhook, when gateway is `cash_on_delivery`/`cod` or `financial_status` is `pending` | Outbound | 30 min after order placed | 3 | `confirmCodOrder` (tags order via weebersh on confirm) | Confirmed (tagged `cod-confirmed`), or all 3 attempts exhausted -> order auto-canceled via weebersh's `/orders/cancel` (`onExhausted` webhook) |
| **Feedback** | `orders/fulfilled` webhook | Outbound | 3 days after fulfillment | 1 (no retry — a missed feedback call just means no feedback this time) | `captureField` (existing, generic — no new tool needed) | Call ends; captured rating/comments land in the call's `capturedState` same as any other call |

All three are plain `scheduledCalls` rows (`workflowName` = `shopify-cart-recovery` / `shopify-cod-
confirmation` / `shopify-feedback`) — the existing 60-second sweep (`workflows/scheduler.ts`) picks them up,
runs the same DNC + TCPA calling-window compliance gate every other outbound call in this codebase goes
through, and dials. No new scheduling infrastructure was built; this was the point of reusing what already
exists.

### Personas / prompts (still needed — not written yet)

The actual system-prompt text for each of the 3 personas (`AGENT_PERSONAS` env var, or wherever the
form-based config UI ends up writing to — see "Config storage" below) isn't drafted in this scaffold. That's
copywriting/prompt-engineering work, not architecture — assign it to whoever's closest to the actual call
scripts you want, informed by the tone/persona-preset pattern already documented in the technical reference.

## Config storage — the one thing to decide before building the form UI

Today, persona text and workflow configs (`AGENT_PERSONAS`, `WORKFLOWS`) are **env-var JSON, edited by hand,
requiring a redeploy.** That's fine for a single self-hosted operator; it does not work for a merchant-facing
"zero setup" onboarding form, since merchants can't edit your Railway env vars.

**Before building the form-based config UI, move persona/workflow config from env-var to a DB table**
(straightforward — a `personaConfigs`/`workflowConfigs` table keyed by `orgId`, read at call-time instead of
from `process.env`). This is the actual prerequisite for the form UI, not the form UI itself. Size: small
(2-4 days) — flagging it explicitly here so it doesn't get missed as "oh, we still need X" mid-build.

## Assignable workstreams (parallel-friendly)

| Workstream | Depends on | Notes |
|---|---|---|
| **A. Config storage (env-var -> DB) + form-based agent config UI** | Nothing (can start immediately) | The actual bottleneck for merchant-facing onboarding. See above. |
| **B. Persona/prompt copy for the 3 agents** | Nothing | Pure content work, fully parallel with everything else. |
| **C. Wire real Supabase project** (Storage bucket, Auth) | Nothing | Create the project, run `supabase link` + `supabase db push` against `supabase/migrations/`, wire `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`. |
| **D. Railway deploy** | Nothing | Point Railway at this repo, set env vars from `.env.example`, confirm `/api/health` responds, confirm the Twilio Media Stream WebSocket actually works from a real Railway URL (this is the one thing that must be tested live — WebSocket behavior through Railway's edge hasn't been verified yet). |
| **E. Vercel deploy + frontend API base URL fix** | D (needs Railway's URL) | Add `VITE_API_BASE_URL`, update the dashboard's fetch calls from relative (`/api/...`) to absolute (`${VITE_API_BASE_URL}/api/...`) — grep for `fetch("/api` in `packages/web/src/web` to find every call site. |
| **F. Get real `WEEBER_INTERNAL_SECRET`/`WEEBER_CALLBACK_SECRET` values in place in both repos** | Nothing | Coordinate with whoever owns the weebersh deploy — these must match exactly in both places or every webhook 401s. |
| **G. End-to-end test against a real (dev-store) Shopify checkout** | D, F | Install weebersh on a Shopify dev store, abandon a checkout, confirm a `scheduledCalls` row appears with the right `runAt`/`metadata`. |

A, B, C, D, F can all start in parallel with no dependency on each other — that's most of the list. E needs D
done first (needs a real Railway URL to point at). G is the integration test, needs D and F both done.

## Phase 2 / explicitly deferred — don't build these now, don't forget them either

Everything below was deliberately cut for this round (per direction: drop heavy multi-tenant, ship faster,
layer in compliance/completeness as you go). Listed here so it's a backlog, not a silent gap:

- **Per-tenant Twilio sub-accounts** — all orgs currently share the pool of numbers configured via
  `TWILIO_PHONE_NUMBER`/per-number config. Fine for early merchants; revisit once volume or a specific
  merchant's compliance needs (e.g. wanting their own caller ID) demands it.
- **Per-org DNC lists** — the DNC list is currently global (one list for the whole Weeber deployment). A
  number that opts out via one merchant's calls is opted out for all merchants. This is arguably *more*
  conservative than per-org lists (errs toward not calling), so it's a reasonable interim state, but isn't
  strictly correct TCPA modeling long-term (consent is per business relationship). Revisit before this
  becomes a compliance question with a real regulator or lawyer involved, not after.
- **Full RBAC / multi-seat merchant accounts** — one owner login per org for now.
- **Checkout-token-based cancellation matching** (currently phone-number-only — see ADR-030's "known gaps").
- **Order-value attribution** for recovered carts (marking a completed call "recovered" with the order's
  value) — needed for any dashboard number claiming a cart-recovery revenue figure. Don't publish a recovery-
  rate metric to merchants until this exists; the data isn't captured yet.
- **Org-scoped GDPR erasure reaching into `calls`/`transcripts`** — today only `shopifyContacts` rows get
  redacted per-org; call/transcript erasure uses the base repo's existing (global, phone-number-keyed) path.
- **Per-org outbound caller ID** (currently single global `TWILIO_PHONE_NUMBER` for every Shopify agent call).
- **The `gdpr-redact-notify` edge function** exists as a stub only — not called from `/customers/redact` yet.

## Immediate technical debt to flag, not hide

- `packages/web/vercel.json` builds only the static frontend — it does not serve `/api/*`. Once Vercel +
  Railway are both live, the dashboard's own fetch calls need an absolute backend URL (see workstream E).
  Until that's fixed, the dashboard will look broken if deployed to Vercel alone without Railway wired in.
- The Railway WebSocket path for Twilio Media Streams has not been tested against a real Railway deployment
  yet in this scaffold — it's architecturally sound (Railway runs a normal long-lived container, unlike
  Vercel's serverless functions), but "should work" isn't the same as "verified." Test this first, before
  building anything on top of it.
