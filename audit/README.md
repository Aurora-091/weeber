# Audit log

Dated, point-in-time code audits — each one is a snapshot of "what does the codebase actually do
right now", not a plan or a spec. If a finding here is stale, the code has moved on since; check
[`docs/decisions/README.md`](../docs/decisions/README.md) / [`docs/changelog/README.md`](../docs/changelog/README.md)
for what happened after. Files are named `YYYY-MM-DD-audit-NN[-topic].md`
and are read chronologically, oldest first.

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
- **`2026-07-30-audit-08-workflow-canvas-ux.md`** — cold UX audit of the merchant
  workflow builder (Standard view / canvas / AI-draft) + competitive matrix; drove the P0 persona-dropdown
  and AI-draft-front-door fixes shipped the same day.
- **`2026-08-09-audit-09.md`** — pre-pilot risk audit at `cf929b0`. Baseline verified
  green (typecheck/lint/1111 tests) after 60 commits of drift; correctness is largely retired, so findings
  are operational — no spend/usage ceiling (P0), fail-open admin gate, unreaped `claimed` scheduled calls,
  Plivo/Exotel secrets leaking to the admin browser, transitional vault still dual-writing plaintext,
  PII in logs, 9 high dependency vulns with no supply-chain CI job, and detection-without-notification
  across health/spend/scheduler. Source-level only — no DB, deploy, traffic, or analytics access.
- **`2026-08-09-audit-10-outbound-hangup.md`** — most recent audit: root-cause diagnosis, confirmed
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
  and pricing plan (P0; 3 of 4 prod orgs have all three NULL, and `pricing-lock-2026-07-18.md`'s locked
  India-vs-Global plan split has no field to attach to). **India insurance is legally undeliverable as
  built** and our own gate correctly blocks it: TRAI's Direction of 16 Dec 2025 (primary PDF fetched,
  F. No. G-6/(8)/2025-QoS-Part(I), clause (iii)) bars IRDAI-regulated entities from *any* service or
  transactional call from a non-1600-series number after 15 Feb 2026 — consent does not cure it —
  `insurance-gates.ts:74` demands a `number_series='1600'` row, and all four production numbers are US
  Twilio DIDs with `number_series` NULL on a provider that cannot allocate that series (P0). The whole
  Indic layer is **built and unreached**: `language` NULL on **14 of 17** configs →
  `buildLanguageInstructionBlock` returns `""` → `prefersSarvam(null)` false → Deepgram+Cartesia on
  10/10 recent calls and **Sarvam on 0 calls all-time**, which also means the locked India Starter
  margin's good case (83% at Sarvam ₹1.2/min) has never occurred and 43% is the current number, not the
  floor. Paper-cited (arXiv 2604.19151v2 "Voice of India", 306k unscripted telephonic utterances, 15
  languages): our default STT, Deepgram Nova-3, is **Tier III "inadequate"** on Indian telephony (ta
  67.8, or 89.8, 7 of 15 languages unsupported) while Sarvam is Tier I in 13 of 15 (hi 5.0) — and no
  system clears WER 20 on all 15, so "10+ Indian languages" is not a defensible claim. Plus: `language`
  is a **free-text input** where `"hi-IN"` and `"Hindi"` silently lose the Sarvam route; localised
  disclosures cover **3 of 12** languages so a Tamil agent speaks an English legal line in a Tamil
  voice; "custom agents" is admin-only authoring with `persona_prompt` empty on **17 of 17** configs —
  a services motion priced as self-serve; and `calls` has no `template_key`/`agent_config_id`/`language`,
  so none of the above is answerable from data. 9 findings, one proposed ADR (095), no code changed.
  Also carries the market read: Sarvam (our Indic supplier) is now a self-serve competitor, Bolna raised
  $6.3M led by General Catalyst on exactly the India cost-sensitivity pitch, and the same ~$0.06/min
  COGS that prices us out of India's budget tier is a healthy margin in the US.

