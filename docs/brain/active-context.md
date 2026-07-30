---
doc: active-context
status: LIVE — update every session you do meaningful work
updated: 2026-07-30
---

# Active context — what's happening right now

> **The most important file for an agent picking up cold.** It answers "what were we doing, where did
> we stop, what's next." Keep it short and *current* — a stale entry here is worse than none. When you
> finish meaningful work, update the three sections below and move anything shipped into `progress.md`.

## Current focus

- **Workflow graph validation (P1) + Sentry loop closed (2026-07-30):** Shipped a shared,
  authoring-time graph validator and proved the monitoring loop end-to-end.
  **Sentry:** ran a one-off smoke test through the real `initSentry`/`captureError` +
  `Sentry.flush(5000)` → returned `true` (event delivered), env-tagged `sentry-smoketest`. Loop is
  proven working; `SENTRY_DSN` set on Railway prod+staging. Smoke-test script deleted, not committed.
  **P1 validation:** new pure module `packages/api/src/voice/workflows/graph-validation.ts`
  (`validateWorkflowGraph(graph)` → `{ issues, errors, blockers, warnings }` + `hasStructuralErrors`,
  `canActivate`; no I/O). Severity taxonomy maps to real `graph-engine.ts` runtime behavior —
  **error** (run fails/ambiguous → always block save), **blocker** (runs wrong/nothing → block admin
  save + merchant *activation*, allow draft), **warning** (engine tolerates → never blocks, surfaced).
  This is the authoring-time **belt**; `validateLockedNodesEnforced` stays the compliance **suspenders**
  and `scheduler.ts` stays the runtime enforcement — neither replaced. Wired: admin `validateGraph`
  delegates to it; merchant `PUT /workflow-configs/:templateKey` (errors→400 always, blockers→400 when
  `enabled:true`, warnings echoed in 200 body); `ai-draft` rejects drafts with structural errors only
  (blockers expected — merchant fills them in). Frontend `workflows.tsx` surfaces an amber "Saved with
  N suggestions" note. 14 new tests (`graph-validation.test.ts`). Verified: `packages/api` tsc 0 ·
  `packages/web` tsc 0 · web build ✓ · root `oxlint` 0/0 · `bun test src/voice/workflows` 110 pass/0.
  **Known pre-existing (NOT this work):** `bun test src/app` has 1 failing test
  (`supabase-auth.test.ts`, `getOrgLead` export + `db.update` mock leaking across files when the whole
  `src/app` dir runs in one invocation); reproduces on a clean tree, passes in isolation — flagged for
  a separate test-isolation fix. **Still open:** P2 template gallery at entry; **no usage analytics on
  the canvas/Customize flow** (still the highest-value gap — instrument before further tuning).

- **Workflow builder P0 UX fixes — persona dropdown + AI-draft front door (2026-07-30):** After a cold
  UX audit of the merchant workflow builder (`audit/2026-07-30-audit-08-workflow-canvas-ux.md`) +
  competitor matrix. **Decision: keep the canvas** — it's *orchestration* (the Shopify-Flow pattern
  merchants know), not conversation-flow; the fix is to stop making raw wiring the front door.
  Shipped two P0s: (1) call-node `persona` is now a **dropdown** of the org's agents instead of raw
  text (a call node could otherwise point at a non-existent agent — persona = a resolved templateKey).
  `NodeConfigPanel` took an optional `personaOptions` prop and stays presentational, so the admin
  template editor keeps the raw input (different auth); merchant canvas feeds it via new
  `useAgentPersonaOptions` (`GET /api/app/agent-configs`). (2) The AI-draft "describe your flow" bar,
  previously buried inside the canvas, is now the **primary path on the Standard View entry** →
  generate → land in canvas to edit/save. Files: `components/canvas/NodeConfigPanel.tsx`,
  `pages/app/workflows.tsx`. Verified: `packages/web` tsc 0 · build ✓ · root `oxlint` 0/0.
  **Still open:** P1 graph validation, P2 template gallery, and — flagged highest-value — **no usage
  analytics exist on this flow**, so all of the above is reasoned from code+competitors, not observed
  sessions; instrument before tuning. `SENTRY_DSN` is set on Railway (prod+staging) but not yet proven
  end-to-end. Whether SMBs should ever see a node-graph canvas at all: deferred (canvas kept for now).

