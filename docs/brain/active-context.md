---
doc: active-context
status: LIVE — update every session you do meaningful work
updated: 2026-08-11
---

# Active context — what's happening right now

> **The most important file for an agent picking up cold.** It answers "what were we doing, where did
> we stop, what's next." Keep it short and *current* — a stale entry here is worse than none. When you
> finish meaningful work, update the three sections below and move anything shipped into `progress.md`.

## Current focus

- **CI on `main` is green again; the cause was an unversioned third-party input (2026-08-11, ADR-099).**
  `main` had been red for four commits — `visual`, `fonts`, `CI success` — while the whole range
  changed exactly one file under `packages/web` (two lines in a test that renders nothing). Cause:
  `styles.css:1` `@import`ed the Google Fonts CSS2 endpoint, so all 78 pixel baselines were a
  photograph of whatever binary the CDN served that minute, and upstream Fraunces moved. The four
  brand families are now `@fontsource-variable` packages pinned in `bun.lock` and bundled same-origin,
  and `ALLOWED_OFF_ORIGIN` in the screenshot guard is empty — a screenshot run reaches nothing but
  `localhost`. **Zero baseline bytes changed**, which is the proof: pinning restored the prior
  rendering rather than laundering the drift into the baselines. No ratchet was widened.
  **Take from this:** when a pixel gate goes red with no source change, work the four pins in
  `playwright.visual.config.ts`'s header before touching a baseline or an `ALLOWED` list. One of them
  had been aspirational rather than true.
  Also fixed in the same pass: `2a29a18` left an unused `dirname` import in
  `tools/dead-code/knip-gate.ts`, which is all the `lint` failure was.

- **Two facts that were stale everywhere (2026-08-11).**
  1. The GitHub repo is **`Aurora-091/weeber`**, not `openvent`. ADR-078 item G had left the rename
     "to be decided separately". The old slug `301`s, so git remotes are fine, but API calls that do
     not follow redirects break; the numeric id `1295249026` is stable. Historical ADRs/audits still
     say `openvent` and are deliberately left alone.
  2. The **Railway staging deploy of `2a29a18` is `SUCCESS`** on `api-staging-b11d.up.railway.app`,
     no longer `NEEDS_APPROVAL`, and staging's builder is now `NIXPACKS` matching production. Still
     true and still the real risk: staging shares ~33 of 40 env vars with production including
     `DATABASE_URL` and the Twilio account, so "staging" dials and writes production.

- **First outbound pilot prep, and the structural finding underneath it (2026-08-09, ADR-081…090).**
  Ten ADRs landed in one day and they are not ten topics. The scope decision is ADR-081: the agent
  **qualifies and warm-transfers**, it does not perform the licensed act — no claiming licensure, no
  carrier recommendation, no premium quote, no itemized health conditions, no SSN/DOB/routing/account
  capture, no effective date or beneficiary, no voice-signature ACH authorization. Treat that as a
  standing constraint on anything in the insurance vertical, not a pilot detail.
  Shipped with it: transfer outranks hang-up (082), lazy TTS connect so an unspoken socket stops
  tripping failover (083), call health counts `callerTranscriptCount` (084), outbound opener resolves
  lead greeting context in the pickup `Promise.all` (085) and the `interest_area`/`state` fields it
  needs now exist in the intake schema (087), per-account template `visibility`/`ownerOrgId` + an admin
  grant route (086), the prohibited-capture guard actually enforced at the write path (088), and
  preview-first CSV lead import (089).
  **The finding that matters more than any of them: eight of ADRs 073–088 are the same defect** —
  code written, documented, unit-tested, never connected to a caller. 073 and 088 are the identical
  bug found three days apart, both by a human running `rg`. Nothing measured reachability, and unit
  tests structurally hide it (the test imports the symbol, so the export looks used). ADR-090 adds
  `knip` as a CI **ratchet** — `bun run knip:gate`, baseline 61 findings in
  `tools/dead-code/knip-baseline.json`, fails only on new ones. **Before wiring anything new, run the
  gate; before trusting a "shipped" item below, check it has a caller.**
  Gates: typecheck clean · lint 0/0 (479 files) · test **1242 pass / 0 fail** · `knip:gate` green.
  **Not live-verified:** no outbound call has been placed since the silence-timer fix. 082–085 are
  unit-verified only. See `task.md` for the pilot blocker list (no real prospect CSV header row, no
  prospect org in the deployed DB so the bespoke template is still seeded public, uncalibrated 55 ms/char
  playback constant, unsolved US-vs-India TTS routing).

