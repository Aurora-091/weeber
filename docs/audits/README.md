# Audit log

Dated, point-in-time code audits — each one is a snapshot of "what does the codebase actually do
right now", not a plan or a spec. If a finding here is stale, the code has moved on since; check
[`docs/decisions/README.md`](../decisions/README.md) / [`docs/changelog/README.md`](../changelog/README.md)
for what happened after. Files are named `YYYY-MM-DD-<topic>.md` and are read chronologically, oldest
first.

> This directory absorbed the repo's separate top-level `audit/` folder on 2026-08-26 (git history
> preserved via `git mv`) — the two had run in parallel since 2026-07-19 with no doc linking them, and
> only this location (`docs/audits/`) was ever referenced from `AGENTS.md`/`docs/brain/00-index.md`, so
> the older folder's 18 files were invisible to any agent following the canonical read-order. Entries
> below are merged into one chronological list.

- **`2026-07-10-audit-01.md`** — first backend audit pass.
- **`2026-07-12-audit-02.md`** — follow-up backend audit.
- **`2026-07-13-audit-03.md`** — follow-up backend audit.
- **`2026-07-13-audit-04-uiux.md`** — first UI/UX-focused audit (admin panel + user dashboard).
- **`2026-07-15-audit-05.md`** — follow-up backend audit.
- **`2026-07-15-audit-06-db-systems.md`** — database/systems-focused audit (schema, migrations,
  Postgres/Supabase setup).
- **`2026-07-15-review-outbox-vault-versioning.md`** — targeted review of the outbox pattern, secrets
  vault, and versioning approach.
- **`2026-07-17-audit-07-live-infra.md`** — audit covering live infrastructure as currently deployed.
- **`2026-07-19-full-backend-ui-audit.md`** — full codebase audit (`packages/api` ~31k LOC,
  `packages/web` ~24k LOC, `packages/openvent-compliance` ~1.9k LOC, 55 web pages, 9 migrations),
  static read of every subsystem plus a fresh typecheck/lint/test run.
- **`2026-07-29-full-stack-audit.md`** — full-stack re-audit (UI/UX, frontend, backend/API/DB/edge,
  security, performance, multi-tenant/vertical correctness) plus a regression check against the
  2026-07-19 audit's closed findings.
- **`2026-07-30-audit-08-workflow-canvas-ux.md`** — cold UX audit of the merchant
  workflow builder (Standard view / canvas / AI-draft) + competitive matrix; drove the P0 persona-dropdown
  and AI-draft-front-door fixes shipped the same day.
- **`2026-08-03-audit-ui-ux-full-surface.md`** — a measured UI/UX audit of all three surfaces
  (public/marketing, merchant `/app`, admin `/dashboard`) at 390 and 1440, light/dark/reduced-motion,
  both private surfaces authenticated rather than mocked. WCAG 2.x + APCA contrast measured, tokens and
  components read for drift, with a competitor teardown of Vapi/Retell/Bland/Bolna. 49 findings and a
  scored rubric; no code was changed by the audit itself. Lived at the repo root as `ui-audit.md` until
  2026-08-20, when it was first filed under the audit log.
- **`2026-08-09-audit-09.md`** — pre-pilot risk audit at `cf929b0`. Baseline verified
  green (typecheck/lint/1111 tests) after 60 commits of drift; correctness is largely retired, so findings
  are operational — no spend/usage ceiling (P0), fail-open admin gate, unreaped `claimed` scheduled calls,
  Plivo/Exotel secrets leaking to the admin browser, transitional vault still dual-writing plaintext,
  PII in logs, 9 high dependency vulns with no supply-chain CI job, and detection-without-notification
  across health/spend/scheduler. Source-level only — no DB, deploy, traffic, or analytics access.
- **`2026-08-09-audit-10-outbound-hangup.md`** — root-cause diagnosis, confirmed
  against production DB + Railway logs, of "calls drop right after the greeting". The caller-silence
  timer is armed when TTS finishes *sending* audio rather than when Twilio finishes *playing* it, so
  any turn over 8s of speech makes the agent hang up on itself mid-greeting. 6/6 production calls
  affected, inbound and outbound; all six recorded `health_status = healthy`. The browser test-call
  path has no silence timer at all, which is why the preview appeared to work. Unresolved merge tags
  (no lead-field binding) are an aggravator: they force the slower LLM greeting, pushing it past the
  8s threshold. AMD was ruled out. Includes mark-event-based fix proposal.
