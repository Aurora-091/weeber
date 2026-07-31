---
doc: active-context
status: LIVE — update every session you do meaningful work
updated: 2026-07-31
---

# Active context — what's happening right now

> **The most important file for an agent picking up cold.** It answers "what were we doing, where did
> we stop, what's next." Keep it short and *current* — a stale entry here is worse than none. When you
> finish meaningful work, update the three sections below and move anything shipped into `progress.md`.

## Current focus

- **Backchannels — Five Bets Phase IV (2026-07-31):** Fourth phase. Adds short low-latency acks
  ("Mm-hm."/"Right."/"Okay.") played sparingly while the caller is mid-utterance, covering the
  caller-is-talking silence window (pre-tool fillers only covered the agent-is-working window). Shipped:
  (1) pure `packages/api/src/voice/backchannel.ts` `shouldBackchannel(input)` → bool with all guardrails
  in one place (off unless org flag on; never while agent speaking; never on speech_final; only after
  `BACKCHANNEL_MIN_UTTERANCE_MS` 2500; rate-limited to one per `BACKCHANNEL_MIN_GAP_MS` 4000) + 10 tests;
  (2) `stream.ts` wiring — fires on Deepgram interim partials before the speech_final early-return;
  `maybePlayBackchannel` renders cached clips only (warm-cached on start via existing `warmFillerCache`);
  per-call state `callerUtteranceStartedAt` (reset on barge-in + consumed turn) + `lastBackchannelAt`;
  **NOT a turn** — never sets agentIsSpeaking / enters history / clears, so it can't corrupt
  turn-taking/barge-in/endsMidThought; (3) org flag `backchannels`, default OFF, **no DB column / no
  migration** (org-flag path like expressive-delivery). Verified: api+web tsc 3/3 · web build ✓ · oxlint
  0/0 · `bun test --isolate src/voice/backchannel.test.ts` 10/0 (41/0 across all four phase test files).
  **Synthetic-harness assert-unchanged check is N/A (text-only, no interim-STT path; backchannels never
  touch history). Real validation = controlled LIVE-AUDIO test, pending explicit go-ahead. NEXT: Phase V
  gate decision — build semantic turn-detection ONLY if Phase II call-health data shows a real
  turn-taking problem in production.**

- **Synthetic scenario expansion — Five Bets Phase III (2026-07-31):** Third phase. Extended the EXISTING
  AI-to-AI synthetic-test harness (`packages/api/src/voice/synthetic-scenarios.ts` + `synthetic-test.ts`)
  from 3 → 8 scenarios — NOT a rebuild. **Honest scope: text-only harness cannot test audio-timing
  failure modes (dead air/barge-in/mid-thought cut-off/silent STT-TTS); those stay gated on live
  telephony + Phase II health data.** Phase III locks the behavioral/prompt regressions instead. Added:
  `escalation-needed` (→`transferToHuman`), `abusive-caller-guardrail` (→`flagGuardrailEvent`, positive
  counterpart to `angry-customer`), `cod-confirmation` (→`confirmCodOrder`), `unknown-info`
  (→`lookupInfo`, hallucination guard), `multi-intent` (→`captureField`). All use existing assertion
  types (no schema change, no migration). New catalog-integrity tests in `synthetic-test.test.ts`: unique
  keys, ≥1 assertion + positive maxTurns each, and every tool assertion resolves to a real tool (closes
  the "assertion names a bogus tool → silently passes forever" trap). Verified: api+web tsc 3/3 · web
  build ✓ · oxlint 0/0 · `bun test --isolate src/voice/synthetic-test.test.ts` 10/0. **NEXT: Phase IV
  (backchannels), then Phase V gate decision from Phase II health data.**

- **Call health / silent-failure detection — Five Bets Phase II (2026-07-31):** Second phase of the
  approved Five Bets plan. `status` only says how a call ended for the carrier — it counts dead-air /
  STT-never-connected / greeting-only calls as `completed`. This derives a health verdict at call end.
  This is the phase that GENERATES the evidence Phase V (semantic turn-detection) is gated on. Shipped:
  (1) pure `packages/api/src/voice/call-health.ts` `classifyCallHealth(input)` → `{status, reasons}`,
  status `healthy|degraded|silent-failure`, judges only answered calls; named threshold constants
  (`DEAD_AIR_SILENT_MS` 8000, `DEAD_AIR_DEGRADED_MS` 3000, `LLM_TTFT_DEGRADED_MS` 2500,
  `STT_CONNECT_DEGRADED_MS` 2000) + 14 unit tests; (2) additive nullable `calls.healthStatus` (text) +
  `calls.healthReasons` (jsonb) + index `calls_health_status_idx` + **offline** migration
  `drizzle/0046_colorful_robbie_robertson.sql` — **NOT applied; user runs `db:migrate` (shared DB);
  Call Health view empty until then**; (3) `stream.ts` `finalizeCall` classifies from in-memory signals
  (added `transcriptCount` counter + local `sttReconnectCount` mirror) and folds the verdict into the
  SAME finalize `update` (atomic, no extra write); (4) admin `GET /api/voice/compliance/call-health`
  (`status`/`orgId` filters, only computed verdicts, `{calls, byStatus, byReason, total}`); (5) "Call
  Health" card in `compliance.tsx` (filter chips + per-call reason lists + CSV export). Verified: api+web
  tsc 3/3 · web build ✓ · root oxlint 0/0 · `bun test --isolate src/voice/call-health.test.ts` 14/0.
  **Migration 0046 pending user apply. NEXT: Phase III synthetic scenario expansion (await go-ahead).**

