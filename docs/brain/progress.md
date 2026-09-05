---
doc: progress
status: LIVE — keep current
updated: 2026-09-05
---

# Progress — done / in-progress / next / known issues

> A glance-level status board. The authoritative roadmap is `WEEBER-PLAN.md`; the authoritative "what
> shipped when" is `../changelog/`; the authoritative "why" is `../decisions/`. This file is the fast
> summary that saves an agent from reading all three.

## Done (works end-to-end, real-verified)

- **Competitor agent-prompting comparison + Weeber scorecard filed (2026-09-05).**
  Dated strategy notes, not ADRs. See `docs/product-strategy/competitor-agent-prompting-2026-09-05.md`
  and `competitor-agent-prompting-weeber-scorecard-2026-09-05.md`.

- **ADR-124 — empty hangUp is not a hearing problem (2026-09-05).** Post-sale welcome called
  hangUp with no closing line; skip `FALLBACK_REPLY` when hangUp/transfer already ran. Unit +
  wiring tests; needs a live post-sale re-test after deploy. Appointment-setter TTS dead air
  is a separate open issue.

- **ADR-123 — Twilio AMD must not steal a live conversation (2026-09-05).** After ADR-122 a live
  India test call conversed two turns, then Twilio AMD redirected to a default-voice "sorry we
  missed you" hangup. AMD now defaults on for NANP only; test-call-phone sets `amd: false`; a
  machine label is ignored once the caller has spoken.

- **ADR-122 — first-token timeout vs tools (2026-09-05).** The live "I didn't catch that" loop was the
  2.5s LLM first-token abort killing an in-flight `crmSync` on orgs with no CRM, not STT. Deferred
  abort when a tool started this turn; `resolveLiveCrmSyncContext` withholds the tool without
  credentials; insurance runtime personas are tag-free. See `docs/decisions/adr-122-*.md`.

- **Voice "start" handler: duplicate `orgs` query removed + every seeded greeting made resolvable
  (2026-08-20, `a6d2b87`/`a7b63b6`).** Two pieces. (1) `resolveAgentConfig` no longer fires its own
  `orgs.name` query when the outer `Promise.all` batch already has one in flight for the same org —
  `orgRowPromise` param, shares one query instead of two, falls back to independent queries the instant
  the org ids could differ so behavior is unchanged in every case. (2) All 6 insurance
  `literalGreetingTemplate`s and their 10 localized hi/hinglish variants no longer use lead-row-dependent
  tags (`{{interest_area}}`/`{{lead_name}}`/`{{policyholder_name}}`/`{{interaction_type}}`) that left the
  greeting unresolved on 11/11 production calls (no lead row at call time) — down to
  `{{agent_name}}`/`{{merchant_name}}` only, the two tags `stream.ts` always guarantees, with a
  regression-guard test against the `{{company_name}}` alias drifting back in. 7 + 2 new tests. Verified:
  typecheck clean, lint clean, 1413/1414 api tests (the 1 failure is the known issue below, unrelated).
  See `active-context.md` for full detail.

- **Supabase account migration + ADR-117 vault-function fix + login/signup relocated (2026-08-17 to
  2026-08-19).** New account, two fresh projects — production `qghtkadxbtptvbfbmsdz`, staging
  `zbcrwexrqfmjxhewirgp` — fully migrated (`drizzle/` `0000`–`0052` + `supabase/migrations/*.sql`); old
  project `wtqohdcghmxuujqyhlkz` abandoned; `.mcp.json` unscoped rather than repointed (`96c7208`). Same
  pass surfaced and fixed ADR-117: all four credential-vault functions were directly executable by
  `PUBLIC` on both live projects (a `REVOKE ... FROM anon, authenticated` never touches the implicit
  `PUBLIC` grant underneath), letting an anonymous caller pull any org's decrypted telephony credentials
  via PostgREST — not introduced by the migration, pre-existing on the old production project too, fixed
  same day on both projects. Login/signup moved from `app.weeber.ai` to the public surface
  (`weeber.ai/login`, `/signup`, `ac83ea9`) with a real cross-domain session handoff via URL-fragment
  tokens + `setSession()`. See `active-context.md` and ADR-117 for full detail. **Open thread:**
  `supabase/config.toml`'s widened redirect allowlist still needs a manual push to both live projects
  (no CLI/access-token in this sandbox), and whether staging's `DATABASE_URL` now points at the new
  staging project rather than sharing production's is unverified — see the staging finding below.