- **`2026-08-10-audit-16-the-gate-is-on-two-of-the-five-doors.md`** — the fourth audit of the day and
  the first written after the market pivot was confirmed: there is one real US-licensed insurance agency
  in pilot and ~5 on a waitlist, and **no India pilot was ever landed**, so this is a US-pilot-readiness
  audit rather than a plan check. **`placeOutboundCall` has five callers and only two of them run the
  compliance gates** (P0): gated are the scheduler (`workflows/scheduler.ts:119`, gates at `:81`/`:85`)
  and the campaign route (`voice/routes.ts:313`, gates at `:283`–`:303`); ungated are
  `POST /api/leads/:id/call-now` (`app/routes.ts:957`), the tenant preview test-call
  (`app/routes.ts:645`) and the admin `.../test-call-phone` (`voice/routes.ts:840`) — while
  `place-outbound-call.ts:80-88` carries a doc comment asserting "both call sites already run them
  before reaching here" and the file contains **zero** gate calls. Worse, the asymmetry is inverted by
  data: `insurance_advisors` has **0 rows**, so `checkInsuranceProducerLicensing`'s `advisors.some(...)`
  is `false` and the *gated* path 403s on every US number whose state resolves, while the *ungated*
  paths dial anything — the only paths that currently work are the ones with no gates (P0). `do_not_call`
  and `consent_records` are both **empty** (P0): under the FCC's Feb 2024 declaratory ruling an
  AI-generated voice is "artificial" under the TCPA, so prior express consent is required, damages run
  $500–$1,500 per call with **no aggregate cap** and a private right of action, and we have no record of
  either scrub or provenance. `calls` is **11 rows all-time** (first 2026-07-18, last 2026-08-10) and
  **`to_number` is `+91` on every single one** — the US pilot has placed zero US calls through this
  system, so nothing on the US path is production-proven, including the gates that would have blocked it
  (P1). Licensing precedence is wrong: `resolveUsState` infers state from the **area code**, which is
  portable, while ADR-087 already added a `state` intake field that this path never reads — and the check
  **fails open** when the state doesn't resolve (P1). `plan_name` is NULL on all 4 orgs and no billing
  gateway is live (Stripe rejected for the Indian entity), so a paying pilot cannot currently be billed
  (P1). India's 1600-series problem is **descoped by the pivot, not fixed** (P2). Ends with a pivot cost
  ledger (what the India-first build bought that the US market does not use — COD cart-recovery
  templates, the Indic/Sarvam layer, the 1600-series gate) and a blocking sequence. 7 findings, two
  proposed ADRs (096, 097), no code changed.

- **`2026-08-14-audit-17-the-agent-narrates-tools-it-does-not-have.md`** — the database is no longer
  empty: one insurance org placed 11 real outbound test calls (2026-08-13/14), the first calls in this
  system's history where a human actually held a conversation with the agent. Telephony/STT/TTS/latency
  work; **the tool layer does not.** On 8 of 11 calls the model either produced empty turns or **spoke
  the tool call out loud as text** — 18 of 68 agent lines (26%) on calls 8/9/11 contain literal call
  syntax like `<function name="setIntent">{...}`. Two callers were told they were being transferred to a
  licensed advisor; `orgs.human_transfer_number` is NULL, so no transfer was possible on either call
  (P0). `bookAppointment` fabricated a callback confirmation with no calendar connected and zero
  `scheduled_calls` rows (P0). The 2026-08-13 fix for the text-leak (`eafc762`) is live in the seeded
  personas but did not stop it — `output-guard.ts` passes both of call 11's leak shapes through uncaught
  (P0). Also: 15 fallback lines blame the caller for a model failure, latency improved to 1591ms v2v p50
  with a measured 672ms Groq-vs-gateway gap, and insurance has zero workflow templates so `/workflows`
  is empty for the only tenant in the launch vertical. 7 findings, no code changed. Four addenda over
  the following day narrowed the tool-syntax leak's root cause (see `docs/changelog/2026-08.md`); F1 was
  fixed as ADR-115.

- **`2026-08-16-audit-18-the-activation-boundary-is-unclear.md`** — not a call-level or code-correctness
  audit like 09-17; a product/UX review of the merchant journey from account creation to a live
  automation. Verdict: Weeber has solid runtime foundations (idempotent webhooks, compliance gates,
  compare-and-swap scheduling, a durable webhook outbox) but doesn't behave like the five-minute setup
  it implies — it behaves like an unfinished workflow platform whose controls overstate what the runtime
  honours. Two P0s stand out: the custom-graph trigger editor and the Shopify dispatcher disagree on
  which trigger fires a workflow (`findActiveWorkflowTemplate` matches on the **template**'s trigger,
  not the org's edited `customGraph`), and draft/save/activate are collapsed into one action — saving a
  workflow (standard or canvas) sends `enabled: true`, and defaults are already provisioned as live at
  the Agents onboarding step, before the "Review & activate" screen a merchant would reasonably expect
  to be the actual activation moment. A third P0: `workflow_runs` carries no version/graph-snapshot
  reference, so editing a workflow can change how an already-waiting or mid-call run proceeds. 10
  findings (AW-01…AW-10), a proposed draft→ready→tested→live→paused state machine, and a phased
  remediation plan. Source review only — no seeded live store, carrier account, or production
  credentials; no product code was modified.

See also `docs/product-strategy/agents-ux-audit-and-cogs-2026-07-17.md` for a source-level audit of
the Agents UI framework paired with COGS/unit-economics analysis — kept under `docs/` rather than here
since it's half product/GTM content, not a pure code audit.
