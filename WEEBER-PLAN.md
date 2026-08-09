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
> See `architecture/README.md` for the codebase map these file paths live in, and `docs/decisions/README.md` for
> the reasoning behind any decision referenced here.
>
> **Sharpened 2026-07-13 (same day, second pass)** against two research reports that predate this
> session's work (`voice-ai-orchestration.report`, `weeber-stack-decision.report`, both 2026-07-12) —
> folded into A1/D1/D2/D3 below with concrete targets, not just "evaluate later." One factual conflict
> resolved: `weeber-stack-decision.report` claimed no per-tenant Twilio isolation existed yet — that's
> now stale, A2 below (`twilio-provisioning.ts`) closed that gap after the report was written.
>
> **Updated 2026-07-19.** Two Phase-C items shipped since the 2026-07-13 rewrite and are now ticked
> with file refs: the **native leads/records layer (C4, Phases 1–3, ADR-061)** and **Workflow Canvas
> v4 Phase 3 (flow preview via web call — SHIPPED, `voice/workflows/preview-walker.ts`)**. A new
> prioritized **"Road ahead — prioritized (2026-07-19)"** block sits below Phase C; its Tier-1 item
> **C4b** (ingest-triggered call activation) is the highest-leverage open work.

---

## Where we actually are, in one paragraph

The core voice product works end to end — real calls, real barge-in, real tool-calling, real
multi-tenant telephony (Twilio + Plivo/Exotel), real per-org retry cadence, a real Shopify vertical
with revenue attribution, a real Workflow Canvas, real compliance scaffolding. Weeber's language
differentiator vs the horizontal builders and BiteSpeed (the direct Shopify-vertical competitor) is
**native Hinglish + genuine multilingual understanding** — an agent that *understands* a caller
code-switching mid-sentence (Deepgram `multi` / Sarvam `codemix` / ElevenLabs Scribe) while speaking
**one consistent language** per call. Phase A and Phase B are done; the STT/TTS quality foundation is
solid and live-verified (2026-07-16, see `docs/voice-quality/hindi-hinglish-voice-support.md`) and
Indic-language calls now smart-default to Sarvam automatically (2026-07-19, ADR-060). **The old "true
dynamic mid-call language *switching*" goal is now REJECTED, not deferred** — flipping the spoken TTS
voice mid-call breaks voice identity, adds latency, and destabilizes live calls; see ADR-060 and
`docs/voice-quality/language-support.md`. Phase C is
started-but-partial and not currently blocking anything — and two more Phase-C pieces shipped
2026-07-19: the **native leads/records layer** (C4, an owned data-of-record layer built *before*
external CRMs; ADR-061) and **Workflow Canvas v4 Phase 3** (flow preview via web call). The one
highest-leverage open piece is **C4b**: the leads layer ingests and stores leads but `triggerWorkflow`
is deliberately accepted-but-not-dialing until it's wired through the DNC/TCPA/quiet-hours dial-gates —
closing that "lead lands → agent router → call fires" loop is the top item in the road-ahead block
below. Phase D is correctly untouched, though D1
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
  (`platform` | own sub-account). See ADR-048/ADR-049 in `docs/decisions/`.
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
- [x]/[ ] **B2 — Multilingual understanding (one fixed spoken language per call).** **Reframed
  2026-07-19 per ADR-060. The STT/TTS foundation is solid, live-verified, and now smart-routes
  Indic-language calls to Sarvam automatically (ADR-060). Dynamic *mid-call spoken-language
  switching* (old B2.3/B2.4) is REJECTED — not deferred — because flipping the TTS voice mid-call
  breaks voice identity, adds latency, and destabilizes the call. STT code-switching *understanding*
  (caller mixes Hindi/English in one sentence) is separate and stays. B2.5 (localized system
  messages) is still a valid open item.** Full research + live-verification
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
  `elevenlabs` too) AND, as of ADR-060 (2026-07-19), Indic-language calls now smart-default to
  Sarvam automatically when no provider is explicitly chosen and `SARVAM_API_KEY` is present
  (explicit operator choice always wins; smart default beats the env default but never an explicit
  override; `en`/`multi` untouched). This closes the old "operator must pick the right provider
  manually" gap for Indic languages. Today `language` is one fixed field per call — by design.
  Mid-call *spoken-language switching* is not a deferred item; it's REJECTED per ADR-060.

  **B2 breakdown (revised scope, smaller than Bolna's full per-language-prompt-tab architecture,
  because Sarvam's Saaras model — and, as of 2026-07-16, ElevenLabs Scribe too — already handles
  code-mixed Hindi/English in one model — you don't need Bolna's hard vendor-per-language split
  unless you want non-Sarvam/non-ElevenLabs options for Hindi too):**
  - [x] **B2.1 (revised, valid)** — One shared multilingual system-prompt instruction: respond
    naturally in the call's language and handle Hinglish/code-mixed input. Implemented via
    `buildLanguageInstructionBlock` (added 2026-07-12, see
    `docs/voice-quality/voice-quality-and-india-status-2026-07-12.md`), which instructs the LLM to
    *stay* in whichever language it opened with. Per ADR-060 this "stay in one spoken language" is
    the deliberate design, not a stopgap — it's the correct behavior, since mid-call voice switching
    is rejected. The multilingual-*understanding* half (handle mixed input) is the valid part of the
    original B2.1 and is covered by the STT layer (B2.2).
  - [x] **B2.2 (revised)** — STT now correctly handles code-mixed Hindi/English for the Indic call
    path, but via a **provider choice, not a Sarvam-only mode flag** as originally scoped: either
    Sarvam STT in `mode: "codemix"` (`voice/stt/sarvam.ts`, live-verified 2026-07-16) or the new
    ElevenLabs Scribe v2 Realtime adapter (`voice/stt/elevenlabs.ts`, also live-verified, currently
    the recommended default per the agents-tab UI). Still per-agent-config, not per-org/per-vertical
    auto-flagged as B2.2 originally described — an operator picks the STT provider explicitly.
  - [~] **B2.3 — REJECTED (ADR-060).** Per-detected-language TTS voice lookup table that flips the
    active voice mid-call. Rejected: swapping the TTS voice mid-call breaks the agent's voice
    identity (caller hears a different person), adds latency at the switch point, and destabilizes
    the call. One fixed spoken language per call instead. STT understanding of code-mixed speech is
    unaffected and stays.
  - [~] **B2.4 — REJECTED (ADR-060).** Switch-debounce (N turns / confidence threshold before
    flipping the active TTS voice). Moot — there is no mid-call voice flip, so nothing to debounce.
  - [ ] **B2.5** — Localize the handful of system messages (silence prompt, hangup line, tool-wait
    filler) per supported language. Not built.