- **`2026-08-09-audit-11-catalog-and-jurisdiction-structure.md`** — structural audit of two questions:
  (a) is the premade-vs-bespoke agent model right, and (b) on what axis should India and non-India be
  separated. Verdict: both structures are correct in shape and under-enforced in practice. The three-layer
  catalog model (`visibility`/`ownerOrgId` → `org_agent_configs`) is the right one, but visibility is applied
  in only 4 of ~10 reads of `agent_templates` — the merchant-facing `templateKey` path is unguarded, so
  `POST /api/app/agent-configs/:templateKey/test-chat` hands another org's private persona prompt to a chat
  the caller controls (P0). Region: the jurisdiction-pack resolver in `weeber-compliance` is already the right
  axis (per-call, recipient-based, not per-org) but only the calling window consumes it — provider chains,
  disclosure text, number series and licensing are each decided from a different input, which is how a US
  call can fail over into an Indian-accented Sarvam voice (P0) and how an unrecognized number silently gets
  US TCPA rules (P1). 8 findings, two proposed ADRs.
- **`2026-08-10-audit-12-agent-enablement-and-vertical-drift.md`** — opened to explain "I can't see the
  new agent in the old accounts", which turned out not to be a bug: the agent list filters on the org's
  `vertical` + `active` only, so the new insurance template is correctly invisible to the one shopify org
  and correctly visible to all three insurance orgs regardless of provisioning. Two real defects found
  while confirming it, both the ADR-091 shape (enforced on the browse path, ignored on the execution
  path): `org_agent_configs.enabled` is read in exactly 2 cosmetic places and **nowhere** on the call
  path, so the UI's "Paused" pill is decorative and a paused agent still answers and dials (P0, confirmed
  live — `rishipawar8999`/`insurance-post-sale-welcome` is paused with an active number); and
  `PATCH /settings` writes `vertical` with no cleanup, leaving off-vertical config rows that the list
  query hides but the resolver still reaches — 3 such ghost rows in production, one holding an active
  caller ID (P1). Includes the one enforcement decision (inbound call to a paused agent) that is a
  product call, not an engineering one. 3 findings, one proposed ADR.
- **`2026-08-10-audit-13-voice-pipeline-latency.md`** — research, not a defect sweep: where the milliseconds
  actually go in a voice turn, measured against all 9 production calls / 35 turns rather than assumed. The
  dashboard's ~1.67s voice-to-voice is flattering us at both ends — it starts at Deepgram's `speech_final`
  (so the 300ms endpointing wait is upstream of our clock) and ends when the first TTS byte reaches our
  process (so Twilio egress + PSTN are downstream of it); reconstructed mouth-to-ear is ~2.2s against a
  2026 market bar of 500-800ms. Two concrete findings: the 2026-07-16 literal-greeting fast path has
  **never fired in production** on any of the 9 calls, because every insurance template's opener needs a
  `{{interest_area}}`/`{{lead_name}}` the leads table doesn't hold, and one unresolved tag silently
  rejects the whole line into a ~1485ms LLM greeting (P0, worth ~73% of the measured 2037ms median
  pickup-to-first-audio); and Cartesia TTS first-byte roughly doubled from ~200-270ms to ~340-420ms
  across the commit boundary of ADR-083's lazy TTS connect, which plausibly serialised a per-turn
  WebSocket handshake behind the LLM instead of overlapping it (P1, n=2 calls after — hypothesis with a
  one-line decisive test). Ranked lever list with measured-vs-cited savings, plus the five things the
  instrumentation cannot currently see. No code changed, no ADR proposed.
