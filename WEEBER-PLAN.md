# WEEBER-PLAN.md — Product & Engineering Roadmap

> **Rewritten 2026-07-13.** This file used to be a Shopify-vertical-only build plan (workstreams
> A-S). It's now the platform-wide phase roadmap — Phase A (Foundation) → B (Differentiation) → C
> (Scale & Moat) → D (Cost/In-house) — derived from a competitive teardown of Bolna, ElevenLabs,
> Vapi, Retell, Bland, Vogent/Aircall, Synthflow, BiteSpeed, and Sarvam, cross-checked line-by-line
> against the actual current codebase, not aspirational. The old workstreams (J-S, F-I) are folded
> into the phases below where they fit; nothing from the old plan was silently dropped.
>
> **Checkbox convention:** `[x]` = verified live in code this session (file/function named below it),
> not just "probably done." `[ ]` = genuinely not found in the codebase as of this update. If you build
> something below, tick it *and* add the file reference — don't leave a checked box with no evidence.
>
> See `architecture/README.md` for the codebase map these file paths live in, and `DECISIONS.md` for
> the reasoning behind any decision referenced here.
>
> **Sharpened 2026-07-13 (same day, second pass)** against two research reports that predate this
> session's work (`voice-ai-orchestration.report`, `weeber-stack-decision.report`, both 2026-07-12) —
> folded into A1/D1/D2/D3 below with concrete targets, not just "evaluate later." One factual conflict
> resolved: `weeber-stack-decision.report` claimed no per-tenant Twilio isolation existed yet — that's
> now stale, A2 below (`twilio-provisioning.ts`) closed that gap after the report was written.

---

## Where we actually are, in one paragraph

The core voice product works end to end — real calls, real barge-in, real tool-calling, real
multi-tenant telephony (Twilio + Plivo/Exotel), real per-org retry cadence, a real Shopify vertical
with revenue attribution, a real Workflow Canvas, real compliance scaffolding. What's missing is the
thing that actually differentiates Weeber from the horizontal builders and from BiteSpeed (the direct
Shopify-vertical competitor): true dual-language-in-one-call. Phase A and most of Phase B are done;
Phase B2 is the one open item that matters most before a serious pitch or pilot; Phase C is
started-but-partial and not currently blocking anything; Phase D is correctly untouched, though D1
(Kokoro TTS pilot) and D4 (join NVIDIA Inception) are both cheap enough to start opportunistically.
A1 also picked up a real sub-item (A1b, VAD/endpointing audit) that shouldn't be assumed done just
because the pipeline itself works.

---

## Phase A — Foundation