- **Guardrail event log — Five Bets Phase I (2026-07-31):** First phase of the approved Five Bets plan
  (`docs/product-strategy/five-bets-build-plan-2026-07-31.md`). Approved sequencing (inverted from
  research): **I** guardrail-events table (this) → **II** silent-failure/call-health detection → **III**
  synthetic scenario expansion → **IV** backchannels → **V** semantic turn-detection (last, gated on
  Phase II data showing a real turn-taking problem). Shipped: (1) `guardrail_events` table in `schema.ts`
  + **offline** migration `drizzle/0045_sour_matthew_murdock.sql` — **NOT applied; user runs `db:migrate`
  (shared DB); panel empty until then**; (2) pure `packages/api/src/voice/guardrail-events.ts`
  `deriveGuardrailEventFields(name, input)` → `{category,source,detail}` | null (category enum
  topic-boundary/unauthorized-promise/prompt-injection/abuse/unknown; source agent-self-report |
  heuristic-detector) + 7 unit tests; (3) `stream.ts` `logToolCall` fire-and-forget insert after the
  `toolCalls` insert (both guardrail signals already funnel through this one choke point; best-effort,
  swallows DB errors, never blocks call — ADR-062); (4) admin `GET /api/voice/compliance/guardrail-events`
  (`orgId` filter, `{events, byOrgCategory, bySource, total}`); (5) "Guardrail Event Log" card in
  `compliance.tsx` (per-event list + `bySource` chips + CSV export). Existing `/compliance/overview`
  tool_calls-scan counts left untouched (cover pre-migration calls). Verified: api+web tsc 3/3 · web
  build ✓ · root oxlint 0/0 · `bun test --isolate src/voice/guardrail-events.test.ts` 7/0.
  **Migration 0045 pending user apply. NEXT: Phase II call-health detection (await go-ahead).**

- **Canvas product telemetry — first-party event pipe (2026-07-31):** Closed the highest-value gap
  flagged below — the canvas/Customize flow was unmeasured. Built a **first-party** product-usage event
  pipe (deliberately NOT PostHog/Amplitude: zero vendor cost, data stays in our Postgres, no PII to a
  processor, pre-pilot volume is tiny). Three pieces: (1) `product_events` table in `schema.ts` +
  **offline** migration `drizzle/0044_nostalgic_lilith.sql` — **NOT applied; user runs `db:migrate`
  (shared DB)**; (2) `packages/api/src/app/events-ingest.ts` (pure `parseEventBatch` — name regex,
  4KB props cap, batch cap 50, epoch sanity; best-effort `recordEvents` that swallows DB errors) +
  `POST /api/app/events` after `requireUserOrg` (orgId/userId from session, always 2xx, 429 on flood,
  limiter `APP_EVENTS_RATE_LIMIT` 120/60s); (3) `packages/web/src/web/lib/analytics.ts` — typed
  `track()` that **never throws/blocks**, canonical `AppEventName` union (14 names; server validates
  shape only so new events are client-only), sessionId + batched flush + keepalive on hide. Deleted the
  dead `window.stonks` shim (`types/analytics.d.ts`). Wired `workflows.tsx` end-to-end: activation funnel
  (`workflow_list_viewed` → `workflow_customize_started {source: template|blank|ai_draft|reopen}` →
  save `attempted`/`blocked`/`succeeded` with `activated:true` + `msSinceStart` → list-toggle
  `activated`/`paused`) + canvas-usage (`node_added {via}`, `node_deleted`, `edge_connected`,
  `node_config_opened`) + AI-draft (`requested`/`succeeded`/`failed`). Activation not double-counted
  (save carries `activated:true`; toggle events reserved for list). Verified: api+web tsc 0 · web build
  ✓ · root oxlint 0/0 · `events-ingest.test.ts` 9/0 · `bun test --isolate src/app/` 45/0.
  **No funnel UI yet** (the first-party trade-off) — query `product_events` via SQL / small admin view
  later. Admin `workflow-editor.tsx` intentionally not instrumented (merchant flow only).
  **Migration 0044 pending user apply.** Pre-existing `src/app` test-isolation issue (below) still open.

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