- **`2026-08-10-audit-14-the-agent-does-not-know-when-or-who-it-is.md`** — the same day as audit 13,
  from reading calls 22-25 turn by turn instead of the stopwatch. Calls 24 (237s/16 turns) and 25
  (319s/27 turns) are the first production calls long enough to hold a real conversation, and they
  reframe the problem. **F1 (P0): nothing in the codebase ever injects the current date or timezone
  into the system prompt** — zero grep matches across `voice/*.ts` and `voice/tools/*.ts` — so call
  23, placed 2026-08-10, read "tomorrow at 10 AM" back as *"the 17th of July"* and called
  `bookAppointment` with `2026-07-17T10:00:00Z`, 25 days in the past and in UTC, which the caller
  confirmed and `crmSync` then recorded as fact. **F2 (P0, → ADR-094): three of four calls spoke an
  invented placeholder in their opening sentence** (`[Caller Name]`, `[Agent Name]`, "is this ?")
  because the merge-tag scrub deletes the hole and the model refills it — same root cause as audit
  13's latency P0, so one fix closes both. **§4 corrects audit 13's lever ordering:** `llm_ttft_ms`
  measures tool orchestration, not the model, on any turn with a tool call, and splitting the 56
  measured turns gives tool turns p50 **2956 ms** vs no-tool p50 **1329 ms** — +1627 ms on 29% of
  turns, the largest *measured* lever in either document, mostly redundant non-idempotent write-only
  tools awaited inside the caller's silence (`captureField` fired 11× on one call). Plus seven P1/P2
  findings: TTS control markup spoken aloud, a transfer announced but never bridged, a placeholder
  sent by SMS, health data stored after an explicit refusal, and `disposition` values that make the
  field unusable as a pilot metric. 9 findings, one proposed ADR, no code changed.
- **`2026-08-10-audit-15-the-market-is-a-column-nobody-reads.md`** — the third audit of the day, one
  level up from the call: not "is the call fast" or "does the agent know what it's saying" but **the
  code says India-first, the deployment is entirely US, and nothing connects the two.** `orgs` carries
  `country_code`/`currency`/`timezone` and **zero code under `voice/` reads any of them** — jurisdiction
  is inferred at dial time from the *callee's* `+91` prefix instead (`calling-window.ts:30`), which is
  right for calling windows and wrong for regulator, template eligibility, currency, language, provider
  and pricing plan (P0; 3 of 4 prod orgs have all three NULL). **India insurance is legally undeliverable
  as built** and our own gate correctly blocks it: TRAI's Direction of 16 Dec 2025 bars IRDAI-regulated
  entities from *any* service or transactional call from a non-1600-series number after 15 Feb 2026, and
  all four production numbers are US Twilio DIDs (P0). The whole Indic layer is **built and unreached**:
  `language` NULL on **14 of 17** configs → Deepgram+Cartesia on 10/10 recent calls and **Sarvam on 0
  calls all-time**. 9 findings, one proposed ADR (095), no code changed. Also carries the market read:
  Sarvam is now a self-serve competitor, Bolna raised $6.3M on the India cost-sensitivity pitch.
- **`2026-08-10-audit-16-the-gate-is-on-two-of-the-five-doors.md`** — the fourth audit of the day and
  the first written after the market pivot was confirmed: there is one real US-licensed insurance agency
  in pilot and ~5 on a waitlist, and **no India pilot was ever landed**, so this is a US-pilot-readiness
  audit rather than a plan check. **`placeOutboundCall` has five callers and only two of them run the
  compliance gates** (P0). `do_not_call` and `consent_records` are both **empty** (P0). `calls` is
  **11 rows all-time** and **`to_number` is `+91` on every single one** — the US pilot has placed zero
  US calls through this system (P1). Licensing precedence is wrong and fails open (P1). `plan_name` is
  NULL on all 4 orgs and no billing gateway is live (P1). 7 findings, two proposed ADRs (096, 097), no
  code changed.
- **`2026-08-14-audit-17-the-agent-narrates-tools-it-does-not-have.md`** — the database is no longer
  empty: one insurance org placed 11 real outbound test calls, the first calls in this system's history
  where a human actually held a conversation with the agent. Telephony/STT/TTS/latency work; **the tool
  layer does not.** On 8 of 11 calls the model either produced empty turns or **spoke the tool call out
  loud as text** — 18 of 68 agent lines (26%) contain literal call syntax. Two callers were told they
  were being transferred to a licensed advisor with no transfer number configured (P0). `bookAppointment`
  fabricated a callback confirmation with zero `scheduled_calls` rows (P0). 7 findings, no code changed.
  Four addenda over the following day narrowed the tool-syntax leak's root cause; F1 was fixed as ADR-115.
- **`2026-08-16-audit-18-the-activation-boundary-is-unclear.md`** — a product/UX review of the merchant
  journey from account creation to a live automation. Verdict: Weeber has solid runtime foundations but
  doesn't behave like the five-minute setup it implies. Two P0s: the custom-graph trigger editor and the
  Shopify dispatcher disagree on which trigger fires a workflow, and draft/save/activate are collapsed
  into one action. A third P0: `workflow_runs` carries no version/graph-snapshot reference. 10 findings
  (AW-01…AW-10), a proposed draft→ready→tested→live→paused state machine. Source review only.