- **UI/UX Audit Phase 1 & 2 — Error Recovery, Mobile Polish, Navigation & Pricing Clarity (2026-08-16)**
  - Replaced dead-end error EmptyStates with `icon={AlertCircle}` and explicit retry controls (`configs.refetch()` / `workflows.refetch()`) across `pages/app/agents.tsx`, `pages/app/workflows.tsx`, and `pages/dashboard/agents.tsx`.
  - Fixed mobile email input truncation in `WaitlistForm.tsx` via `flex-col sm:flex-row gap-2` + `w-full sm:w-auto` CTA button; added `role="alert"` / `aria-live="polite"` to error messaging tags.
  - Refined `pages/app/home.tsx` zero-data state to conditionally omit `DateRangeSelector` until call data exists.
  - Added visible "Sign in" route to public desktop and mobile headers in `MarketingNav.tsx` alongside Help and Waitlist CTA; updated mobile hamburger button to descriptive `aria-label="Open/Close navigation menu"`.
  - Refined `PRICING_TIERS` in `marketing-config.ts` with indicative volume and feature bounds ("Up to 250 calls/mo", "Up to 1,500 calls/mo", "Dedicated numbers").
  - Verified: 101/101 web unit tests pass, typecheck clean, daily audit passing (zero token drift or contrast regressions), production Vite build passing.

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

- **Confirmation/OTP/reset mail still sends from Supabase's default mailer, not `hello@weeber.ai`
  (found + partially fixed 2026-08-20).** Diagnosed as two separate systems: Resend (waitlist mail) is
  fine — domain verified, key set, prior sends logged. Supabase Auth's own signup/OTP/magic-link/
  password-reset mail (ADR-041) was never on Resend at all, confirmed via `mail_from:
  noreply@mail.app.supabase.io` in Supabase auth logs. `supabase/templates/{confirmation,magic-link,
  recovery}.html` restyled this session to match the Resend waitlist template's warm-paper branding.
  **Still needs, both manual dashboard steps:** paste the three templates into Supabase Dashboard →
  Authentication → Emails (local CLI can't push — `supabase/.temp/project-ref` is the stale, abandoned
  `wtqohdcghmxuujqyhlkz`), and enable Custom SMTP there pointed at Resend so the sender actually becomes
  `hello@weeber.ai`. Also worth a look once SMTP is on: Supabase Auth's separate rate-limit dial
  (Authentication → Rate Limits) — it applies even with custom SMTP configured.

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

- **TTS dead air with spoken transcript (2026-09-05, appointment-setter).** Live log:
  `DEAD AIR on turn 5: the LLM produced 59 chars but TTS never emitted a single audio byte`.
  ADR-101 class. Not ADR-124. Reproduce on appointment-setter, not post-sale.

- **No `humanTransferNumber` on the demo org** (`org_a21984fe-…`). Every insurance test call
  logs `transferToHuman withheld`. Ops: set it on the agent or in Settings. Not a code bug.

- **`setDisposition` routinely exceeds the 400ms filler** on live insurance closes (A4
  scheduled_calls insert). Honest filler; still adds "one moment" at hangup.

- **The caller-silence race-condition test fails (2026-08-20, `stream-silence-timeout.test.ts`,
  found while landing `a6d2b87`, not fixed).** "does not hang up on a caller who answers while the
  goodbye line is being prepared" — the regression test for a real production bug (call 16: hanging up
  on a caller who answered right as the goodbye line started) — currently fails: the call gets finalized
  as `completed` even though the caller answers in time. Root cause: the `resolvedFlags` caching change
  in the same commit means `speakCannedLine` no longer awaits `getEffectiveFlags()` once flags are
  cached, which removed the seam the test used to gate that call and inject caller speech mid-flight.
  The test was mid-rewrite to a new technique (inject speech in the same tick the timer fires, before any
  microtask flush) when this was found — that technique doesn't yet reproduce the race correctly and the
  epoch guard isn't catching it. Needs someone to trace `handleSilenceTimeout`'s actual epoch-guard
  timing in `stream.ts` and get the test's synchronization right — not guessed at, since getting it wrong
  either masks a real regression or produces a false-positive test. **This is the sole failure in the api
  suite** (1413/1414) — everything else is green.

