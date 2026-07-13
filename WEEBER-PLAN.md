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

---

## Where we actually are, in one paragraph

The core voice product works end to end — real calls, real barge-in, real tool-calling, real
multi-tenant telephony (Twilio + Plivo/Exotel), real per-org retry cadence, a real Shopify vertical
with revenue attribution, a real Workflow Canvas, real compliance scaffolding. What's missing is the
thing that actually differentiates Weeber from the horizontal builders and from BiteSpeed (the direct
Shopify-vertical competitor): true dual-language-in-one-call. Phase A and most of Phase B are done;
Phase B2 is the one open item that matters most before a serious pitch or pilot; Phase C is
started-but-partial and not currently blocking anything; Phase D is correctly untouched.

---

## Phase A — Foundation

- [x] **A1 — Cascaded pipeline + turn-taking/barge-in.**
  `packages/api/src/voice/stream.ts` (`createVoiceStreamHandlers`), `voice/agent.ts`
  (`runVoiceAgentTurn`, `runVoiceAgentGreeting`), `voice/stt/deepgram.ts`, `voice/tts/{elevenlabs,
  cartesia}.ts`, `voice/llm/index.ts`. Barge-in and mid-turn tool-calls are real, tested
  (`test-call-stream.test.ts`: "barge-in: a transcript while the agent is speaking sends clear and
  aborts", "surfaces real tool calls as a transcript-adjacent event").
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

- [ ] **D1 — In-house TTS evaluation.** Not started. Correct — biggest COGS line, but nowhere near the
  volume where this pays off. Keep ElevenLabs/Cartesia (English) + Sarvam (Indic).
- [ ] **D2 — Fine-tuned small LLM / speech-to-speech pilot.** Not started. Correct — speech-to-speech
  is immature on tool-calling/voice-choice/cost across every platform in the competitive teardown, not
  just for Weeber.
- [ ] **D3 — Prepaid credit wallet billing engine.** Not started. Current billing is Razorpay,
  flat-tier subscription (ADR-034) — not a usage-metered prepaid wallet. Worth building once you have
  enough paying merchants that a bundled ₹-native prepaid model (Bolna's pattern) becomes worth the
  engineering, not before.

**Phase D: correctly untouched. Nothing here is blocking anything else on this list.**

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
