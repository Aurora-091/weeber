# WEEBER-PLAN.md — Shopify Vertical Build Plan

> **STATUS (2026-07-13): partially stale — see the workstream table below for what's actually done.**
> Workstreams B, C, D, E, H, J, K, L, M, N, O are all **DONE** (verified against current code, several
> were previously marked open/remaining in this doc when they'd already shipped). Workstreams F, G, I,
> P, Q, R, S are still genuinely open as of this update — G and I in particular need a real answer
> from outside this sandbox (manual QA / a compliance-lawyer-style confirmation), not more code.
> Also: `VerticalDefinition.dashboard.metrics/cards` (mentioned under workstream A's spirit) is defined
> in `verticals.ts` but **not actually read by `home.tsx`** — dead config, flagged in the tech-debt
> section below, not previously known.

This is the working plan for turning this fork into Weeber's live Shopify-vertical backend. See ADR-030 in
`DECISIONS.md` for the full reasoning behind every decision below — this doc is the assignable, execution-
level version of it.

## What's already scaffolded in this repo (read before building)

- `packages/api/src/database/schema.ts` — `orgs`, `shopLinks`, `shopifyContacts`,
  `shopifyDiscountCodes`, `shopifyWebhookEvents` tables, plus `orgId`/`metadata` columns on
  `calls`/`scheduledCalls`. Run `bun run db:generate && bun run db:push` (from `packages/api`) to apply.
- `packages/api/src/integrations/shopify/` — `routes.ts` (all 9 contract-defined webhook receivers),
  `client.ts` (calls back into weebersh), `secret-auth.ts`, `idempotency.ts`.
- `packages/api/src/voice/tools/offerCartRecoveryDiscount.ts`,
  `packages/api/src/voice/tools/confirmCodOrder.ts` — the two new agent tools.
- Workflow engine (`packages/api/src/voice/workflows/`) extended with `onExhausted` on retries and
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
requiring a redeploy.** That's fine for a single self-hosted operator; it does not work for a user-facing
"zero setup" onboarding form, since users can't edit your Railway env vars.

**Before building the form-based config UI, move persona/workflow config from env-var to a DB table**
(straightforward — a `personaConfigs`/`workflowConfigs` table keyed by `orgId`, read at call-time instead of
from `process.env`). This is the actual prerequisite for the form UI, not the form UI itself. Size: small
(2-4 days) — flagging it explicitly here so it doesn't get missed as "oh, we still need X" mid-build.

## Assignable workstreams (parallel-friendly)

| Workstream | Depends on | Notes |
|---|---|---|
| **A. Config storage (env-var -> DB) + form-based agent config UI** | Nothing (DB is live) | The actual bottleneck for user-facing onboarding. Backend half (tables + read path) first; the form UI waits for the frontend round. Wire `docs/agent-prompts/` in as the seed data. |
| ~~B. Persona/prompt copy~~ | — | **DONE** — `docs/agent-prompts/01..03` (commit bc5600a); feedback agent still flagged needs-review. |
| ~~C. Wire real Supabase project~~ | — | **DONE** — production is `openvent2` (`wtqohdcghmxuujqyhlkz`, ap-south-1 Mumbai), schema applied, service connected via pooler. Staging project still to create. |
| ~~D. Railway deploy~~ | — | **DONE** — `weeber-backend` project, api service (Singapore) from Aurora-091/openvent, domain `api-production-c1bb.up.railway.app`, health + WS-through-edge verified live, all provider keys set. |
| **E. Vercel deploy** | Frontend round | **DONE** — three Vercel projects live (`www`/`admin`/`app` subdomains per the 2026-07-13 Merchant→User rename), `CORS_ALLOWED_ORIGINS` set on Railway to all three, verified live. |
| **F. Real `WEEBER_INTERNAL_SECRET`/`WEEBER_CALLBACK_SECRET` in both repos** | Nothing | Coordinate with the weebersh deploy — must match exactly in both places or every webhook 401s. |
| **G. End-to-end test against a real (dev-store) Shopify checkout** | F | Install weebersh on a Shopify dev store, abandon a checkout, confirm a `scheduledCalls` row appears with the right `runAt`/`metadata`. **Still open — this needs a real manual run, can't be verified from a sandbox.** |
| ~~H. Turso → Supabase Postgres migration~~ | — | **DONE (ADR-034)** — pgTable schema live in Mumbai, 14 tables, driver swapped, tests green. RLS policies for `orgId` scoping still worth considering (fits N/Q work). |
| **I. India-compliance review of the calling-window/DNC model** | Nothing (research); hard gate before first real India user campaign | TRAI territory: NDNC/DND registry, 9am-9pm IST norms, 140-series telemarketing headers. Touches `packages/openvent-compliance` — confirm findings with the user before changing anything there. **Code exists (`calling-window.ts` has IST calling-window logic) but whether findings were ever actually confirmed with the user is unclear — still flag as open until that's explicit.** |
| ~~J. Checkout-token-based cancellation matching~~ | — | **DONE** — `scheduledCalls.checkoutToken` column + index, cancellation matches by checkout token first with phone-number fallback (`integrations/shopify/routes.ts`, covered by tests). |
| ~~K. Order-value attribution for recovered carts~~ | — | **DONE** — `scheduledCalls.recoveredOrderId`/`recoveredAmount` columns, order value attributed to the executed cart-recovery call within a 7-day window (covered by tests). |
| ~~L. Org-scoped GDPR erasure into `calls`/`transcripts`~~ | — | **DONE** — `eraseOrgDataForPhoneNumber(orgId, phoneNumber)` scopes `caller_memory`/calls/transcripts deletes by org, not just phone number (covered by tests, audit #02's D2 regression). |
| ~~M. Wire `gdpr-redact-notify` edge function to `/customers/redact`~~ | — | **DONE** — `/customers/redact` fires a resilient, fire-and-forget call to the edge function (`integrations/shopify/routes.ts`). |
| ~~N. Per-org outbound caller ID~~ | — | **DONE** — real dial-time number resolution wired into `twilio-client.ts`/`admin-routes.ts`/`app/routes.ts`, not just a stub. |
| ~~O. Per-tenant Twilio sub-accounts / BYO number provisioning~~ | N | **DONE** — `voice/twilio-provisioning.ts`: real sub-account creation under the platform's parent account, org-scoped number purchase, `orgs.twilioMode` (`platform`/own sub-account). |
| **P. Per-org DNC lists** | I (India model shapes it) | Consent is per business relationship — global list is conservative but wrong long-term. **Touches `packages/openvent-compliance` — user confirmation gate applies.** ~1 week. **Still open** — `do_not_call` table has no `orgId` column as of this update; it's a single global list. |
| **Q. Full RBAC / multi-seat user accounts** | Supabase Auth wiring (frontend round) | Roles on top of user login. 2-3 weeks. Sequence with the frontend auth work, not before it. **Still open** — `org_members.role` defaults to `"owner"` only, no invite/multi-seat flow exists. |
| **R. Per-org CRM connections (Nango embedded iPaaS)** | Nothing (spike) | Research spike 2-3 days, then 1-2 weeks: per-org tokens behind the existing adapter interface, not a rebuild of the integrations. **Still open** — HubSpot/Salesforce/GoHighLevel/Google Calendar adapters (`voice/integrations/*.ts`) all still read one shared, globally-configured token; no Nango or per-org OAuth exists. |
| **S. Entry-condition branching ("trigger split", ADR-033)** | A (config storage is where `entryConditions` lives) | Engine change ~1 week. **Config-driven vs visual-canvas-from-day-one is still an open user decision — ask before starting (gate #4).** **Still open** — no `entryConditions` anywhere in the codebase as of this update; the Workflow Canvas that did ship (`docs/workflow-canvas-architecture.md`) branches on *call outcome*, not on entry conditions at flow-start — a different capability, doesn't substitute for this. |

Everything is now Phase 1 (ADR-037) — but sequencing still matters. Backend-first order per explicit
direction: A (backend half), J, K, L, M, N are all parallel-friendly and unblocked today; F unblocks G;
I runs as research now and gates real India campaigns; O/P/S follow their dependencies; E/Q wait for the
frontend round. The compliance-package gate (CLAUDE.md #6) and the trigger-split decision gate (#4) survive
the merge unchanged.

## Merged backlog detail (formerly "Phase 2" — merged into Phase 1 by ADR-037)

> **Note (2026-07-13): J, K, L, M, N, O below are DONE — see the workstream table above for current
> status and where each landed in code. This section is kept verbatim for its original reasoning on
> *why* each item matters, not as a current TODO — only P, Q, R, S are still open.**

Full reasoning for workstreams J-S above, kept verbatim since the constraints haven't changed — only the
scheduling has:

- **Per-tenant Twilio sub-accounts** — all orgs currently share the pool of numbers configured via
  `TWILIO_PHONE_NUMBER`/per-number config. Fine for early users; revisit once volume or a specific
  user's compliance needs (e.g. wanting their own caller ID) demands it.
- **Per-org DNC lists** — the DNC list is currently global (one list for the whole Weeber deployment). A
  number that opts out via one user's calls is opted out for all users. This is arguably *more*
  conservative than per-org lists (errs toward not calling), so it's a reasonable interim state, but isn't
  strictly correct TCPA modeling long-term (consent is per business relationship). Revisit before this
  becomes a compliance question with a real regulator or lawyer involved, not after.
- **Full RBAC / multi-seat user accounts** — one owner login per org for now.
- **Checkout-token-based cancellation matching** (currently phone-number-only — see ADR-030's "known gaps").
- **Order-value attribution** for recovered carts (marking a completed call "recovered" with the order's
  value) — needed for any dashboard number claiming a cart-recovery revenue figure. Don't publish a recovery-
  rate metric to users until this exists; the data isn't captured yet.
- **Org-scoped GDPR erasure reaching into `calls`/`transcripts`** — today only `shopifyContacts` rows get
  redacted per-org; call/transcript erasure uses the base repo's existing (global, phone-number-keyed) path.
- **Per-org outbound caller ID** (currently single global `TWILIO_PHONE_NUMBER` for every Shopify agent call).
- **The `gdpr-redact-notify` edge function** exists as a stub only — not called from `/customers/redact` yet.
- **Per-org CRM connections (embedded iPaaS).** Today's CRM integrations (HubSpot, Salesforce,
  GoHighLevel, Google Calendar) each use one shared, globally-configured access token — fine for a single
  self-hosted operator, not fine once a user wants to connect *their own* HubSpot/Salesforce account
  instead of a shared one. Per-org OAuth (per-org encrypted token storage, per-org refresh handling) is a
  genuinely different, harder problem than the current setup — don't build it from scratch. Evaluate
  **Nango** (open source, self-hostable, purpose-built for "let your SaaS users connect their own accounts")
  as the credential layer sitting underneath the existing `resilientCall`/adapter pattern — this would
  replace "one global token in an env var" with "per-org token, fetched by the same adapter interface,"
  not a rebuild of the integrations themselves. Size: research spike (2-3 days) + integration (1-2 weeks) —
  not urgent until a user actually asks to connect their own CRM, but worth knowing the answer before
  that request arrives rather than scrambling then.
- **Entry-condition branching ("trigger split") for workflows.** Researched against Klaviyo's and Shopify
  Flow's flow-builder models (see ADR-033). Today's `WorkflowConfig` can branch on *how a call ended*
  (`onOutcome`) and retry/give-up (`onExhausted`, ADR-030), but cannot branch on conditions *at the moment a
  flow starts* — e.g. "if cart value > $100, use a bigger discount and a different persona; otherwise don't
  offer one at all." This is the real gap the Klaviyo/Shopify Flow research surfaced, and it's not
  Shopify-specific — any future vertical's agent benefits from the same capability. Scope: add an optional,
  generic `entryConditions` concept to `WorkflowConfig`/`agentTemplates` (a simple field-comparison — e.g.
  `{ field: "cartValue", operator: "gt", value: 100 }` — evaluated against the `scheduledCalls.metadata`
  JSON blob already in place, not a full expression language) that resolves to a chosen persona/tool-set
  variant before the first call is placed. **Build this as a config-driven capability first** (JSON, same
  as today's `WORKFLOWS` env var, or wherever the config-storage migration lands — see "Config storage"
  above); a visual canvas (React Flow, MIT-licensed, the standard library for exactly this) is a legitimate
  follow-up once the underlying branching actually works, not a prerequisite for it. Size: engine change
  ~1 week, config-UI-for-it is separate and comes after. **Ask the user before deciding config-only vs.
  visual-canvas-from-the-start** — this was flagged as an open call in `CLAUDE.md`'s gate list, not decided
  here.

## Immediate technical debt to flag, not hide

- ~~`vercel.json` (repo root) builds only the static frontend~~ **Superseded (2026-07-13):** the
  deployment model moved to three separate Vercel projects (`www`/`admin`/`app` subdomains) with the
  API served entirely from Railway, not from a Vercel rewrite — see `changelog.md`'s Merchant→User
  rename entries. This bullet's original concern no longer applies to the current architecture.
- ~~Railway WebSocket path untested~~ **Verified live (2026-07-10):** WS upgrade completes (101) through
  Railway's edge on the production domain.
- Staging environment exists on Railway but its `DATABASE_URL` is a placeholder — create a staging Supabase
  project and mirror the production wiring before using staging for anything real. **Still open as of
  2026-07-13 — not re-verified this update, flagging as unconfirmed rather than assuming it's fixed.**
- **New (2026-07-13):** `VerticalDefinition.dashboard.metrics`/`dashboard.cards`/`dashboard.emptyState`
  (`packages/web/src/web/lib/verticals.ts`) is defined for both the `shopify` and `insurance` verticals
  but **`pages/app/home.tsx` never reads it** — grepped for `vertical.dashboard`, `dashboard.metrics`,
  the literal metric labels ("Carts recovered", "Revenue recovered") — none appear in `home.tsx`. This
  contradicts `USER-APP-PAGE-MAP.md`'s 2026-07-12 update note, which claimed the Home page's content
  was already config-driven per vertical from this field — it wasn't actually wired up, only the type/
  data shape landed. Small fix once picked up: read `vertical.dashboard` in `home.tsx` instead of
  whatever it renders today.
