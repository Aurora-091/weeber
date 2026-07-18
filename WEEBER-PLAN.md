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
the STT/TTS quality foundation B2 needs is now solid and live-verified as of 2026-07-16 (see
`docs/voice-quality/hindi-hinglish-voice-support.md`), but B2's actual dynamic mid-call switching is still the one
open item that matters most before a serious pitch or pilot; Phase C is
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
  - [x] **A1b — VAD/endpointing audit against the orchestration-quality bar.** Audited 2026-07-14
    (`stream.ts`, `stt/deepgram.ts`) against this list. Found and fixed 2 real gaps, not just
    documented: (1) `vad_events=true` was already set on the Deepgram connection but never consumed —
    the message handler only handled `type=Results`, silently discarding `SpeechStarted`/`UtteranceEnd`;
    added `utterance_end_ms=1000` + a `pendingFinalText` buffer so `UtteranceEnd` now replays as a
    synthetic `speech_final` when Deepgram's own `speech_final` never fires (a known Deepgram edge
    case — cross-talk, audio trailing off). (2) No rule-based/regex-context layer existed on top of the
    single fixed-timeout vendor signal — added `endsMidThought()`, a cheap trailing-conjunction/filler
    check (and/so/but/or/because/um/uh/like/well/then) that holds the turn one more beat instead of
    answering a fragment. Barge-in itself audited as already correct — fires on any non-empty interim
    transcript, not gated on `isFinal`/`speechFinal`, no fix needed. 10 new tests
    (`deepgram.test.ts`, `stream.test.ts`). **Not done, correctly scoped out as bigger asks, not
    silently dropped:** a rolling-RMS adaptive noise filter (no adaptive layer in our own code; Twilio-
    side AEC covers the common case) and speculative/"greedy" LLM inference (send the instant the model
    *thinks* the caller is done, cancel-and-restart if wrong) — both are real follow-ups, not bug fixes.
- [x] **A2 — Per-tenant Twilio sub-accounts + Plivo/Exotel SIP for India.**
  `voice/twilio-provisioning.ts` (real sub-account creation, not a stub), `voice/telephony-transport.ts`
  (wire-format abstraction), `voice/{plivo,exotel}-{client,provisioning}.ts`. `orgs.twilioMode`
  (`platform` | own sub-account). See ADR-048/ADR-049 in `DECISIONS.md`.
- [x] **A3 — Tools/function-calling contract.**
  `voice/tools/*.ts` — 8 real tools: `offerCartRecoveryDiscount`, `confirmCodOrder`, `captureField`,
  `hangUp`, `transferToHuman`, `flagGuardrailEvent`, `crmSync`, `bookAppointment`, `setDisposition`,
  `lookupInfo`. Bound per persona preset (8+8 for Shopify+Clinic).