- **Workflows Standard View — affordance/legibility fixes (2026-07-30):** Follow-up to a UX audit —
  a tester got lost on the default workflow view because the read-only React Flow graph looks editable
  but only `wait/call/sms` nodes respond to a click, with no signal which. Fixed with pure
  affordance/legibility changes (no architecture change; canvas editor untouched): editable-node cue
  (hover ring + pencil + pointer cursor via a new `editable` flag on `WorkflowNode`), an orientation
  strip + legend above the graph, "Save changes" now only renders when there are unsaved edits (was a
  looks-broken disabled button on load), and the "No workflows" empty state gained a "Connect your
  store" CTA to `/app/integrations` (was a dead end). Files: `components/canvas/WorkflowNode.tsx`,
  `pages/app/workflows.tsx`. Verified: `packages/web` tsc clean · build clean · `oxlint` 0/0.
  See `changelog/2026-07.md`. **Still open (unchanged):** set `SENTRY_DSN` on Railway; the deeper
  question of whether SMBs should ever see a node-graph canvas at all (deferred, not this session).

- **App UI/UX Restructuring & Integrations Alignment (2026-07-20):** Resolved UI defects across `/app` routes.
  **Toaster Z-Index Elevation**: Elevated Sonner `Toaster` z-index to `99999` in `sonner.tsx` and `styles.css`
  so notifications float over all modal dialogs, drawers, sticky headers, and backdrop overlays.
  **Integrations Page Redesign**: Removed `bg-background` root class overrides in `integrations.tsx` (preventing
  nested double-background box artifacts) and replaced full-screen blur overlays (`fixed inset-0 z-50`) with an
  inline card-level status banner. **Route Fallbacks**: Upgraded `PageFallback` in `app.tsx` from a bare spinner
  to a structured page skeleton (`page-enter space-y-6`). Verified: `typecheck` clean · `test` 16 pass / 0 fail · `build` clean. Pushed to `origin/main`.

- **Native, person-centric leads/records layer shipped (2026-07-19, Phases 1–3):** built the *owned*
  data-of-record layer before bolting on external CRMs. New tables (`leads` deduped by
  `(orgId, phone)`, `leadIntakeSchemas`, `leadApiKeys`; `calls.leadId` plain indexed int, no FK;
  migration `0040_mushy_arclight.sql`). **Phase 1 (owned core):** captured fields promoted
  `capturedState → leads.fields` at `finalizeCall`; insurance `Leads` page (list/search, detail +
  call history, pipeline status, assign advisor, call-now, Excel export, manual add/edit).
  **Phase 2 (edges & config):** `POST /api/leads/ingest` (per-org `wlk_` key auth, schema-validated,
  regulated keys rejected, idempotent upsert; `triggerWorkflow` accepted-but-not-wired until it
  respects DNC/TCPA dial-gates) + per-org/per-agent intake-schema editor. **Phase 3 (reach):**
  public hosted form `/f/:orgId` (**`orgId` is the non-secret write-only form token** — honeypot +
  per-(ip,org) rate limit, no migration) + on-demand "Sync to CRM" mirror (HubSpot/Salesforce/GHL,
  leads stays source of truth). Scoping decisions in **ADR-061**; plan in
  `product-strategy/native-leads-layer-plan-2026-07-19.md`. Verified: `typecheck` clean · `test`
  **621 pass / 0 fail** · `lint` 0/0 · `build` clean.
- **Integrations strategy set (2026-07-19):** Pipedream on the *inbound* edge (any CRM/form → our
  ingest API), native adapters for *outbound* (CRM mirror). `product-strategy/integrations-strategy-
  and-roadmap-2026-07-19.md`; recipe in `integrations/pipedream-inbound-recipe.md`. **Pipedrive
  native adapter** flagged as the next likely inbound native adapter.
- **Insurance vertical filled out (2026-07-19):** config-driven en/hi/hinglish language variants for
  insurance agents 04–08, plus a new **Final Expense Qualifier + Warm-Transfer** agent (persona 09,
  scoped US/English-only). All 10 insurance agent prompts now live in `docs/agent-prompts/`.
