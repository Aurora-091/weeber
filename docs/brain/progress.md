---
doc: progress
status: LIVE — keep current
updated: 2026-08-09
---

# Progress — done / in-progress / next / known issues

> A glance-level status board. The authoritative roadmap is `WEEBER-PLAN.md`; the authoritative "what
> shipped when" is `../changelog/`; the authoritative "why" is `../decisions/`. This file is the fast
> summary that saves an agent from reading all three.

## Done (works end-to-end, real-verified)

- **G1 pilot-gate hardening — the agent layer no longer trusts the model with things it shouldn't
  (2026-08-01)** (`f8c2ba1`, `9990a54`; ADR-064/065/066; `../changelog/2026-08.md`). Four structural
  authority fixes plus three silent producer defects, all found by static audit before any merchant call:
  - `offerCartRecoveryDiscount` and `confirmCodOrder` are now **server-bound factories**. The model no
    longer chooses a discount percentage (it was defaulting to 10% nobody configured) nor the `orderId` of
    an order it cancels irreversibly. Non-registration is the enforcement: no bound context → the tool is
    not in that call's tool set at all.
  - Seeded personas were `{{merge_tag}}` templates that **nothing rendered**. Personas 01–03 rewritten
    tag-free; values arrive via fact blocks that emit only known facts; `voice/merge-tags.ts` scrubs
    survivors at the single `streamText({ system })` call site; `database/prompt-hygiene.test.ts` enforces
    it. Insurance 04–09 tracked in a shrink-only backlog.
  - `buildWorkflowFactsBlock` was written, unit-tested, and **never called from the live path** — workflow
    metadata sat in the session and never reached a prompt. Now wired through `runVoiceAgentTurn` and
    `runVoiceAgentGreeting`.
  - Prompt-injection detection extended past English-only `verb…object` regexes to Hinglish + Devanagari
    via order-independent co-occurrence (`voice/injection-detection.ts`). Still log-only.
  - **G1.4 (2026-08-01, ADR-069)** — the last ADR-066 violation, closed. `crmSync` took the contact's
    `phoneNumber` from the model and used it as the CRM **upsert key**
    (`integrations/gohighlevel.ts:23-32` matches on phone), so a hallucinated or mis-transcribed number
    wrote this call's notes onto a *different* person's contact. Now bound from the carrier's
    `humanNumber` at `"start"` (`voice/stream.ts:1580`); model input is `{ callerName?, notes }`;
    `phoneNumber` is out of the JSON Schema entirely; non-registration is the gate. Side effect kept on
    purpose: text test-chat, the synthetic harness and the preview drawer no longer get the tool, so a
    test can no longer write into a merchant's production CRM. Five seeded insurance personas' tool
    tables corrected to the new signature.
  - Verified: api tsc ✓ · web tsc ✓ · oxlint 0/0 (414 files) · 852 api + 74 web tests, `--isolate`.
    **Not verified by a live call** — see known issues. Open on ADR-069 specifically: whether
    `humanNumber` is populated at `"start"` on Exotel's WS-only path (fails *closed* — a missing write,
    not a wrong one).

- **Five Bets build plan — all five phases shipped + pushed (2026-07-31)**
  (`../product-strategy/five-bets-build-plan-2026-07-31.md`; each phase = green tsc/oxlint/web-build +
  isolated unit tests):
  - **P1 — Guardrail events:** `guardrail_events` audit table + writer, migration `0045` (applied).
  - **P2 — Call-health classifier:** `classifyCallHealth` + call-health columns, migration `0046`
    (applied). This is the signal that gates the P5 model decision.
  - **P3 — Synthetic scenarios:** offline agent-behavior harness expanded 3→8 + catalog-integrity tests.
  - **P4 — Backchannels:** cached-only mid-utterance acks (never live-synth on the hot path).
  - **P5 — Semantic turn-detection SEAM:** pluggable EOT interface + heuristic adapter + latency-budget
    guard + composite + flag (`voice/turn-detection/`). Heuristic default, flag OFF, behavior-identical,
    **no migration**. The EOT *model* is deferred behind a gate (ADR-063) — see known issues.
    Verified 24/0 unit. Note: none of the five is LIVE-call verified; unit/typecheck/build only, per the
    plan's "test later" scope.