- **`2026-08-16-manus-weeber-ui-ux-visual-audit.md`** — external, AI-authored (Manus AI) visual/UX
  assessment of the public landing page, authenticated Agents/Workflows/Home pages, waitlist form, and
  pricing page — visual-regression snapshots cross-checked against actual page source. Spot-checked
  before archiving; the cited `EmptyState` action-slot finding confirmed as a real, source-verified defect.
- **`2026-08-16-manus-weeber-vs-sota-voice-architecture.md`** — external, AI-authored (Manus AI)
  architecture assessment against state-of-the-art voice-agent stacks (realtime media path, model
  orchestration, telephony, state, reliability, observability, scaling). Grounded in the local checkout
  plus dated audits 13/17; competitive comparison uses primary vendor docs, not reproduced benchmarks.
  Spot-checked against the repo before archiving — nothing found fabricated or repo-mismatched.
- **`2026-08-21-first-two-production-calls.md`** — the first two production calls, read against the code
  directly from production Supabase (`calls`, `call_latency`, `turn_latency`, `transcripts`, `tool_calls`).
  A dated point-in-time artifact — its numbers are a snapshot, superseded by later call-count audits.
- **`2026-08-24-latency-vad-bargein-fillers-observability-review.md`** — a code-grounded review answering
  a founder questionnaire covering seven areas of the voice pipeline (latency, VAD/endpointing, barge-in,
  fillers, observability, cascade-vs-S2S), asked as a pre-check before starting
  `docs/plans/phase-c-latency.md`'s C2. Every answer sourced from the actual code or the 2026-08-21 audit's
  production numbers.
- **`2026-08-25-code-perf-simplification-audit.md`** — a dedicated code-quality pass on `voice/stream.ts`
  and `voice/agent.ts` after C1-C4 and D1-D8 plus the backchannel default-flip landed in one session on
  top of `stream.ts`'s pre-existing 3500+ lines: redundant per-turn work, dead/unreachable branches from
  the rapid layering, and genuine simplification opportunities.
- **`2026-08-25-fresh-sota-sweep.md`** — external research (web search, cited inline) narrowly scoped to
  findings genuinely new since the 2026-08-16 architecture audit, or not already decided against in the
  phase-c/phase-d "Explicitly out of scope" sections.
- **`2026-08-25-pipeline-edge-cases-research.md`** — external research on known failure modes in
  production voice-AI pipelines (turn-taking, barge-in, STT, tool-calling, demographics) not yet named
  by this repo's own audits, cross-referenced against the codebase.
- **`2026-08-25-provider-currency-deep-dive.md`** — external research (official provider docs, cited
  inline) going past the first-pass provider/model currency research, cross-referenced against the actual
  integration code (`stt/deepgram.ts`, `backchannel.ts`, `stream.ts`, `llm/transport-chain.ts`).
- **`2026-08-25-provider-model-currency-research.md`** — external research on what's shipped since this
  codebase pinned its provider/model versions (Deepgram STT, ElevenLabs TTS, Cartesia TTS, Sarvam STT/TTS,
  LLM model choice) that hasn't been adopted.
- **`2026-08-25-ten-calls-full-pipeline-review.md`** — ten production calls (up from 2), full pipeline
  read: latency, VAD/endpointing, turn-taking, state integrity. Two defects found here were fixed in the
  same session.
- **`2026-08-26-post-deploy-call-review.md`** — 18 calls reviewed, 3 genuinely post-deploy; found and
  fixed a live `hangUp`-latching defect (duplicate hangup calling a second, different goodbye over the
  caller's trailing sentence) the same day.
- **`2026-08-26-silence-and-continue-pattern.md`** — root-caused whether the live agent requires callers
  to explicitly say "continue" or goes silent after an interruption, cross-checked against
  `turn-detection/heuristic.ts` and `dictation.ts` directly.

See also `docs/product-strategy/agents-ux-audit-and-cogs-2026-07-17.md` for a source-level audit of
the Agents UI framework paired with COGS/unit-economics analysis — kept under `docs/` rather than here
since it's half product/GTM content, not a pure code audit.