- [x]/[ ] **B3 — Post-call analytics + revenue attribution + compliance layer.** *(Mixed — see below.)*
  - [x] Revenue attribution: `scheduled_calls.recoveredOrderId`/`recoveredAmount`, order value
    attributed to the executed cart-recovery call within a 7-day window (tested).
  - [x] Analytics pages exist: `pages/app/analytics.tsx`, `pages/dashboard/{analytics,
    revenue-analytics,marketing-analytics}.tsx`.
  - [x] Consent/TCPA/DNC/calling-window compliance gate is real and enforced on every outbound call
    (`packages/weeber-compliance`, `voice/compliance/adapters.ts`).
  - [ ] Per-org DNC (see Phase C, item **P** below — DNC is still global).
  - [ ] India DPDP/TRAI compliance findings — code exists (`calling-window.ts` has IST-window logic)
    but whether this was ever explicitly confirmed *closed* with you is unclear from the docs — treat
    as open until confirmed, not code work.

**Phase B: mostly done. B2 is now scoped correctly (ADR-060): STT/TTS quality for Hindi/Hinglish is
solid and live-verified (see `docs/voice-quality/hindi-hinglish-voice-support.md`), Indic calls
smart-default to Sarvam (ADR-060, see `docs/voice-quality/language-support.md`), multilingual
*understanding* is shipped, and mid-call spoken-language *switching* (old B2.3/B2.4) is REJECTED —
not a gap. Only open B2 item is B2.5 (localized system messages), a small polish task, not a
differentiator.**

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
- [ ] **C3e — WhatsApp.** Not built in the backend. `docs/agent-prompts/01-cart-recovery-agent.md`
  explicitly says "do not promise WhatsApp... it isn't built yet" — this is a known, documented gap,
  not an oversight. Marketing pages list it as roadmap-only. **When built, it should mirror the SMS
  3-surface pattern** (see C5) — a `whatsapp` canvas node, a mid-call `sendWhatsApp` tool, and a
  post-call action — not a one-off. Tracked under C5 now.