- [x] **A3b — Knowledge Base (PDF upload → RAG) per vertical.**
  Shipped 2026-07-14. New `knowledge_documents`/`knowledge_chunks` tables (`0022_add_knowledge_base.sql`)
  and `voice/knowledge-base.ts`: chunking (paragraph-aware, 800 chars/150 overlap, capped at 500 chunks/doc),
  extraction for text/URL (simple HTML-strip, no readability pass)/PDF (`pdf-parse`, text-layer only — no
  OCR), embedding via the same AI Gateway every LLM call already uses (`AI_GATEWAY_EMBEDDING_MODEL`,
  default `openai/text-embedding-3-small`), and brute-force in-memory cosine-similarity retrieval per org
  (no pgvector dependency — see the schema doc comment for why that's fine at this scale). `lookupInfo`
  (previously an explicit stub) is now a factory bound to the calling org via the new `buildVoiceTools`
  (`agent.ts`) — the one place tool sets get built everywhere (stream.ts live calls, both admin/merchant
  test-chat sandboxes, synthetic-test.ts), replacing 4 copies of the same enabledTools-filter logic.
  New merchant CRUD: `GET/POST/DELETE /api/app/knowledge-base` (own rate limiter, 10MB PDF cap) + a new
  `/app/knowledge-base` page (paste text / URL / PDF upload, per-doc status + delete) in both verticals'
  nav. Scope, deliberately: PDF/pasted-text/single-URL only — no crawling, no scheduled re-sync, no OCR,
  no admin-side management UI (org's own team manages it; deferred). 9 new tests (`knowledge-base.test.ts`).

**Phase A: closed.**

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
- [ ] **B2 — Dual-language-in-one-call.** **Partially built as of 2026-07-16 — the STT/TTS
  foundation for this is now solid and live-verified; the actual dynamic mid-call switching (B2.3/
  B2.4/B2.5 below) is still not built. Don't mark this closed.** Full research + live-verification
  detail in `docs/voice-quality/hindi-hinglish-voice-support.md` (separate doc, not duplicated here) — summary:
  found and fixed 2 real silent bugs in a new ElevenLabs Scribe v2 Realtime STT adapter via live
  testing with a real account (wrong audio-format query param caused garbled/nonsense transcripts
  with zero errors; `close()` raced the server's final-transcript response), live-verified
  ElevenLabs Scribe's Indic-English code-switching claim with real Hinglish audio ("मुझे एक flight
  book करनी है" transcribed back with "flight"/"book" correctly kept in Latin script), fixed
  Sarvam's STT `mode: "transcribe"` → `"codemix"` (also live-verified, real before/after
  comparison), and shipped an ElevenLabs pronunciation dictionary (also live-verified: "COD" was
  being misheard as "card" without it). Also added an agents-tab UI recommendation
  (`getRecommendedVoiceStack` in `lib/agent-config.ts`) that surfaces ElevenLabs as the tested
  default for Hindi rather than leaving orgs to land on Sarvam/Deepgram combinations known to
  underperform.

  Sarvam is wired as a *selectable provider* (`voice/stt/sarvam.ts`, `voice/tts/sarvam.ts`, and the
  `sttProvider`/`voiceProvider` dropdowns in the agent config UI already list it, now alongside
  `elevenlabs` too) — but there is still no per-call language detection, no voice-switch logic, no
  debounce, no localized system messages. Today `language` is one static field per agent config,
  not a live, mid-call switch. Deferred back to Phase B per direction on 2026-07-13 (considered
  pulling into Phase A since the LLM/STT layers turned out simpler than first assumed — see "B2
  breakdown" below — but staying in B since it's explicitly the differentiation story, not baseline
  infra).

  **B2 breakdown (revised scope, smaller than Bolna's full per-language-prompt-tab architecture,
  because Sarvam's Saaras model — and, as of 2026-07-16, ElevenLabs Scribe too — already handles
  code-mixed Hindi/English in one model — you don't need Bolna's hard vendor-per-language split
  unless you want non-Sarvam/non-ElevenLabs options for Hindi too):**
  - [ ] **B2.1** — One shared multilingual system-prompt instruction ("detect the caller's language,
    respond naturally, handle Hinglish mixing") — prompt-only change, `voice/agent.ts` persona
    assembly. Still not a systemic/shared instruction — `buildLanguageInstructionBlock` (added
    2026-07-12, see `docs/voice-quality/voice-quality-and-india-status-2026-07-12.md`) tells the LLM to *stay* in
    whichever language it opened with, which is a mitigation for the TTS-can't-switch-voice problem
    below, not the same thing as an explicit "detect and switch" instruction B2.1 describes.
  - [x] **B2.2 (revised)** — STT now correctly handles code-mixed Hindi/English for the Indic call
    path, but via a **provider choice, not a Sarvam-only mode flag** as originally scoped: either
    Sarvam STT in `mode: "codemix"` (`voice/stt/sarvam.ts`, live-verified 2026-07-16) or the new
    ElevenLabs Scribe v2 Realtime adapter (`voice/stt/elevenlabs.ts`, also live-verified, currently
    the recommended default per the agents-tab UI). Still per-agent-config, not per-org/per-vertical
    auto-flagged as B2.2 originally described — an operator picks the STT provider explicitly.
  - [ ] **B2.3** — Per-detected-language TTS voice lookup table, selected at synthesis time — **not
    built.** Worth re-scoping given ElevenLabs Scribe's own docs claim automatic mid-conversation
    language detection/switching (unverified for our specific use case — our live test only
    exercised a single-language-throughout call) — if that claim holds for genuinely bilingual
    calls, B2.3's STT-side detection work may already be solved by the provider, narrowing this to
    just the TTS-voice-switching half. Needs a real bilingual test call to confirm before assuming
    that shortcut is real.
  - [ ] **B2.4** — Switch-debounce: N consecutive turns or a confidence threshold before actually
    flipping the active TTS voice (mirrors Bolna's "detection activates after 3 turns"). Not built.
  - [ ] **B2.5** — Localize the handful of system messages (silence prompt, hangup line, tool-wait
    filler) per supported language. Not built.
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

**Phase B: mostly done. B2's foundation (STT/TTS quality for Hindi/Hinglish, live-verified
2026-07-16 — see `docs/voice-quality/hindi-hinglish-voice-support.md`) is now solid, but true dynamic
mid-call language switching (B2.3/B2.4/B2.5) is still the real gap and the priority.**

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
- [ ] **C2b — Number management: pooling, per-agent assignment, decommission.** **Confirmed real gap,
  verified in code 2026-07-13** (not just "not found" — traced exactly what exists and what doesn't):
  - `orgs.outboundNumber` is a **single text column** — one number per org, full stop. There is no
    `org_phone_numbers`-style table; an org cannot own two numbers today.
  - `voice/twilio-provisioning.ts`'s `buyNumberForOrg(orgId, countryCode, areaCode)` doesn't give the
    user a choice — it searches Twilio's available-numbers API with `limit: 1` and **buys the first
    match automatically**. No candidate list, no picker.
  - **No release/decommission function exists anywhere** — once a number is bought, there is no code
    path to release it back to Twilio or unassign it from the org.
  - **No per-agent number assignment** — `org_agent_configs` has no `phoneNumberId`/number field. Every
    agent on an org shares whatever single number `orgs.outboundNumber` holds; there's no way for a
    Shopify cart-recovery agent and a clinic booking agent under the same org to use different numbers.
  - **No dedicated Numbers page** — the only UI is a "connect one number" form buried inside
    `pages/app/integrations.tsx` (BYO Twilio/Plivo/Exotel credentials, or buy-one-Twilio-number). No
    page lists what an org already owns.
  - Plivo/Exotel provisioning is asymmetric with Twilio's: `plivo-provisioning.ts`/
    `exotel-provisioning.ts` only expose `getStatus`/`setByoCredentials` (bring-your-own number only) —
    no platform-purchase flow like Twilio's `buyNumberForOrg` exists for either.

  **Concrete spec for when this gets built** (matches the actual ask — assign/deassign per agent,
  numbers scoped strictly to the owning org, from any source):
  1. New table `org_phone_numbers` (`id`, `org_id` FK, `provider` [twilio|plivo|exotel], `phone_number`,
     `status` [active|released], `purchased_at`) — replaces the single `orgs.outboundNumber` column,
     lets one org hold N numbers from mixed sources.
  2. New field on `org_agent_configs`: `phone_number_id` FK into `org_phone_numbers`, nullable — falls
     back to the org's first/primary active number if unset, so nothing breaks for orgs that only ever
     have one number.
  3. **Numbers page** (`/app/numbers`, new): lists every row in `org_phone_numbers` for the caller's own
     org only (never cross-org — this is the "stay for user, not for everyone" requirement), with
     source/status per row, a real "Buy a number" flow that shows the actual candidate list from
     `availablePhoneNumbers().list()` instead of auto-buying the first match, and a "Release" action
     wired to a new `releaseNumberForOrg` function (doesn't exist yet — needs Twilio's
     `incomingPhoneNumbers(sid).remove()` equivalent, and the Plivo/Exotel counterparts).
  4. **Agent page addition**: a dropdown in the agent config form (`pages/app/agents.tsx`,
     `AgentEditForm`) populated from that same org's `org_phone_numbers`, writing to the new
     `phone_number_id` field on save — this is the actual "assign this agent to that number" UI.
  5. Symmetric buy-flow for Plivo/Exotel (currently BYO-only) — lower priority than 1-4, only needed if
     a merchant wants the platform to purchase an India number for them rather than bringing their own.
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

---

## Misc — small items, batch these together rather than one-off

Small, scoped enhancements that came up in passing — each cheap on its own, deliberately not built
immediately so they can be picked up together in one pass instead of as scattered one-offs.

- [x] **Misc-1 — Real phone-number callback on the Agent Preview ("enter your number, call me").**
  Shipped 2026-07-13 (`96353e6`/`61bf6ed`). New `CallSession.resolvedConfigOverride` field
  (`voice/session-store.ts`) lets a real outbound call carry a full `ResolvedAgentConfig` — `stream.ts`'s
  real-call resolution short-circuits `resolveAgentConfig`'s DB lookup when it's set, so the test call
  reflects the exact in-progress form, not `orgAgentConfigs`. New `POST /api/app/agent-configs/
  :templateKey/test-call-phone` (merchant) + `POST /api/voice/orgs/:orgId/agent-configs/:templateKey/
  test-call-phone` (admin), both reusing `placeOutboundCall`, own 3/min rate limiter
  (`AGENT_TEST_CALL_PHONE_RATE_LIMIT`), DNC/compliance gate deliberately skipped per the judgment call
  below. UI: "call my phone" input + button in `PreviewDrawer.tsx`'s Voice tab, wired into both
  `pages/app/agents.tsx` and `pages/dashboard/agents.tsx`.
  Distinct from the existing web-based Agent Preview (`voice/test-call-stream.ts`'s `/api/voice/
  test-call` WS path — confirmed real and working 2026-07-13: no Twilio, no phone number, no
  per-minute cost, rate-limited, 19/19 backend tests pass). This is a genuinely different feature: a
  **real outbound PSTN call** to a merchant-entered number, so real telephony/STT/LLM/TTS cost applies,
  unlike the free web preview.
  - Reuse `voice/place-outbound-call.ts` + `resolveOutboundRouting` (already provider-agnostic across
    Twilio/Plivo/Exotel) — no new telephony code needed.
  - Reuse the same `configOverride` mechanism the web preview already uses, so it tests the
    in-progress form, not the saved DB row — consistent with the existing "test chat"/"test call"
    contract.
  - Needs its **own** rate limiter (`makeFixedWindowLimiter`, same pattern as `testCallRateLimited`) —
    separate from the web preview's, because this one has real COGS per call, not just abuse
    prevention.
  - Judgment call, not yet confirmed: skip the DNC/calling-window compliance gate for this flow
    specifically (merchant testing their own number, by their own immediate request — not a cold
    marketing call) — still validate E.164 format and keep it rate-limited.
  - UI: phone input + "Call me" button next to the existing Preview button in `AgentEditForm`
    (`pages/app/agents.tsx`, `pages/dashboard/agents.tsx`).

- [x] **Misc-2 — DTMF tool (keypad-tone navigation).** Shipped 2026-07-13 (`96353e6`). New `voice/dtmf.ts`
  generates real ITU-T Q.23 dual-tone mu-law 8kHz audio and plays it straight into the live media stream
  via `telephony-transport.ts`'s `buildOutboundMedia` — works uniformly across Twilio/Plivo/Exotel with
  no provider-specific DTMF API, since that seam already only speaks mu-law audio. New `sendDtmf` tool
  (signal-only, `voice/tools/sendDtmf.ts`), wired in `stream.ts`'s `logToolCall`. 5 unit tests
  (`dtmf.test.ts`).

- [x] **Misc-3 — Revenue-attribution ("₹ recovered") now shown in the merchant dashboard.**
  Backend was already real and tested (`scheduled_calls.recoveredAmount`/`recoveredOrderId`, B3
  above) — turned out `computeKpis` (`voice/org-queries.ts`) had *already computed* `kpis.recovery`
  (revenue, orders, rate) and `kpis.codConfirmation` (confirm rate) as part of `/api/app/analytics`;
  the frontend just never rendered it. Fixed 2026-07-13: `pages/app/analytics.tsx` now shows "Revenue
  recovered" (currency-formatted via `org.currency`, defaults to INR), "Carts recovered", "Cart
  recovery rate", and "COD confirm rate" stat cards — only rendered when that vertical has activity,
  matching the page's existing pattern. Zero backend changes, zero schema changes — the data was
  already there.

- [x] **Misc-4 — Live in-call SMS tool doesn't exist; SMS is post-call-only today.** Shipped 2026-07-13
  (`96353e6`). New provider-agnostic `voice/send-sms.ts` dispatcher (mirrors `place-outbound-call.ts`'s
  `resolveOutboundRouting`) + new `sendPlivoSms`/`sendExotelSms` in their respective clients (previously
  only call placement existed for either). New mid-call `sendSms` tool (signal-only,
  `voice/tools/sendSms.ts`, executed in `stream.ts`'s `logToolCall`). `workflows/engine.ts`'s post-call
  `sendSms` action now routes through the same dispatcher instead of being hardcoded to
  `getTwilioClientForOrg` — fixes the bonus-finding silent-failure bug for BYO-Plivo/Exotel orgs.

- [x] **Misc-5 — Sentiment isn't captured as structured data.** Shipped 2026-07-13 (`96353e6`).
  `calls.sentiment` column (`0021_add_call_sentiment.sql`), captured via `setDisposition`'s new optional
  `sentiment` field (positive/neutral/negative), persisted in `stream.ts`'s `finalizeCall`, surfaced on
  both admin and merchant call-detail pages next to disposition.

- [ ] **Misc-6 (watch, not a build item) — LiveKit as a future transport-layer swap.**
  `weeber-stack-decision.report`'s explicit recommendation: don't adopt LiveKit/Pipecat now (Pipecat's
  Python switch isn't worth it; LiveKit's $0.01/min agent fee is pure margin compression with nothing
  gained today) — but if/when a single Bun process handling Twilio Media Streams demonstrably can't
  keep up with call concurrency, LiveKit's self-hosted media server is a reasonable *transport-layer-
  only* swap underneath Vent's existing compliance/state/dashboard code. Revisit with real load data
  when C1 (concurrency tiers) becomes a real constraint, not before.

- [x] **Misc-7 — Hybrid pre-recorded audio for static script lines.** Shipped 2026-07-13 (`b37122c`),
  scoped down from the original ask: the greeting/closing lines turned out to be deliberately
  LLM-paraphrased from a template (`agent.ts`'s `buildIdentityBlock` — "adapt naturally, don't recite it
  robotically"), not literal text, so they aren't cacheable without a separate product decision to make
  them verbatim. Scoped instead to `stream.ts`'s `speakCannedLine` — the silence-timeout re-prompt +
  goodbye — the one spot that's genuinely byte-identical every call. New `voice/tts-cache.ts`: in-memory
  cache keyed by (resolved provider, voiceId, language, exact text) → concatenated mu-law audio; a hit
  replays as one outbound frame, skipping `connectTts` entirely. Gated behind a new
  `hybrid-audio-cache` org/global feature flag (`getEffectiveFlags`) — its first real server-side
  consumer. **Bonus fix found while wiring this:** `speakCannedLine` never actually called
  `tts.sendText` — the silence-timeout lines were logged to the transcript but never spoken out loud on
  a live call; fixed in the same change. 5 unit tests (`tts-cache.test.ts`).

- [ ] **Misc-8 — Entity-confirmation-by-repeat-back for phone/date/order numbers.** Persona prompts
  don't currently instruct the agent to read back captured entities (phone numbers, dates, order
  numbers) for the caller to confirm before proceeding — verified absent via grep across
  `voice/personas/*`/prompt-building code. This is a known STT-accuracy mitigation used across the
  competitor set: numbers are the highest-error-rate STT category (digit transposition, "fifteen" vs
  "fifty"), and a cheap prompt-level fix — "I have your number as 98765 43210, is that correct?" — cuts
  downstream errors (wrong callback number, wrong order looked up) without any infra change. Scope:
  add repeat-back instruction to the relevant persona system prompts wherever phone/date/order-number
  capture happens; no schema or backend change needed, pure prompt engineering.

- [ ] **Misc-9 — AI-to-AI synthetic call testing infrastructure.** No automated way today to test an
  agent's conversational behavior at scale — testing is manual (web preview or a real call), one call at
  a time. Verified absent: no synthetic-caller/simulation harness in the codebase. Pattern seen in
  competitor research (notably Dograh AI, an OSS Vapi/Retell alternative built around exactly this): spin
  up a second LLM-driven "caller" agent that plays a scripted persona (angry customer, confused caller,
  hangs up mid-sentence, gives wrong info on purpose) and have it call the real agent end-to-end,
  scoring transcripts against expected behavior. Valuable for regression-testing prompt/persona changes
  without a human dialing in every time, and for stress-testing edge cases that are awkward to script by
  hand. Larger lift than Misc-7/8 — needs its own call-orchestration loop (agent-calls-agent) and a
  scoring/assertion layer on top of transcripts. Flagged as a build item, not scoped in detail yet.

- **Competitor landscape note (not a build item):** two additional OSS voice-AI competitors surfaced
  during report research, both relevant to positioning against Vent/Weeber's open-core angle —
  **Rapida AI** (Go-based, OSS, on-prem-first contact-center platform) and **Dograh AI** (OSS Vapi/Retell
  alternative, notable for shipping AI-to-AI stress-testing as a first-class feature — see Misc-9 above).
  Neither changes the roadmap directly; logged here so they're on record for the next competitive pass.

- **Competitor/stack landscape note (not a build item) — GPT-Live, Voximplant, Flyboard.ai (2026-07-14).**
  Three-layer read: model layer (OpenAI GPT-Live, announced 2026-07-08 — full-duplex STT/LLM/TTS collapsed
  into one model, delegates hard reasoning to GPT-5.5 in the background), infra layer (Voximplant — CPaaS
  + serverless orchestration runtime, 315 speech/LLM connector combos, native WhatsApp Business Calling
  API, sells End-of-Turn detection + VAD as line items), and application layer (**Flyboard.ai** — closest
  competitor by thesis: Spanish, €1.9M-funded (b2venture/Kfund/Yellow + Glovo-founder angels), "recover
  cancelled subscriptions, activate leads, recover abandoned carts" — but sales-led/done-for-you/
  pay-per-outcome/EU-mid-market, no self-serve signup, no public pricing — the inverse of Weeber's
  self-serve/transparent-pricing/India+global SMB play). None of the three force an architecture change:
  - GPT-Live's API is "coming soon" (notify-form only, no pricing) — no action beyond signing up for API
    access to benchmark later. It does validate that **turn-taking/endpointing is the real competitive
    line, not vendor choice** — direct confirmation that A1b (shipped 2026-07-14, `b689d2b`) targeted the
    right thing. The existing provider-abstracted STT/LLM/TTS is exactly the right insurance policy to
    slot GPT-Live in later as a premium "conversation quality" tier without a re-architecture.
  - Voximplant is a supplier, not a rival — worth a look for two specific things next time A2's telephony
    vendor list is revisited: WhatsApp Business Calling API (Weeber already does WhatsApp fallback for
    cart recovery) and their native End-of-Turn detection as a line-item alternative to more in-house
    endpointing work. Not urgent.
  - Flyboard validates the market thesis (funded, Glovo-founder-backed) — useful ammunition for grant/
    investor conversations — but low near-term GTM/geo collision (EU mid-market sales-led vs. India/
    global SMB self-serve). Watch, don't react.
  Restates the standing moat thesis: neither the model layer nor the infra layer is defensible — the
  durable value is compliance-in-infra, vertical Shopify depth, no-code self-serve, transparent pricing.