- **Language support: closed/scoped (ADR-060, 2026-07-19)** — see the section below.
- **Workflow Canvas v4 Phase 3 — SHIPPED (2026-07-19), not open.** Flow preview via web call is
  built and merged (`voice/workflows/preview-walker.ts`, `components/workflow-preview/
  FlowPreviewPanel.tsx`, commits `a9dca16`/`91b13ac`; changelog `b491f15`). The whole v4 plan
  (Phases 1/2/3) is done — do not carry this forward as an open item again.
- **Still open from 2026-07-18 (carried forward):** adopt **Supabase Realtime** for the dashboard
  (decided `ADR-058`, not built — currently polls `refetchInterval` every 4–5s); **set `SENTRY_DSN`
  on Railway** (Sentry wired, no-op until the env var is set). Everything else from the 2026-07-18
  session (insurance KPI-mislabel fix, feedback agent live, VoiceOrb rebuild, infra review, pricing
  lock `ADR-057`, docs→brain restructure) shipped — see `progress.md` "Closed recently" and
  `changelog/2026-07.md`.

## Language support: closed, scoped correctly (ADR-060, 2026-07-19)

**B2 — multilingual understanding, not mid-call switching.** The Hindi/Hinglish STT/TTS foundation is
solid and live-verified (2026-07-16, `../voice-quality/hindi-hinglish-voice-support.md`), and Indic
calls now smart-default to Sarvam automatically (ADR-060, `../voice-quality/language-support.md`).
Mid-call *spoken-language switching* is REJECTED — not an open gap — because flipping the TTS voice
mid-call breaks voice identity, adds latency, and destabilizes the call (one fixed spoken language per
call; STT code-switching understanding is separate and stays). The differentiator is native Hinglish
+ multilingual understanding, not a switching gimmick. Only open B2 item: B2.5 (localized system
messages), minor polish. See `WEEBER-PLAN.md` Phase B and ADR-060.

## Next candidate items (not started, pick by sequencing not scope — ADR-037)

**Road ahead is now tiered in `WEEBER-PLAN.md` → "Road ahead — prioritized (2026-07-19)". Short version:**

- **Tier 1 (highest leverage):** **C4b — ingest-triggered call activation.** Wire the
  accepted-but-not-wired `triggerWorkflow` on `/api/leads/ingest` → agent router → outbound call,
  routed through the existing DNC/TCPA/quiet-hours dial-gates (reuse `scheduler.ts` /
  `place-outbound-call.ts`). This is the "lead lands → agent picks → call fires" loop; the leads
  layer (C4) is shipped up to the point where the call would fire.
- **Tier 2 (multi-channel reach):** C5 — WhatsApp node/tool/action mirroring the SMS 3-surface
  pattern; expose the transactional email path (`app/email.ts`) as a flow node; cross-channel
  fallback chains (Wait + delivery/read-status branch).
- **Tier 3 (integrations/templates):** C6 — Pipedrive native inbound adapter + Pipedream
  connector layer; activate per-org `wlk_` keys for a first external source; vertical flow
  templates (clinic/hotel/restaurant) once those verticals are built.
- **Tier 4 (carried forward):** Supabase Realtime dashboard (`ADR-058`, decided not built);
  `SENTRY_DSN` on Railway; A1b VAD/endpointing audit; B2.5 localized system messages.
- Opportunistic + cheap: D1 (Kokoro TTS pilot), D4 (join NVIDIA Inception).

## Open decisions waiting on the user (STOP-AND-ASK)

- Supabase Realtime on the dashboard: decided (`ADR-058`), just needs someone to actually build it.
- Set `SENTRY_DSN` on Railway (Sentry itself is wired, just needs the free Sentry.io project + env var).
- **C4b entry-condition branching** — config-driven vs. visual-canvas-from-day-one for the
  ingest→call activation router is still the open product decision (CLAUDE.md gate #4). Ask before
  building the routing UI.

_Last updated by: Workflows Standard View affordance/legibility fixes (editable-node cue + orientation strip + Save declutter + empty-state CTA), 2026-07-30._