- [x] **C4 — Native, person-centric leads/records layer (Phases 1–3, shipped 2026-07-19).** The
  *owned* data-of-record layer, built before bolting on external CRMs (ADR-061; plan
  `docs/product-strategy/native-leads-layer-plan-2026-07-19.md`).
  - **Phase 1 (owned core):** `leads` table deduped by `(orgId, phone)`, `calls.leadId` plain indexed
    int (no FK), migration `0040_mushy_arclight.sql`; captured fields promoted `capturedState →
    leads.fields` at `finalizeCall`; insurance Leads page (list/search, detail + call history,
    pipeline status, assign advisor, call-now, Excel export, manual add/edit).
  - **Phase 2 (edges & config):** `POST /api/leads/ingest` (`voice/leads/ingest.ts` — per-org `wlk_`
    key auth, `validateFields` schema-checked, regulated keys rejected, idempotent `upsertLead`) +
    per-org/per-agent intake-schema editor.
  - **Phase 3 (reach):** public hosted form `/f/:orgId` (`pages/hosted-form.tsx` — `orgId` is the
    non-secret write-only form token, honeypot + per-(ip,org) rate limit) + on-demand "Sync to CRM"
    mirror (HubSpot/Salesforce/GHL; `leads` stays source of truth).
  - Verified: typecheck clean · **621 tests pass / 0 fail** · lint 0/0 · build clean.
- [ ] **C4b — Ingest-triggered call activation (the "AGENT ROUTER → CALL FIRES" gap). Tier-1, highest
  leverage.** `triggerWorkflow` is *accepted but not wired* in `voice/leads/ingest.ts` — it returns a
  `note` ("not yet supported") on purpose, because auto-dial must first pass the compliance dial-gates.
  Close the loop: **lead lands via ingest/form → agent router picks the right agent → outbound call
  fires**, routed through the existing DNC / TCPA-TRAI quiet-hours / calling-window dial-gates (reuse
  `voice/scheduler.ts` + `voice/place-outbound-call.ts`, do **not** build a parallel dialer). This is
  the single highest-leverage open item — it turns the shipped leads layer into an end-to-end
  autonomous outbound loop.
  - **Open product decision (CLAUDE.md gate #4 — ask before building the router UI):** the
    entry-condition routing (which agent, under what conditions) is config-driven vs.
    visual-canvas-from-day-one — the same unresolved "trigger split" question as item **S**. The dial
    execution reuses existing gated infra either way; only the *routing config surface* is the open call.
- [ ] **C5 — Multi-channel reach (WhatsApp + email as first-class flow steps).** SMS is already real
  and provider-agnostic (Twilio/Plivo/Exotel) across all three surfaces — `sms` canvas node
  (`voice/workflows/graph-engine.ts`), mid-call `sendSms` tool (`voice/tools/sendSms.ts`), post-call
  action (`voice/workflows/engine.ts`), all backed by `voice/send-sms.ts` (`sendSmsForOrg`). C5 mirrors
  that pattern to the other channels:
  - **WhatsApp** (this subsumes C3e): a `whatsapp` canvas node + mid-call `sendWhatsApp` tool +
    post-call action, provider-agnostic like SMS.
  - **Email flow node:** transactional email already exists (`app/email.ts` `sendTransactionalEmail`
    via Resend) but is **not** a workflow node — expose it as a canvas node/action so flows can send
    email, not just system transactional mail.
  - **Cross-channel fallback chains:** call → SMS → WhatsApp → email escalation, via `Wait` +
    status-branch nodes keyed on delivery/read-status webhooks.
- [ ] **C6 — External integrations layer (inbound adapters + connector layer).** Per
  `docs/product-strategy/integrations-strategy-and-roadmap-2026-07-19.md`: Pipedream on the *inbound*
  edge (any CRM/form → our `/api/leads/ingest`), native adapters for *outbound* mirror (C3c is the
  outbound half, already partly done).
  - **Pipedrive native inbound adapter** — flagged as the next likely native inbound adapter (interim
    path already works: Pipedream → `/ingest`).
  - **Activate per-org `wlk_` ingest keys** into a first real external source when a pilot needs it
    (keys exist and are validated; just not yet pointed at a live external feed).
  - **Vertical flow templates** (clinic/hotel/restaurant) to seed C4b routing once those verticals
    are built out.

### Folded in from the old plan — still-open cross-cutting items

- [ ] **F — `WEEBER_INTERNAL_SECRET`/`WEEBER_CALLBACK_SECRET` match in both repos.** Status not
  re-verified this session — confirm before assuming it's fine.
- [ ] **G — Real end-to-end test against a live Shopify dev-store checkout.** Needs a real manual
  run; can't be verified from a sandbox, no amount of code review substitutes for this.
- [ ] **I — India DND/TRAI compliance confirmation.** Same as B3's compliance note above — code
  exists, explicit confirmation-with-you status unclear.
- [ ] **P — Per-org DNC lists.** `do_not_call` table has no `orgId` column — one global list across
  every tenant. **Touches `packages/weeber-compliance` — confirm with the user before changing
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
webhooks, and now the native leads layer C4). Genuinely open pieces are C1, C2b, C4b, C5, C6, P, Q, R,
S. None of these block a pilot merchant or an investor demo today — but C4b is the one that converts
the shipped leads layer into an end-to-end autonomous outbound loop, so it leads the road ahead below.**