### Earlier context (kept for continuity — verify against `progress.md` before relying on it)

- **The caller identity a tool writes to comes from the carrier, not the model (2026-08-01, ADR-069).**
  Closes the one ADR-066 violation the tool audit found. `crmSync` took `phoneNumber: z.string()` as a
  required *model-authored* input and used it as the **upsert key** — `syncToGoHighLevel` POSTs it as
  `phone` to `/contacts/upsert` (`integrations/gohighlevel.ts:23-32`), which matches on phone, so a wrong
  number does not error: it writes this call's notes onto **someone else's contact** in the merchant's live
  CRM. Three routes there (LLM invents digits it was never given; STT digit errors on Indian accents; the
  caller just says a number that isn't theirs). Meanwhile the real number was already resolved server-side
  at `voice/stream.ts:1561` and already trusted for DNC (`:515`) and caller memory (`:611`).
  Fix is the ADR-064/066 pattern: `CrmSyncContext = { orgId, phoneNumber }`, `resolveCrmSyncContext()`,
  `createCrmSyncTool(ctx)`, resolved once in the `"start"` handler (`stream.ts:1580`) and fixed for the
  call's life; model input narrows to `{ callerName?, notes }` with `phoneNumber` **removed from the JSON
  Schema** (optional-with-a-default was rejected — a field in the schema is a field the model fills).
  **Non-registration is the gate:** `crmSync` is out of the static `voiceTools` map, `buildVoiceTools` took
  a 6th `crmSync?: CrmSyncContext`, and the tool only exists on calls where the context resolved.
  Intended side effect, kept deliberately: **test-chat, the synthetic harness and the preview drawer now
  get no `crmSync`** — a text test could previously write a live contact into a production CRM.
  Also fixed: five seeded insurance personas still documented `crmSync({ phoneNumber, notes })` in their
  tool tables, and those markdown files *are* the shipped prompts.
  Gates: api tsc 0 · web tsc 0 · api 852 pass · web 74 pass · oxlint 0/0. 13 new tests.
  **Not live-verified.** Open question: is `humanNumber` populated at `"start"` on *every* provider —
  Exotel's WS-only path inserts the `calls` row later than Twilio/Plivo. Failure mode is a *missing* CRM
  write, not a wrong one. Step 7 of the call-test protocol covers it.

- **G0.4 protocol written; the call itself is blocked on G0.1 (2026-08-01).**
  `docs/reference/live-call-test-protocol.md` — nine steps: environment isolation as a blocking
  prerequisite, three test numbers incl. a DNC negative control, instrumentation captured before dialling,
  four scripted calls, post-run DB verification, a same-day write-up, and an explicit list of what four
  calls do **not** cover. Deliberately no call was placed: staging bills prod's Twilio and writes prod's
  database. **Step 0 is the G0.1 infra work** (separate Twilio subaccount + number, separate Supabase
  project, `LLM_PROVIDER` matched to prod) and it is not doable in this sandbox — no `railway` CLI, and it
  is the user's billing.

- **Product layout responds to the content column, not the viewport (2026-08-01, ADR-068).** Every grid
  in `pages/app/` used viewport breakpoints while `AppShell`'s sidebar is `hidden md:flex` at `w-56`
  (`components/shell/app-shell.tsx:307,315`) — so it *appears* at 768px and immediately takes 224px, and
  with `--shell-page-px: 2rem` (`styles.css:478`) the content column at that width is 480px. `sm:` fires
  at 640px viewport, so `sm:grid-cols-3` was laying out 149px cards. Document `scrollWidth` was correct at
  every width, which is why this never produced a page scrollbar and was never caught: **the overflow was
  inside the cards, not on the page.** Screenshot at 768px showed `/app/integrations` telephony cards
  rendering "Not connected" one letter per line, "Download as Excel" escaping its card, and `/app/agents`
  truncated to `"COD co…"`.
  Fix: `@container` on both `<main>`s (`app-shell.tsx:367`, `:370`) and **26 in-flow grids** converted to
  container variants across 8 files. Two deliberate exceptions keep viewport breakpoints because they
  render *outside* `<main>` and so have no query container — `pages/app/leads.tsx:725` (Dialog) and
  `components/app/setup-modal.tsx:257` (Sheet); container variants there would silently never match.
  Marketing pages have no sidebar and were untouched. Agent card titles went `truncate` →
  `line-clamp-2 break-words`.
  Verified: overflow sweep over 8 product pages × 10 widths `[390…1440]` went **3 of 40 flagged → 0 of 80**;
  sidebar collapse at viewport 1180 reflows the agents grid **2 → 3 columns** (224px → 52px), which is the
  whole point and is something viewport breakpoints structurally cannot do. New
  `pages/app/responsive-grid.test.ts` (24 tests) fails the build on any bare `sm:grid-cols-*` in
  `pages/app/` or `components/shell/` and asserts `@container` on both `<main>`s; `leads.tsx` is the single
  allowlist entry. Gates: api tsc 0 · web tsc 0 · api 840 pass · web 74 pass · oxlint 0/0.
  **Caveat, stated rather than hidden:** `/app/home`'s three metric strips are data-driven and render empty
  in the backend-free preview harness, so their `sm:grid-cols-4` → `@md:grid-cols-2 @4xl:grid-cols-4` change
  passed the sweep with no tiles present. It is reasoned-correct, not eyes-on-verified.

- **G1 pilot gate — build round (2026-08-01).** Working the pilot-blocking list in
  `audit/pilot-readiness-checklist-2026-08-01.md` so Shopify merchant conversations can start. Four items
  shipped across two commits, all pre-pilot so no merchant was ever affected:
  - **G1.1/G1.2** (`f8c2ba1`, ADR-064) — the LLM chose `percentOff` on `offerCartRecoveryDiscount` and
    silently issued 10% by schema default while the merchant's configured discount was ignored. Now a
    server-bound factory; model input is `{ reason }`; **non-registration is the enforcement** (no discount
    configured → the tool is absent from that call's tool set).
  - **G1.3/G1.4** (`9990a54`, ADR-065 + ADR-066) — every seeded persona was a `{{merge_tag}}` template and
    **nothing rendered it**; `renderTemplate` only ever touched `literalGreetingTemplate`. Rendering was
    rejected (two drifted tag vocabularies; `cart_items_summary`/`product_name`/`delivery_days_estimate`
    have no producer anywhere). Personas 01–03 rewritten tag-free as *instructions*; values now arrive via
    fact blocks that emit a line only when the fact is known; `voice/merge-tags.ts` scrubs any surviving
    tag at the single `streamText({ system })` call site; `database/prompt-hygiene.test.ts` enforces it
    with a shrink-only insurance backlog. Same commit: `confirmCodOrder` was letting the model name the
    `orderId` of an order it **cancels irreversibly**, while (per a separate defect) never having been told
    the order reference — now server-bound, model input `{ confirmed, notes }` (ADR-066).
  - **G1.5** (this round) — `looksLikePromptInjection` was nine English `verb…object` regexes; Hindi and
    Hinglish are verb-final so none could ever fire. Extracted to `voice/injection-detection.ts` with
    order-independent verb/noun co-occurrence, Devanagari stem matching and nukta normalization. Still
    log-only.
  - Three silent producer defects fixed in passing: COD context never wrote `currency` (so the COD agent
    could not state the amount it exists to confirm); the facts block emitted no order reference at all
    (producers write `orderId`, the block read `order_id`); `03`'s seeded greeting carried
    `{{product_name}}`, which has no producer, so its fast canned-greeting path had **never once fired**
    and every feedback call paid full LLM time-to-first-token.

  **NEXT on G1:** insurance personas `04`–`09` are still templated (tracked in
  `MERGE_TAG_MIGRATION_BACKLOG`, which may only shrink). One open product decision, not a doc fix: whether
  the disposition enum should gain confirmed/cancelled and feedback-positive/negative values instead of
  overloading `booked`/`interested`.

  **ADR-066 audit of the two remaining tools — done (2026-08-01), one violation found.**
  - `bookAppointment` (`voice/tools/bookAppointment.ts`) is **compliant**. `orgId` is bound by the factory;
    `calendarId` and `accessToken` resolve from `orgIntegrations` (vault-first). The model supplies
    `callerName`/`dateTimeIso`/`notes`, which *create* a new event — it never names an existing entity, and
    cannot reach another org's calendar. Minor, non-blocking: `dateTimeIso` is unbounded, so a past or
    far-future slot is bookable.
  - `crmSync` (`voice/tools/crmSync.ts:15`) is a **violation of the same shape as `confirmCodOrder`**.
    `phoneNumber: z.string()` is model-supplied and required, and it is the **upsert key** —
    `syncToGoHighLevel` POSTs it as `phone` to `/contacts/upsert` (`integrations/gohighlevel.ts:23`). A
    hallucinated or caller-dictated number writes this call's notes onto a *different* contact in the
    merchant's CRM. The model has no legitimate reason to supply it: the caller's real number is already
    resolved server-side in the `"start"` handler as `humanNumber`
    (`voice/stream.ts:1561`, via `resolveHumanNumber`) and is already trusted for DNC opt-out (`:515`) and
    caller memory (`:611`). Fix is the established pattern — a `CrmSyncContext` carrying `humanNumber`,
    bound at `buildVoiceTools` (`voice/agent.ts:869`) alongside `cartRecovery`/`codOrder`, model input
    narrowed to `{ callerName?, notes }`. Lower blast radius than `confirmCodOrder` (a wrong write, not an
    irreversible cancellation), but the same class.
    **SHIPPED the same day as ADR-069** — see the top of this file. This audit note is kept for the
    reasoning trail.

- **Agent console UI (2026-08-01).** Overview grid shipped at `/app/agents` — the route was previously a
  pure redirect to the first agent, so nine agents were reachable only through a `<Select>` and the detail
  page's own "Agents" breadcrumb linked back to itself. Readiness logic deduped into
  `classifyReadiness`/`agentReadiness` so the grid and the detail page's caller-ID banner cannot drift.
  Browser-verified through an `AgentsGridProbe` in `__preview.tsx` (four synthetic states, no backend).
  A create-agent flow was considered and **rejected** — no POST route exists, the registry is curated, and
  the real complaint was seeing the agents that exist. Full reasoning in `changelog/2026-08.md`.
  Same round: `lookupInfo` added to the three Shopify templates' `defaultTools` (`database/seed.ts`) —
  **newly seeded orgs only**, existing `agent_configs` rows are untouched. **Backfill declined
  (2026-08-01):** every existing org is the founder's own or a test org, so a data migration would buy
  nothing and touch live rows for no reason. Revisit only if a real org predates the seed change.

  **Still unverified, and the honest gap in all of the above:** no real end-to-end PSTN call has been
  placed. Every claim here is from static source reading plus `--isolate` tests.

  **G0.1 closed (2026-08-01), badly.** The `progress.md`-vs-`adr-063` contradiction is settled: ADR-063
  was right, and understated it. Diffing the two Railway variable dumps, **33 of 40 variables are
  byte-identical** across staging and production — same `DATABASE_URL` (same Supabase project, pooler,
  db, role), same `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_PHONE_NUMBER`, same
  `SUPABASE_SERVICE_ROLE_KEY`, same `ADMIN_API_KEY` and internal secrets, same `PUBLIC_*_URL`s. The only
  real difference is `LLM_PROVIDER` (staging `groq`, prod `gateway`). So "staging" dials from the
  production phone number, bills the production Twilio account, writes into the production database, and
  runs a *different* LLM path than prod — it shares prod's blast radius while testing neither prod's data
  layer nor prod's model layer. **This is the top infra item to fix before a pilot merchant's data exists
  in that database**, and it converts Five Bets P5 gate (b) from unverified to confirmed unmet.

  Also corrected the same day: `architecture/voice-orchestration.md` claimed the PDF knowledge base
  "does not exist in the schema/backend yet." It has existed since 2026-07-14 (A3b) — tables, ingestion,
  retrieval, CRUD routes, merchant UI, and the `lookupInfo` binding are all real.

- **Phase III (Visibility) shipped — 2026-08-01, ADR-067.** The agent-editor case study's three
  visibility gaps, closed together. **D2:** new `composeSystemPrompt()` in `voice/agent.ts` is now the
  *single* system-prompt composition path (both `resolveAgentConfig`'s DB-row branch and
  `buildPreviewAgentConfig` call it) and returns the labelled layers alongside the final string; two new
  pure `compiled-prompt` endpoints serve them; a "Prompt" tab in the Preview drawer renders the layers,
  highlights the merchant's own text, and line-level diffs whatever the last edit changed. Invariant
  `segments.join("") === text` is unit-tested byte for byte, so the panel cannot drift from a live call.
  **D4:** tool chips carry a human label, a one-line description, and a consequence group
  (*Conversation control* / *Data capture* / *Acts outside the call*, the last one weighted) instead of a
  raw camelCase identifier. **D3:** each guardrail dial renders the exact sentence it injects, sourced
  from a dependency-free `voice/prompt-lines.ts` with a web parity test.

  Fixed in passing: `buildPreviewAgentConfig` never fetched `orgs.name`, so **every previewed prompt was
  missing the "You are calling on behalf of X" line a real call ships**. It now takes an optional `orgId`;
  all five call sites pass it.

  Stated in the UI rather than papered over: **`injectionSensitivity` changes prompt wording only** — the
  runtime injection detector is not wired to that dial and behaves identically at all three levels.
  Making it real is a separate, unstarted decision.

  **Browser-verified later the same day, and it found two defects.** A DEV-only `phase3` page in
  `pages/__preview.tsx` mounts `ToolsGuardrailsTab` (now exported for the harness) beside
  `CompiledPromptPanel` with local state — web-only Vite server, no API, no telephony. Groups, mono
  consequence lines, layer badges and diff-on-toggle all render as designed, light and dark, zero console
  errors. **(1)** Reading the call-control layer on screen exposed that `buildCallControlBlock` had been
  shipping **ragged indentation into every live call** — ``dedent`…` `` computes its minimum indent *after*
  interpolation and the multi-line constants it interpolates are flush-left, so nothing was ever stripped.
  Now a flush-left `string[]` + `join("\n")`; content unchanged, whitespace only; `/^ {3,}/` regression test
  added. **(2)** The "no caller ID" banner (`agents.tsx:712`) hardcoded dark-mode-only `amber-*` and was
  unreadable in light mode; now semantic `warning`/`foreground` tokens. Both were type-correct, lint-clean
  and covered by passing tests — *rendering for a human to read is a distinct verification class.*

  **NEXT on the editor:** the Tools & Guardrails tab still has no render test (the harness is a DEV page,
  not an assertion). `D1` (create-agent), `D5` (prompt versioning) and Phase IV (eval/judge) remain
  deliberately out of scope.

- **Semantic turn-detection SEAM — Five Bets Phase V (2026-07-31):** Fifth/final phase, and the Five
  Bets plan is now complete. Ships the pluggable end-of-turn (EOT) **seam + fallback discipline only —
  NOT a model vendor**, because the model is gated (zero Phase II production health data yet, pre-pilot;
  staging+prod still share `DATABASE_URL` so no isolation). New module `packages/api/src/voice/turn-detection/`:
  (1) `types.ts` `TurnEndDetector` interface `decide(input)→{done,by,reason?}`; (2) `heuristic.ts` —
  `endsMidThought`+pattern MOVED here unchanged from stream.ts, wrapped as `HeuristicTurnDetector` (default
  + always-available fallback, zero I/O); stream.ts re-exports `endsMidThought` for back-compat;
  (3) `budgeted.ts` `withLatencyBudget(primary,fallback,budgetMs)` — a slow/throwing model degrades to the
  heuristic, never adds unbounded latency to the hot path; (4) `composite.ts` — heuristic first, short-circuit
  (skip model) when it wants to hold, consult refiner ONLY when the turn looks complete; (5) `index.ts`
  `createTurnDetector(config)` + `SEMANTIC_TURN_DETECTION_FLAG` (`semantic-turn-detection`) +
  `DEFAULT_REFINER_BUDGET_MS` 300. Wiring: per-call `turnDetector` built in stream.ts start handler from the
  flag (refiner=null default → plain heuristic, byte-identical to old inline check); call site is now
  `const d = await turnDetector.decide({text}); if(!d.done){armSilenceTimer;return;}`. **Flag default OFF, no
  DB column / no migration** (org-flag path). Model wiring correctly deferred — dropping in Smart Turn/OpenAI
  Realtime/LiveKit later = pass a `refiner` + flip the flag. Verified: api+web tsc 3/3 · web build ✓ · oxlint
  0/0 · `bun test --isolate src/voice/turn-detection/turn-detection.test.ts src/voice/stream.test.ts` 24/0
  (StubModelTurnDetector mock, no live vendor, audio path untouched). **NEXT: nothing in Five Bets — model
  wiring waits on Phase II call-health data + staging isolation. No live-audio/live-server test without
  explicit go-ahead.**

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

_Last updated by: outbound pilot prep ADR-081…089 + the dead-code reachability ratchet ADR-090, and a doc-staleness sweep (ADR index had stopped at 080), 2026-08-09._