- User App UI/UX Restructuring (2026-07-20): Elevated Sonner Toaster z-index (`99999`) across modals/drawers, refactored Integrations page (removed double-background overrides and full-screen blur overlays), and upgraded route fallback to animated page skeletons.

- Core voice pipeline: real inbound + outbound calls, barge-in, streamed tool-calling.
- Multi-provider STT/TTS/LLM with cross-provider failover; per-agent/per-call override.
- Multi-tenant telephony: Twilio (platform + BYO sub-accounts) + Plivo/Exotel (BYO).
- Shopify vertical: cart recovery, COD confirmation, feedback agents; revenue attribution.
- Per-org retry cadence via `scheduledCalls` + the in-process sweep; webhook outbox with backoff.
- Workflow Canvas (React Flow automation builder) — admin template editor, plus (2026-07-18)
  merchant-facing custom graph editing: locked compliance scaffold (`customGraph`,
  `dncCheck`/`callingWindowCheck` nodes), AI-assisted drafting, full merchant canvas editor. Flow
  preview via web call (v4 Phase 3) SHIPPED 2026-07-19 (`voice/workflows/preview-walker.ts`,
  `components/workflow-preview/FlowPreviewPanel.tsx`) — the whole v4 plan (Phases 1/2/3) is done.
- Compliance scaffolding: DNC (no bypass), TCPA/TRAI calling-window, HIPAA guardrail, GDPR
  retention/erasure, audit-trail export (`packages/weeber-compliance`).
- Auth: Supabase (JWKS), email OTP sign-in, waitlist + referral system.
- Config storage: DB-backed `org_agent_configs`/`org_workflow_configs` (not env).
- All 5 Shopify agent personas + 10 insurance agent prompts written (not placeholders); insurance
  agents 04–08 have config-driven en/hi/hinglish language variants; persona 09 = Final Expense
  Qualifier + Warm-Transfer (US/English-only) (2026-07-19).
- Native leads/records layer (Phases 1–3, 2026-07-19): owned `leads` table (deduped `(orgId, phone)`),
  captured-field promotion at `finalizeCall`, insurance Leads page (list/detail/status/assign/
  call-now/Excel export/manual CRUD), `POST /api/leads/ingest` (per-org `wlk_` keys, schema-validated,
  regulated-key rejection, idempotent), intake-schema editor, public hosted form `/f/:orgId`
  (orgId = write-only form token), on-demand "Sync to CRM" mirror (HubSpot/Salesforce/GHL). 621
  tests pass. ADR-061.
- Agent editor Phase III / Visibility (2026-08-01, ADR-067): one system-prompt composition path
  (`composeSystemPrompt`, join-invariant unit-tested), a compiled-prompt tab in the Preview drawer that
  shows the five layers a merchant actually ships and diffs what each edit changed, tool chips grouped by
  consequence with human labels + descriptions, and guardrail dials that render the exact sentence they
  inject. Browser-verified the same day via a DEV-only `phase3` harness page (web-only Vite server, no
  API, no telephony) — which immediately surfaced two defects, both since fixed: the call-control block
  had been shipping ragged indentation into every live call (`dedent` computes its minimum indent after
  interpolation; the multi-line constants it interpolates are flush-left, so nothing was ever stripped),
  and the "no caller ID" banner used dark-mode-only `amber-*` and was unreadable in light mode.
- Container-query product layout (2026-08-01, ADR-068): `@container` on both `AppShell` `<main>`s and 26
  in-flow grids across 8 files moved from viewport breakpoints (`sm:`) to container variants (`@xl:` etc).
  The sidebar is `hidden md:flex w-56`, so it appears at 768px and takes 224px of a column the grids were
  still sizing against the full viewport — at 768px `sm:grid-cols-3` produced 149px cards with letter-per-line
  text, while document `scrollWidth` stayed correct so no scrollbar ever revealed it. Overflow sweep
  (8 pages × 10 widths) went 3/40 flagged → 0/80; sidebar collapse now reflows the agents grid 2→3 columns.
  Guarded by `pages/app/responsive-grid.test.ts` (24 tests), which bans bare `sm:grid-cols-*` in `pages/app/`
  and `components/shell/` — the two portalled Dialog/Sheet surfaces keep viewport breakpoints on purpose.
  `/app/home`'s metric strips are the one unverified surface (empty without a backend).