---

## Road ahead — prioritized (2026-07-19)

Verified against the codebase this session, not aspirational. Tiers are by leverage, not effort.

- **Tier 1 — activate the loop we already 90% built.**
  - **C4b — ingest-triggered call activation.** Wire `triggerWorkflow` (accepted-but-not-dialing in
    `voice/leads/ingest.ts`) → agent router → outbound call through the existing DNC/TCPA/quiet-hours
    dial-gates (reuse `scheduler.ts` + `place-outbound-call.ts`). The leads layer (C4) is shipped up
    to the exact point the call would fire; this is the missing "agent router → call fires" step and
    the single highest-leverage item on the board. *Gated: routing-config-vs-canvas is an open product
    decision (gate #4) — ask before building the router UI; dial execution reuses gated infra either way.*
- **Tier 2 — multi-channel reach.**
  - **C5** — WhatsApp node/tool/action mirroring the existing SMS 3-surface pattern (subsumes C3e);
    expose transactional email (`app/email.ts`) as a flow node; cross-channel fallback chains
    (Wait + delivery/read-status branch).
- **Tier 3 — integrations & templates.**
  - **C6** — Pipedrive native inbound adapter + Pipedream connector layer; activate per-org `wlk_`
    keys for a first external source; vertical flow templates (clinic/hotel/restaurant) once built.
- **Tier 4 — carried forward (decided/known, just not built).**
  - Supabase Realtime dashboard (`ADR-058`, decided not built — still polls every 4–5s);
    set `SENTRY_DSN` on Railway (wired, no-op until env var set); **A1b** VAD/endpointing audit;
    **B2.5** localized system messages (mid-call language *switching* stays REJECTED per ADR-060).
- **Opportunistic / cheap anytime:** **D1** Kokoro TTS pilot, **D4** join NVIDIA Inception (free, no
  equity, unlocks Nebius/AWS credit programs).

Not on the road ahead by design: Phase D2/D3 (stay parked until volume/revenue demands them);
mid-call spoken-language switching (REJECTED, ADR-060); per-org DNC / entry-condition branching config
changes without a gate #4/#6 sign-off.

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
  sourced): Weeber's own runtime blends to **~$0.048/min** (Twilio + Deepgram + gpt-4o-mini/Gemini
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

- ~~**`VerticalDefinition.dashboard.metrics`/`cards`/`emptyState`**~~ — **resolved 2026-07-18**:
  turned out `home.tsx` DID already read `dashboard.metrics`/`emptyState` (the "dead config" claim
  here was itself stale) but two insurance metric keys were wired to the wrong data — real bug,
  not dead config. `renewals_confirmed` read `data.kpis.recovery` and `leads_qualified` read
  `data.kpis.codConfirmation`, both Shopify-only KPI blocks — an insurance org's dashboard showed
  real Shopify cart-recovery/COD numbers mislabeled as insurance metrics. Fixed: `computeKpis()`
  now computes real `insuranceRenewal`/`insuranceLeadFollowup` blocks (attribution via
  `calls.agentPersona` value-match, same no-FK pattern as `codConfirmation`). Verified live against
  a local DB + 2 real Supabase test users, not just typecheck — see `changelog/2026-07.md`.
- **Staging Supabase project has a placeholder `DATABASE_URL` on Railway.** Not re-verified this
  session — flag as unconfirmed, not assumed fixed.
- **Theme portal-scoping, agent full-window layout, 2 Dependabot vulns** — all fixed 2026-07-13, see
  `audit/2026-07-13-audit-04-uiux.md` and the `docs/changelog/` entries for that date. Listed here only so
  this file doesn't look like it's ignoring them; they're closed, not open.

---

## Personas / prompt copy — status

All 5 personas are written, not placeholders: `docs/agent-prompts/01-cart-recovery-agent.md`,
`02-cod-confirmation-agent.md`, `03-feedback-agent.md` (drafted fresh, no reference sample —
**confirmed final by the user 2026-07-18**, gate closed; `seed.ts`'s `active` flag flipped
`false → true` so it's now selectable by merchants and eligible for AI-draft, same as 01/02),
`04-insurance-policy-renewal-agent.md`, `05-insurance-lead-followup-agent.md`. The feedback agent
(03) deliberately reuses the generic `captureField` tool rather than a dedicated feedback tool — no
new tool was needed for that persona.

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