- [x] **A1 — Cascaded pipeline + turn-taking/barge-in.**
  `packages/api/src/voice/stream.ts` (`createVoiceStreamHandlers`), `voice/agent.ts`
  (`runVoiceAgentTurn`, `runVoiceAgentGreeting`), `voice/stt/deepgram.ts`, `voice/tts/{elevenlabs,
  cartesia}.ts`, `voice/llm/index.ts`. Barge-in and mid-turn tool-calls are real, tested
  (`test-call-stream.test.ts`: "barge-in: a transcript while the agent is speaking sends clear and
  aborts", "surfaces real tool calls as a transcript-adjacent event").
  **Architecture choice validated** (`voice-ai-orchestration.report`, 2026-07-12, predates this
  session's work): cascaded over speech-to-speech is correct *specifically because of compliance*, not
  latency — cascade produces an inspectable text boundary at every stage, which is what HIPAA Audit
  Controls / SOC 2 Processing Integrity actually require; S2S has no equivalent without bolting a
  parallel transcription layer back on, which erases the latency advantage you adopted it for. None of
  Vapi/Retell/Bland/Bolna run true native S2S in production for the same reason. Current LLM default
  (`groq/llama-3.3-70b-versatile`) is validated too — every competitor converges on "fast-tier, not
  reasoning-tier" for live turns, reserving reasoning models for async/post-call work.
  - [ ] **A1b — VAD/endpointing audit against the orchestration-quality bar.** **Not yet done — this is
    the real remaining gap, not "A1 is finished."** The same report is explicit that the actual
    competitive line between "production-grade" and "demo" isn't vendor choice, it's orchestration
    engineering: a 4-state VAD machine (STARTING/SPEAKING/STOPPING/SILENT, not a volume threshold), a
    rolling-RMS adaptive noise filter, endpointing as rule-based + ML + regex-context combined (Vapi
    reports this cut premature interruptions 73% vs. a fixed timeout), speculative/"greedy" LLM
    inference (send the instant the system *thinks* the caller is done, cancel-and-restart silently if
    they keep talking), and sub-100ms interruption handling reconciled against TTS word-level
    timestamps. **Action: audit `voice/stream.ts`'s current VAD/endpointing implementation line-by-line
    against this list before claiming A1 matches the competitive bar** — a bad turn-taking model costs
    500ms+ of *perceived* latency even when every component benchmark looks fine.
- [x] **A2 — Per-tenant Twilio sub-accounts + Plivo/Exotel SIP for India.**
  `voice/twilio-provisioning.ts` (real sub-account creation, not a stub), `voice/telephony-transport.ts`
  (wire-format abstraction), `voice/{plivo,exotel}-{client,provisioning}.ts`. `orgs.twilioMode`
  (`platform` | own sub-account). See ADR-048/ADR-049 in `DECISIONS.md`.
- [x] **A3 — Tools/function-calling contract.**
  `voice/tools/*.ts` — 8 real tools: `offerCartRecoveryDiscount`, `confirmCodOrder`, `captureField`,
  `hangUp`, `transferToHuman`, `flagGuardrailEvent`, `crmSync`, `bookAppointment`, `setDisposition`,
  `lookupInfo`. Bound per persona preset (8+8 for Shopify+Clinic).
- [ ] **A3b — Knowledge Base (PDF upload → RAG) per vertical.**
  **Not built.** No `knowledge_base`/`documents`/embedding table anywhere in `schema.ts`, no
  embed/retrieve code in `packages/api/src`. But `docs/agent-prompts/01-cart-recovery-agent.md` and
  `04-insurance-policy-renewal-agent.md` explicitly instruct the agent to "answer only from the
  merchant's configured knowledge base" — **the prompts promise a feature the backend doesn't have.**
  Flagged inline in `01-cart-recovery-agent.md` as of this update. Do not demo this section as live.
  *(Separate from this: `caller_memory`/`buildKnownFactsBlock` — structured, deterministic per-call
  memory — is real and built, see `architecture/voice-orchestration.md`'s note. Don't conflate the two;
  different problem, different solution shape.)*

**Phase A: closed except A3b (KB).**

---

## Phase B — Differentiation (the wedge)

- [x] **B1 — Done-for-you vertical templates.**
  Shopify: Cart Recovery (`offerCartRecoveryDiscount`, 45min delay, 2 attempts, ends by purchase or
  exhaustion — no punitive follow-up), COD Confirmation (`confirmCodOrder`, 30min delay, 3 attempts,
  auto-cancels via weebersh `/orders/cancel` on exhaustion, and — fixed 2026-07-13 — cancels
  immediately on an explicit decline rather than waiting out all 3 attempts), Feedback (`captureField`,
  3 days post-fulfillment, 1 attempt, no retry). Clinic: `insurance-policy-renewal` +
  `insurance-lead-followup` personas, both explicitly refuse to quote/advise/sell (IRDAI-safe by
  design). All are plain `scheduled_calls` rows picked up by the existing 60s sweep
  (`voice/workflows/scheduler.ts`) — no bespoke scheduling infra needed. Revenue-attribution reporting
  (mirroring BiteSpeed's ₹-recovered framing) is covered under B3.
- [ ] **B2 — Dual-language-in-one-call.** **Not built — the single most important open item.**
  Sarvam is wired as a *selectable provider* (`voice/stt/sarvam.ts`, `voice/tts/sarvam.ts`, and the
  `sttProvider`/`voiceProvider` dropdowns in the agent config UI already list it) — but there is no
  per-call language detection, no voice-switch logic, no debounce, no localized system messages. Today
  `language` is one static field per agent config, not a live, mid-call switch. Deferred back to Phase
  B per direction on 2026-07-13 (considered pulling into Phase A since the LLM/STT layers turned out
  simpler than first assumed — see "B2 breakdown" below — but staying in B since it's explicitly the
  differentiation story, not baseline infra).

  **B2 breakdown (revised scope, smaller than Bolna's full per-language-prompt-tab architecture,
  because Sarvam's Saaras model already handles code-mixed Hindi/English in one model — you don't need
  Bolna's hard vendor-per-language split unless you want non-Sarvam options for Hindi too):**
  - [ ] **B2.1** — One shared multilingual system-prompt instruction ("detect the caller's language,
    respond naturally, handle Hinglish mixing") — prompt-only change, `voice/agent.ts` persona
    assembly.
  - [ ] **B2.2** — Run Sarvam STT in its native multilingual/code-mix mode for the Indic call path
    (flagged per-org/per-vertical, not forced on English-only calls — de-risks existing call quality).
  - [ ] **B2.3** — Per-detected-language TTS voice lookup table (Sarvam Bulbul voice IDs), selected at
    synthesis time in `voice/tts/sarvam.ts`, not a merchant-set config field.
  - [ ] **B2.4** — Switch-debounce: N consecutive turns or a confidence threshold before actually
    flipping the active TTS voice (mirrors Bolna's "detection activates after 3 turns").
  - [ ] **B2.5** — Localize the handful of system messages (silence prompt, hangup line, tool-wait
    filler) per supported language.
- [x]/[ ] **B3 — Post-call analytics + revenue attribution + compliance layer.** *(Mixed — see below.)*
  - [x] Revenue attribution: `scheduled_calls.recoveredOrderId`/`recoveredAmount`, order value
    attributed to the executed cart-recovery call within a 7-day window (tested).
  - [x] Analytics pages exist: `pages/app/analytics.tsx`, `pages/dashboard/{analytics,
    revenue-analytics,marketing-analytics}.tsx`.
  - [x] Consent/TCPA/DNC/calling-window compliance gate is real and enforced on every outbound call
    (`packages/openvent-compliance`, `voice/compliance/adapters.ts`).
  - [ ] Per-org DNC (see Phase C, item **P** below — DNC is still global).
  - [ ] India DPDP/TRAI compliance findings — code exists (`calling-window.ts` has IST-window logic)
    but whether this was ever explicitly confirmed *closed* with you is unclear from the docs — treat
    as open until confirmed, not code work.

**Phase B: mostly done. B2 is the real gap and the priority.**

---

## Phase C — Scale & Moat

- [ ] **C1 — Concurrency tiers + queue.** Not found in `schema.ts` or `voice/workflows/` — no
  per-org concurrent-call limiting/plan-tier exists. Real cost/queueing constraint once volume grows;
  not urgent at current scale.
- [x] **C1b — Opt-in graph/canvas workflow editor.** Workflow Canvas shipped: `components/canvas/
  {WorkflowNode,BranchEdge,NodeConfigPanel,NodePalette,types,node-styles,seed-graph}.tsx`,
  `pages/app/workflows.tsx` (merchant, read-only graph + override panel), `pages/dashboard/
  workflow-editor.tsx` (admin, full drag-drop). **Note:** this branches on *call outcome* (answered/
  no-answer/interested/etc.) — it is not the same thing as entry-condition branching (item **S**
  below), which branches *before* the first call based on order/cart data. Don't conflate the two when
  scoping future work.
- [x] **C2a — BYO-SIP + retry dialer.** Per-org retry cadence (`voice/retry-config.ts`: first-call
  delay, delay-between-retries, max-attempts, capped 1-20) shipped 2026-07-13. Plivo/Exotel BYO-SIP:
  done (A2). `confirmCodOrder`'s immediate-cancel-on-decline fix: done same session.
- [ ] **C2b — Number pooling.** Not found — per-org number provisioning exists (A2), but no evidence
  of a pool/rotation mechanism across multiple numbers per org.
- [x] **C3a — Shopify integration.** Deep — 9 contract-defined webhook receivers
  (`integrations/shopify/routes.ts`), checkout-token-based cancellation matching, GDPR
  redact/erasure wired to `/customers/redact`.
- [x] **C3b — Calendar/booking.** `voice/integrations/google-calendar.ts` — real, tested (treats
  non-2xx as failure, not a false success).
- [x]/[ ] **C3c — CRM integrations.** HubSpot/Salesforce/GoHighLevel adapters exist and are tested —
  but all three (plus Google Calendar) currently read **one shared, globally-configured token**, not a
  per-org connection. Per-org CRM (item **R** below) is the open half of this.
- [x] **C3d — Generic webhook catch-all (n8n/Zapier/Make).** `voice/webhooks.ts` — fire-and-forget,
  explicitly documented as consumable by any automation tool. This *is* the "Zapier/n8n" integration
  the competitive teardown recommends — already done, don't rebuild it as a separate feature.
- [ ] **C3e — WhatsApp.** Not built. `docs/agent-prompts/01-cart-recovery-agent.md` explicitly says
  "do not promise WhatsApp... it isn't built yet" — this is a known, documented gap, not an oversight.

### Folded in from the old plan — still-open cross-cutting items

- [ ] **F — `WEEBER_INTERNAL_SECRET`/`WEEBER_CALLBACK_SECRET` match in both repos.** Status not
  re-verified this session — confirm before assuming it's fine.
- [ ] **G — Real end-to-end test against a live Shopify dev-store checkout.** Needs a real manual
  run; can't be verified from a sandbox, no amount of code review substitutes for this.
- [ ] **I — India DND/TRAI compliance confirmation.** Same as B3's compliance note above — code
  exists, explicit confirmation-with-you status unclear.
- [ ] **P — Per-org DNC lists.** `do_not_call` table has no `orgId` column — one global list across
  every tenant. **Touches `packages/openvent-compliance` — confirm with the user before changing
  anything here (CLAUDE.md gate #6).**
- [ ] **Q — Full RBAC / multi-seat user accounts.** `org_members.role` defaults to `"owner"` only, no
  invite/second-seat flow exists.
- [ ] **R — Per-org CRM connections (Nango or similar embedded iPaaS).** See C3c above — same gap,
  cross-referenced here since it was originally scoped as its own workstream.
- [ ] **S — Entry-condition branching ("trigger split").** No `entryConditions` anywhere in the
  codebase. **Config-driven vs. visual-canvas-from-day-one is still an explicitly open product
  decision — ask before starting (CLAUDE.md gate #4).** Distinct from the Workflow Canvas (C1b) — see
  that item's note.

**Phase C: several pieces already shipped as a side effect of other work (retry cadence, canvas,
webhooks) — genuinely open pieces are P, Q, R, S, C1, C2b, C3e. None of these block a pilot merchant or
an investor demo today.**

---

## Phase D — Cost / In-house *(only if unit economics force it — do not start early)*

**Sharpened 2026-07-13 against `voice-ai-orchestration.report` (2026-07-12) — same "not started, don't
start early" verdict, but now with concrete targets instead of a vague "evaluate in-house":**

- [ ] **D1 — In-house TTS evaluation.** Not started. Correct call to defer, but this is now **the one
  layer where self-hosting is genuinely cheap and credible today**, not just theoretical:
  - **Kokoro v1.0** (82M params, Apache 2.0) — the concrete first pilot target. Runs on CPU, ~200x
    real-time on a single RTX 4090, extremely low footprint. No voice cloning, mid-tier naturalness
    (44% win rate on TTS Arena head-to-heads) — good enough for template-driven scripted flows
    (cart-recovery, COD confirmation) where cloning isn't required.
  - **Orpheus** (3B/1B/400M/150M, Llama-based, Apache 2.0) — the upgrade path *if and only if*
    brand-voice cloning becomes a real product requirement. Larger variants need real GPU, not
    CPU-viable like Kokoro.
  - Both Apache 2.0 — no licensing blocker either way. Keep ElevenLabs/Cartesia (English) + Sarvam
    (Indic) as the default; this is a pilot to validate cost/quality, not a cutover plan.
- [ ] **D2 — Fine-tuned small LLM / speech-to-speech pilot.** Not started. **Harder "don't yet" than
  previously written** — this isn't just "speech-to-speech is immature," the small-LLM half is a
  documented reliability regression, not a cost optimization: nano/lite-tier models measurably drop
  multi-turn function-calling reliability vs. GPT-4.1/5.x-class models even when the conversation itself
  sounds fine — directly threatens tool-heavy flows like `offerCartRecoveryDiscount`/`confirmCodOrder`.
  Revisit only if a specific small model publishes voice-workload function-calling benchmarks
  competitive with GPT-4.1-class. STT self-hosting is a separate "not yet, different reason": Groq-hosted
  Whisper-v3 at **$0.04/hr** is already the cheap option without owning infrastructure — self-hosting
  Whisper yourself only wins past a volume threshold Weeber isn't at.
- [ ] **D3 — Prepaid credit wallet billing engine.** Not started. Current billing is Razorpay,
  flat-tier subscription (ADR-034) — not a usage-metered prepaid wallet. Worth building once you have
  enough paying merchants that a bundled ₹-native prepaid model (Bolna's pattern) becomes worth the
  engineering, not before. **Reference COGS to price against** (`weeber-stack-decision.report`,
  sourced): openvent's own runtime blends to **~$0.048/min** (Twilio + Deepgram + gpt-4o-mini/Gemini
  Flash + Cartesia, no platform fee) — sharper than the round "~$0.06/min" figure used elsewhere, and
  worth quoting this way in any pricing/investor conversation instead.
- [ ] **D4 — GPU credits, concrete path (new, from `voice-ai-orchestration.report`).** "Free" GPU
  credits are real but the headline number is inflated 2-3x vs. what it actually buys at a hyperscaler's
  list price.
  - **Join NVIDIA Inception now** — free, no equity, no application fee, no gate. It doesn't hand you
    compute directly; it's the *unlock key* for the programs below. Zero-cost, no reason to delay this
    one specifically.
  - **Nebius AI Lift** (gated behind Inception membership) — up to $150K cloud credits + $10K dedicated
    inference credits. Ranks highest in real terms because Nebius is a neocloud priced well below
    hyperscaler list rates — a credit dollar here stretches 2-3x further than the same dollar at AWS/
    Google.
  - **AWS Activate's self-serve $1K-5K tier** — realistically reachable now, no VC/accelerator
    relationship required. The larger Portfolio tier ($100K-300K) and Google for Startups' $350K tier
    both gate behind funding-stage/accelerator credentials Weeber doesn't have yet — don't plan around
    those until that changes.
  - Treat any credit secured as **pilot runway** (e.g., standing up the D1 Kokoro pilot), not a
    long-term compute budget line — the "credit cliff" (e.g., Google's tier drops from 100% to 20%
    coverage in Year 2, to 0% in Year 3) arrives faster than the headline number suggests.

**Phase D: correctly untouched, still not urgent — but D1 (Kokoro pilot) and D4 (join NVIDIA Inception)
are both genuinely low-cost/zero-cost to start whenever there's spare time, unlike D2/D3 which should
stay parked until volume/revenue actually demands them.**

---

## Immediate technical debt (not hidden, not a phase item, just true)

- **`VerticalDefinition.dashboard.metrics`/`cards`/`emptyState`** (`packages/web/src/web/lib/
  verticals.ts`) is defined for both `shopify` and `insurance` verticals but **`pages/app/home.tsx`
  never reads it** — dead config. A prior doc (`docs/archive/USER-APP-PAGE-MAP.md`) claimed this was
  wired up; it wasn't. Small fix once picked up: read `vertical.dashboard` in `home.tsx`.
- **Staging Supabase project has a placeholder `DATABASE_URL` on Railway.** Not re-verified this
  session — flag as unconfirmed, not assumed fixed.
- **Theme portal-scoping, agent full-window layout, 2 Dependabot vulns** — all fixed 2026-07-13, see
  `audit/2026-07-13-audit-04-uiux.md` and the `changelog.md` entries for that date. Listed here only so
  this file doesn't look like it's ignoring them; they're closed, not open.

---

## Personas / prompt copy — status

All 5 personas are written, not placeholders: `docs/agent-prompts/01-cart-recovery-agent.md`,
`02-cod-confirmation-agent.md`, `03-feedback-agent.md` (drafted fresh, no reference sample — flagged
in `CLAUDE.md`'s STOP-AND-ASK list as needing your confirmation before treating it as final, unlike
01/02 which are adapted from real reference prompts), `04-insurance-policy-renewal-agent.md`,
`05-insurance-lead-followup-agent.md`. The feedback agent (03) deliberately reuses the generic
`captureField` tool rather than a dedicated feedback tool — no new tool was needed for that persona.

## Config storage — resolved

The original open question here ("move persona/workflow config from env-var to a DB table before
building any form UI") is resolved and done: `org_agent_configs`/`org_workflow_configs` are real,
DB-backed, read at call-time — not `process.env`. Nothing left to decide on this point.