- Agents overview grid (2026-08-01, `changelog/2026-08.md`): `/app/agents` renders a card per agent with
  a readiness pill, the specific blocker, and a live/paused/needs-a-number counts strip. It was previously
  a pure redirect to whichever agent came back first, so the nine seeded agents were reachable only via a
  `<Select>` and the detail page's "Agents" breadcrumb linked back to itself. Readiness now lives in one
  shared `classifyReadiness`/`agentReadiness` pair the detail-page banner also calls, so the two cannot
  drift; 8 unit tests, including a guard against raw Tailwind colours in place of `.theme-weeber` tokens.
  Browser-verified via `AgentsGridProbe` in `__preview.tsx` (four synthetic states, light + dark, zero
  console errors). Create-agent deliberately not built — see the changelog for why.
- Infra: Railway Pro + Supabase Small + Vercel Pro, all confirmed live (Audit #7, 2026-07-17).
- Hindi/Hinglish STT/TTS foundation, live-verified (2026-07-16).
- Sentry error monitoring wired (2026-07-18) — no-op until `SENTRY_DSN` is set on Railway (still
  outstanding: creating the free Sentry.io project + setting the env var, not a code task).
- Dead deps/config removed (2026-07-18): `@aws-sdk/client-s3`, `cloudflare` (root `package.json`),
  and the dead S3/`SUPABASE_KB_BUCKET` env vars from `.env.example`.

## In progress

- **First outbound pilot (insurance / final-expense qualifier).** Code side is shipped and green
  (ADR-081…089). What is left is not code: no real prospect CSV export header row, so `HEADER_ALIASES`
  in `voice/leads/csv-import.ts` is an educated guess; no prospect org in the deployed DB, so the
  bespoke template is still seeded **public** to every insurance org until one
  `POST /admin/orgs/:orgId/agents/grant` with `makePrivate: true` runs; and **no live outbound call has
  been placed since the silence-timer fix**, which leaves ADR-082…085 unit-verified only. Running list
  in `task.md`.
- **Structural hardening after ADR-090.** The ratchet (`bun run knip:gate`) is in CI. Next in that
  thread: three *integration* tests with a real DB and no `mock.module`, one per ingest path — the
  suite is 57-of-123 files mocking modules and exactly 1 touching `db.insert(`, which is why eight
  wiring defects got through it.

## Next (tiered — see `WEEBER-PLAN.md` "Road ahead — prioritized (2026-07-19)")

- **Tier 1 — C4b: ingest-triggered call activation (highest leverage).** Wire `triggerWorkflow`
  (accepted-but-not-dialing in `voice/leads/ingest.ts`) → agent router → outbound call through the
  existing DNC/TCPA/quiet-hours dial-gates (reuse `scheduler.ts` + `place-outbound-call.ts`). Turns
  the shipped leads layer into an end-to-end autonomous outbound loop. *Gated: routing config-vs-canvas
  is an open product decision (gate #4) — ask before building the router UI.*
- **Tier 2 — C5: multi-channel reach.** WhatsApp node/tool/action mirroring the SMS 3-surface pattern
  (subsumes C3e); expose transactional email (`app/email.ts`) as a flow node; cross-channel fallback
  chains (Wait + delivery/read-status branch).
- **Tier 3 — C6: integrations & templates.** Pipedrive native inbound adapter + Pipedream connector
  layer (interim path = Pipedream → `/api/leads/ingest`); activate per-org `wlk_` keys into a first
  real external source when a pilot needs it; vertical flow templates (clinic/hotel/restaurant) once
  built. See `product-strategy/integrations-strategy-and-roadmap-2026-07-19.md`, ADR-061.
- **Tier 4 — carried forward:** Supabase Realtime dashboard (`ADR-058`, decided not built); set
  `SENTRY_DSN` on Railway; **A1b** VAD/endpointing audit; **B2.5** localize system messages (mid-call
  spoken-language switching REJECTED per ADR-060, Indic calls smart-default to Sarvam).
- **Also queued (Phase-1 workstreams / platform breadth):** per-org DNC lists, full RBAC/multi-seat,
  per-org billing entity (`WEEBER-PLAN.md` P/Q/R/S); more ecommerce platforms after Shopify —
  WooCommerce, BigCommerce, Dukaan (build platform-agnostic).

## Recommended, not yet decided (from 2026-07-18 infra review)

- Adopt **Supabase Realtime** for the dashboard (replace 4–5s polling; already paid for) — decision
  made (`ADR-058`), implementation not started.
- Actually set `SENTRY_DSN` on Railway (Sentry itself is wired, just needs the project + env var).

## Known issues / debt (open)

- **61 known dead-code findings are baselined, not fixed** (`tools/dead-code/knip-baseline.json`,
  ADR-090): 4 unused files, 40 unused exports, 15 unused exported types, 2 duplicate exports. The
  ratchet stops the number growing; it does not clean up. Notable entries worth a decision rather than
  a shrug — all of `voice/workflows/index.ts` and `voice/turn-detection/index.ts` export unused,
  `bookAppointment`, `readCredentials`/`deleteOrgCredentials`, six error classes in `utils/errors.ts`.
  Each is either about to be wired or should be deleted; "baselined" is not an answer.
- **The test suite is blind at the seams.** 57 of 123 API test files use `mock.module`; exactly 1
  touches `db.insert(`. Unit density is high, integration coverage is near zero, and all eight
  wiring defects behind ADRs 073–088 lived in that gap. Adding unit tests does not close it.
- **Two capture policies will drift.** `PROHIBITED_CAPTURE_KEYS` (`voice/prohibited-capture.ts`,
  ADR-088) and `REGULATED_FIELD_MARKERS` (`voice/leads/intake-schema.ts`) encode overlapping rules in
  separate lists with no test tying them together. Unioning them is *wrong* — the markers
  `health`/`income`/`bank` would block `health_flag`/`income_type`/`banking_ready`, three of the nine
  permitted pre-qual fields — so the fix is a consistency assertion where they overlap, not a merge.
- **Tenancy is convention-only.** Org scoping is a `.where()` clause a developer has to remember. No
  test enumerates the tenant-scoped tables, so a missed clause is a cross-tenant read that ships green.
- **Production is unreadable.** `RAILWAY_TOKEN` fails in all four auth modes, so prod env vars cannot
  be inspected and logs arrive by copy-paste. `DATABASE_URL` does work, so DB verification is possible.
- **`bookAppointment`'s `dateTimeIso` is unbounded.** The ADR-066 tool audit cleared the tool otherwise
  (it *creates* an event, never mutates a model-named entity, and `orgId` + calendar creds are bound
  server-side), but nothing stops the model booking a slot in the past or years out. Low severity,
  unfixed, and a product call rather than a security one — what *is* the valid window?
- **`lookupInfo` reaches new orgs only, and that is now the accepted state.** It was added to the three
  Shopify templates' `defaultTools` in `database/seed.ts`, consulted at seed time only; orgs with existing
  `agent_configs` rows keep their stored `enabledTools`. **Backfill declined 2026-08-01** — every existing
  org is the founder's own or a test org, so the migration would change live rows to no benefit. Revisit
  if a real org ever predates the seed change.
- `injectionSensitivity` (agent guardrails) changes **prompt wording only** — the runtime injection
  detector (`voice/injection-detection.ts`) is not wired to the dial and behaves identically at all three
  levels. The editor now says so out loud (ADR-067) rather than implying a safety guarantee; making the
  dial real is an open decision, not a bug fix.
- The Phase III editor changes have now been rendered in a browser (2026-08-01, DEV `phase3` harness
  page), but the merchant `ToolsGuardrailsTab` still has **no automated render test** — the harness is a
  DEV page, not an assertion, so nothing fails the build if that tab regresses. Related: `dedent` remains
  in use at `voice/agent.ts:41`, `:909`, `:943`, `:964`, where it works only because those templates
  interpolate single-line values. Interpolating a multi-line constant into any of them will silently
  reintroduce the indentation defect; the `/^ {3,}/` regression test covers the call-control segment only.

- **"Staging" is not an environment — it is a second front door to production.** Settled 2026-08-01 by
  diffing the Railway variable dumps for both environments (`.railway/vars-staging.json` vs
  `vars-production.json`, pulled 2026-07-30). 33 of 40 variables are byte-identical, including
  `DATABASE_URL` (same Supabase project `wtqohdcghmxuujqyhlkz`, same pooler host, same db, same role),
  `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`, `SUPABASE_SERVICE_ROLE_KEY`,
  `ADMIN_API_KEY`, `WEEBER_INTERNAL_SECRET`, `WEEBER_CALLBACK_SECRET`, and every `PUBLIC_*_URL`. The only
  meaningful difference is `LLM_PROVIDER` (staging `groq`, prod `gateway`, and only prod sets
  `AI_GATEWAY_FALLBACK_MODELS`); the rest is Railway's own hostname/ID injection. Consequences worth
  saying out loud: a call placed "on staging" dials from the production Twilio number, bills the
  production Twilio account, and writes its `calls`/`guardrail_events`/DNC rows into the production
  database; a credential leak on staging is a prod leak; and because staging runs a *different* LLM
  provider than prod, it does not validate the model path either. So staging currently verifies little
  beyond "the process boots." This must be fixed before a pilot merchant's data is in that database.
  (Also noise: `SUPABASE_KB_BUCKET` is set on staging only and is referenced nowhere in `packages/` —
  dead variable, safe to delete.)
- **Five Bets P5 EOT model deferred (by design, ADR-063):** the turn-detection seam is shipped but the
  refiner stays `null` — no Smart Turn / OpenAI Realtime / LiveKit vendor is wired until (a) P2
  call-health data shows real cut-offs and (b) staging is isolated from prod. Not debt to "fix"; a
  documented gate to clear before wiring. Gate (b) is now **confirmed unmet**, not merely unverified —
  see the staging entry above.
- **No real end-to-end PSTN call has ever been placed (G0.4).** Every G1 claim above is static source
  reading plus isolated unit tests. Single largest unverified assumption in the codebase. The protocol to
  close it is now written — `../reference/live-call-test-protocol.md`, nine steps — but **Step 0 blocks
  it**: staging shares prod's Twilio account and Supabase database, so a test call bills prod and writes
  prod rows. G0.1 first, then G0.4.
- Branch protection on `main` not yet enabled in GitHub settings.
- Provider-side + Twilio concurrency limits unverified (not inferable from an API key).

## Closed recently (so this file doesn't look like it's ignoring them)

- Native leads/records layer shipped (Phases 1–3, minus the deferred Shopify Orders migration);
  integrations strategy set (Pipedream inbound, native outbound adapters); insurance en/hi/hinglish
  language variants + Final Expense Qualifier agent — 2026-07-19 (ADR-061; `changelog/2026-07.md`).
- Insurance dashboard `renewals_confirmed`/`leads_qualified` were mislabeled Shopify cart-recovery/
  COD-confirmation numbers (not "dead config" as previously logged here) — fixed with real
  `insuranceRenewal`/`insuranceLeadFollowup` KPI blocks, verified LIVE against a local DB + 2 real
  Supabase test users (not just typecheck) — 2026-07-18.
- Demo widget play button hit-target drift + feedback agent persona confirmed live — 2026-07-18.
- In-app `VoiceOrb` rebuilt (3-blob morph + glow) to match marketing `DemoOrb`; app/admin overlap
  scan came back clean (static-analysis-only, no live backend to confirm against) — 2026-07-18.
- Theme portal-scoping, agent full-window layout, 2 Dependabot vulns — fixed 2026-07-13.
- DB connection pool + Supabase compute tier — fixed/upgraded 2026-07-17.
- The "38 pre-existing test failures" baseline — was a false signal, not real bugs (ADR-056).