- **The activation boundary is unclear — draft/save/activate are one action, and dispatch reads a
  different trigger than the editor shows (`audit/2026-08-16-audit-18-...md`, found 2026-08-16, filed
  and indexed 2026-08-20, not yet actioned).** Three P0s: saving a workflow (standard or canvas save)
  sends `enabled: true`, and recommended defaults are already provisioned as live at the Agents
  onboarding step — before the "Review & activate" screen a merchant would reasonably expect to be the
  actual activation moment; the custom-graph trigger editor lets a merchant pick an event, but Shopify's
  inbound dispatch matches on the seeded **template**'s trigger, not the org's edited `customGraph`, so
  an edited trigger can silently never fire; and `workflow_runs` holds no version/graph-snapshot
  reference, so editing a workflow can change how an already-waiting or mid-call run proceeds. Proposes
  a draft → ready-to-test → tested → live → paused state machine. No product code changed.

- **Dead-code ratchet cleaned up (2026-09-05).** Knip baseline shrank from 60 → 2
  (`tools/dead-code/knip-baseline.json`, ADR-090): deleted orphaned web files, trimmed barrel
  re-exports, removed unused error classes and credential-vault helpers, and wired the leads ingest
  API-key UI on the merchant Leads page. Only harness duplicate exports remain baselined.
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
  `DATABASE_URL` (same Supabase project — was `wtqohdcghmxuujqyhlkz`, same pooler host, same db, same
  role), `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`, `SUPABASE_SERVICE_ROLE_KEY`,
  `ADMIN_API_KEY`, `WEEBER_INTERNAL_SECRET`, `WEEBER_CALLBACK_SECRET`, and every `PUBLIC_*_URL`. The only
  meaningful difference **as of that date** was `LLM_PROVIDER` (staging `groq`, prod `gateway`, and only
  prod sets `AI_GATEWAY_FALLBACK_MODELS`); the rest is Railway's own hostname/ID injection. Consequences
  worth saying out loud: a call placed "on staging" dials from the production Twilio number, bills the
  production Twilio account, and writes its `calls`/`guardrail_events`/DNC rows into the production
  database; a credential leak on staging is a prod leak. So staging currently verifies little beyond
  "the process boots." This must be fixed before a pilot merchant's data is in that database.
  (Also noise: `SUPABASE_KB_BUCKET` is set on staging only and is referenced nowhere in `packages/` —
  dead variable, safe to delete.)
  **Update 2026-09-04 (ADR-121):** Groq was removed as an LLM provider platform-wide, so the
  `LLM_PROVIDER` divergence this finding hinged on needs re-checking — staging's value (confirmed only
  as still *present* via Railway, not readable) must move to `gateway` as part of that rollout. Once it
  does, the two environments' *LLM* path converges, but the underlying finding — same database, same
  Twilio account, same secrets — is unrelated to which LLM provider either one runs and stands regardless.
  **STALE POINTER (flagged 2026-08-20, not re-verified):** `wtqohdcghmxuujqyhlkz` is the pre-migration
  project — abandoned since the 2026-08-17 Supabase account migration (see `active-context.md`).
  Production now runs on `qghtkadxbtptvbfbmsdz`; a *separate* staging project `zbcrwexrqfmjxhewirgp` now
  exists and was brought to schema parity with production as part of ADR-117 (2026-08-18), which reads
  as a deliberate move toward the isolation this finding calls for. Whether Railway's staging
  `DATABASE_URL` was actually repointed at that new staging project, or still shares production's
  (env var values are redacted from here, so this couldn't be confirmed directly), is the one thing
  that decides if this whole finding is fixed or still true. Check that before relying on either
  conclusion.
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
