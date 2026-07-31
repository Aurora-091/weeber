---
doc: five-bets-build-plan
status: PLAN — approve direction before code
created: 2026-07-31
author: CTO/architect pass (grounded against HEAD 8f4da00)
---

# Weeber — Five Platform Bets: Grounded Build/Fix/Test Plan

This plan is written against the **actual codebase**, not the research summary. Every "current
state" line below was verified by reading the source at HEAD `8f4da00`. Where the research and the
code disagree, the code wins.

---

## 0. Read this first — the recalibration

The Reddit/report research concluded 5 bets. Grounding them against the repo, **three are already
largely built.** You are not building five features from scratch:

- **2 genuinely-new builds:** semantic turn-detection model (Bet 1), backchannels (Bet 2 remainder).
- **1 promotion:** guardrail events → first-class persisted table (Bet 3 remainder).
- **2 thin layers** on mature subsystems: synthetic scenario expansion (Bet 4), call-health
  detection/alerting (Bet 5).

### What already exists (do NOT rebuild)

- **Compliance dashboard** — `packages/web/src/web/pages/dashboard/compliance.tsx` (455 lines):
  DNC list, consent records + per-principal search + CSV export, blocked-calls table by reason,
  guardrail-event counts by org, undispositioned-calls list. Public compliance pages under
  `packages/web/src/web/pages/compliance/` (global/india/index). Backend endpoints live:
  `/api/voice/compliance/overview`, `/blocked-calls`, `/consent/summary`, `/consent`.
- **Consent + opt-out storage** — `consent_records` (purpose/version/channel/withdrawal),
  `opt_out_events` (append-only call-time facts, ADR-062 added **2026-07-30**), `do_not_call`,
  `calls.disclosureText` / `disclosureVersion` / `disclosureFiredAt`.
- **Pre-tool fillers** — `agent.ts` `withFillerTimer` + `TOOL_CALL_FILLER_THRESHOLD_MS` (400ms),
  `stream.ts` cached warm filler audio, one-per-turn, forwarded to Twilio.
- **Turn-detection heuristic** — `stream.ts` `endsMidThought()` / `TRAILING_FILLER_PATTERN`
  (holds turn open on trailing conjunction/filler) layered on Deepgram `speech_final`.
- **Synthetic-test harness** — `synthetic-test.ts` (AI-to-AI, deterministic keyword/tool
  assertions) + `synthetic-scenarios.ts` (3 scenarios).
- **Call telemetry** — `calls` table carries `sttReconnectCount`, `providerFailoverCount`,
  `sttProviderUsed`/`ttsProviderUsed`/`llmProviderUsed`, `estimatedCostUsdCents`, `sentiment`,
  `intent`, `disposition`; plus `callLatency` (incl. dead-air-before-first-word), `turnLatency`
  (per-turn P50/P90), `twilioStatusEvents`, `product_events`.

### What is genuinely missing (the real backlog)

1. **Learned semantic end-of-turn** — current EOT is silence + regex. No model.
2. **Backchannels** — mid-listen acknowledgments ("mm-hm", "right"). Fillers only cover
   post-tool-call latency, not the caller-is-talking window.
3. **Guardrail events as data** — they are *inferred* by scanning `tool_calls` for
   `flagGuardrailEvent` / `guardrail-heuristic-detector`. No dedicated queryable table, so no
   per-event detail, no trend, no exportable compliance artifact.
4. **Scenario coverage** — only 3 generic scenarios; nothing insurance/boundary/compliance-specific;
   no voice-level (STT/TTS timing) variant.
5. **Silent-failure detection** — telemetry is captured but nothing *reads* it to flag a call that
   connected-but-died (no first word, dead air, disclosure never fired, one-sided transcript).

### One-line truth

You have a mature, observable, compliance-aware voice platform. The gap vs. Vapi/Retell is **not**
missing features — it is (a) turn-naturalness on the hot path and (b) turning already-captured
compliance + health data into *visible, provable* product surfaces. Bets 3 and 5 are your wedge;
Bets 1 and 2 are table-stakes UX.

---

## 1. Sequencing — and why it differs from the research ranking

Order by **(differentiation × pilot-readiness) ÷ risk**, not by the research's UX-impact ranking.

| Phase | Bet | Why here | Risk | Touches audio hot path? |
|---|---|---|---|---|
| **I** | Bet 3 — guardrail events table | Low risk, high differentiation, feeds the compliance wedge, pure additive schema+read | Low | No |
| **II** | Bet 5 — silent-failure detection | Reads existing telemetry, no hot-path change, makes every later change *measurable* | Low | No |
| **III** | Bet 4 — scenario expansion | Cheap safety net; must exist **before** touching turn-detection so regressions are catchable | Low | No |
| **IV** | Bet 2 — backchannels | Real perceived-latency win (esp. elderly final-expense callers); contained to behavior layer | Med | Yes (behavior only) |
| **V** | Bet 1 — semantic turn-detection | Biggest UX win **but** riskiest: hot path, added latency + infra dependency; needs II+III to prove it helped | High | Yes (core) |

**The key inversion:** research put turn-detection first. It goes **last**. You cannot responsibly
swap the EOT model on the live audio path until you have (II) a way to detect regressions in
production and (III) a scenario harness to catch them pre-merge. Ship the low-risk wedge-builders
first, earn the measurement layer, *then* touch the hot path.

**Recommended first lever: Phase I (guardrail events table).** Smallest, safest, highest
differentiation-per-hour, and it is the missing 10% of an otherwise-complete compliance surface.

---

## Phase I — Guardrail events as first-class data (Bet 3 remainder)

**Current state.** `flagGuardrailEvent` (`tools/flagGuardrailEvent.ts`) and the
`guardrail-heuristic-detector` in `stream.ts` both write into the generic `tool_calls` log.
`org-queries.ts` (~line 520) reconstructs counts by string-matching `toolName`. No per-event row,
no category detail persisted, no trend, no export.

**The gap.** Compliance value is in the *evidence*, not the count. "We held the boundary 240 times
this month" needs a row per event with category, call link, timestamp, and the triggering phrase —
the same shape `opt_out_events` already set the precedent for yesterday (ADR-062).

**The change.**
- New table `guardrail_events` in `schema.ts` (mirror `opt_out_events` shape):
  `id`, `callId` (fk → calls, cascade), `orgId`, `category`
  (enum: matches `flagGuardrailEvent`'s 4 categories), `source`
  (`agent-self-report` | `heuristic-detector`), `detail` (text, the phrase/notes), `firedAt`.
  Indexes on `(callId)` and `(orgId, firedAt)`.
- Write path: at the two existing call sites (`flagGuardrailEvent.execute` result handling in
  `stream.ts` ~line 1244 and the agent self-report hook) insert a row, **best-effort/fire-and-forget**
  (swallow DB errors, never block the call — same pattern as `product_events` `recordEvents`).
- Read path: extend `/api/voice/compliance/overview` (or add
  `/api/voice/compliance/guardrail-events`) to return recent events + counts from the table instead
  of scanning `tool_calls`. Keep the `tool_calls` scan as a fallback for pre-migration calls.
- Dashboard: add a "Guardrail events" panel to `compliance.tsx` (list + CSV export — the
  `downloadCsv` helper already exists in that file).

**Files touched.** `packages/api/src/database/schema.ts`,
`packages/api/src/voice/stream.ts`, `packages/api/src/voice/tools/flagGuardrailEvent.ts` (or its
caller), `packages/api/src/voice/org-queries.ts`, `packages/api/src/voice/routes.ts`,
`packages/web/src/web/pages/dashboard/compliance.tsx`.

**Migration.** `db:generate` → offline diff only. **Do not `db:migrate`/`db:push`** (shared DB) —
hand the generated SQL to Rushikesh to apply, same as `0044`.

**Test plan.**
- Unit: `guardrail_events` insert shape; category enum rejects unknown values; read endpoint
  aggregates by org/category; CSV row escaping.
- Synthetic: a scenario that forces a boundary hold (e.g. caller demands a quote / asks the AI to
  confirm it's licensed) → assert `flagGuardrailEvent` called → assert a row lands.
- Verify: `bun run typecheck` (api+web), `bun run build` (web),
  `bunx oxlint packages/api packages/web --deny-warnings`, `bun test --isolate src/voice/`.

---

## Phase II — Silent-failure / call-health detection (Bet 5)

**Current state.** Rich telemetry captured per call (`sttReconnectCount`, `providerFailoverCount`,
`callLatency` incl. first-word dead air, `turnLatency`, `disclosureFiredAt`, `twilioStatusEvents`,
transcript rows). Nothing reads it to *classify* a call as failed. A call that connected, billed
seconds, and produced zero agent audio currently looks identical to a healthy short call.

**The gap.** No definition of, or detector for, a "silent failure." These are the calls that make a
pilot merchant churn silently — they never complain, they just stop trusting it.

**The change.** A pure classifier `voice/call-health.ts` — `classifyCallHealth(call, latency,
turns, transcript)` → `{ status: "healthy" | "degraded" | "silent-failure", reasons: string[] }`.
Deterministic rules over already-persisted fields, e.g.:
- `silent-failure`: finalized call with **no agent transcript turn**, OR `disclosureFiredAt` null on
  a connected outbound call, OR first-word dead air > threshold, OR `providerFailoverCount` > N.
- `degraded`: any failover > 0, `sttReconnectCount` high, P90 turn latency over budget, one-sided
  transcript (caller spoke, agent silent for ≥X turns).
Run it at `finalizeCall` (stamp a `healthStatus` + `healthReasons` on the call row — additive
columns) and expose a read for an admin "Call health" panel. Optional: fire an alert (reuse the
Sentry wiring already in the repo) on `silent-failure`.

**Files touched.** `packages/api/src/voice/call-health.ts` (new),
`packages/api/src/database/schema.ts` (2 additive nullable columns on `calls`),
`packages/api/src/voice/stream.ts` (call classifier at finalize),
`packages/api/src/voice/routes.ts` + a small admin read view (extend `dashboard/calls-list.tsx` or
`analytics.tsx`).

**Migration.** `db:generate` offline only; hand SQL to user.

**Test plan.**
- Unit (this is mostly pure, easy to cover well): table-driven cases — healthy call, no-agent-turn,
  disclosure-never-fired, failover-masked, one-sided transcript, latency-over-budget → each maps to
  the expected status + reasons.
- Verify: same 4 commands as Phase I.

**Why before Bet 1:** this is the instrument you use to prove the turn-detection swap in Phase V
actually improved calls rather than quietly regressing them.

---

## Phase III — Synthetic scenario expansion (Bet 4)

**Current state.** `synthetic-test.ts` is a complete AI-to-AI text harness with deterministic
assertions. `synthetic-scenarios.ts` has **3** scenarios: `angry-customer`, `confused-caller`,
`wrong-info`. The file itself flags a voice-level variant as unscoped.

**The gap.** Zero coverage of the insurance boundary rules and compliance behaviors that are the
platform's actual liability surface. These are exactly the regressions a persona/prompt edit will
silently introduce.

**The change (scope: text harness only — do NOT build the voice-level pipeline yet).** Add
scenarios to `synthetic-scenarios.ts`, no engine changes needed:
- **Boundary-hold scenarios** (assert `agentNeverSaid` licensed/quote/carrier-name; assert
  `toolCalled: flagGuardrailEvent`): caller asks "are you a licensed agent?", "just give me a
  price", "which carrier is cheapest?", "what's my premium?".
- **Regulated-field refusal** (assert `agentNeverSaid` re: SSN/DOB/banking; assert the agent does
  not capture them): caller volunteers SSN/bank details.
- **Opt-out / DNC** (assert opt-out intent captured): caller says "take me off your list".
- **Warm-transfer handoff** (assert `toolCalled: transferToHuman` at the right step): caller reaches
  the carrier-selection boundary.
- **Disclosure** (assert `agentSaid` disclosure phrase in the greeting turn).

**Files touched.** `packages/api/src/voice/synthetic-scenarios.ts` only (+ a small
`synthetic-test.test.ts` addition if you assert new assertion types).

**Explicitly NOT in scope.** The voice-level (real STT/TTS timing + barge-in) synthetic pipeline.
It is the largest lift for the least near-term pilot value — the text harness catches
prompt/persona/tool regressions, which is what actually breaks. Defer until a pilot is live and a
real voice regression is observed.

**Test plan / verify.** The scenarios *are* the tests. Run `bun test --isolate
src/voice/synthetic-test.test.ts` + the 4 standard commands. Note: scenarios hit a live LLM
(`gpt-5.4-mini`) — keep them out of the default fast unit run; gate behind an explicit script so CI
cost is controlled.

---

## Phase IV — Backchannels (Bet 2 remainder)

**Current state.** Pre-tool fillers only. They cover the *agent-is-working* window (tool call
running past 400ms). Nothing covers the *caller-is-talking* window — the agent is silent while the
caller speaks a long sentence, which reads as "is it still there?" to older callers.

**The gap.** Backchannels — short, low-latency acknowledgments ("mm-hm", "right", "okay") played
sparingly while the caller is mid-utterance, on partial STT results.

**The change.**
- Reuse the existing warm-cache mechanism (`warmFillerCache` in `stream.ts`) for a small set of
  backchannel clips so they play with near-zero latency.
- Trigger on Deepgram **interim** results (not `speech_final`) after the caller has been talking
  past a threshold, rate-limited hard (at most one per N seconds, never overlapping the caller's
  stress syllables, never during the agent's own turn).
- Config-gated per agent (default OFF; enable for final-expense/elderly personas first). Must not
  interfere with barge-in or `endsMidThought`.

**Files touched.** `packages/api/src/voice/stream.ts` (interim-result hook + backchannel player),
`packages/api/src/voice/agent.ts` (backchannel line set + config flag),
`packages/api/src/database/schema.ts` (agent config flag if persisted).

**Risk note.** This *does* touch the audio path. Bad backchannels are worse than none (talking over
the caller). Ship behind a flag, test on the synthetic harness first (assert no backchannel token
appears where the caller hasn't paused), then a controlled live test with explicit go-ahead.

**Test plan.**
- Unit: backchannel decision function (pure) — fires only after threshold, respects rate limit,
  never during agent turn, never on `speech_final`.
- Synthetic: run existing scenarios with backchannels ON, assert transcript/assertions unchanged
  (backchannels don't corrupt turn-taking).
- Verify: 4 standard commands. **Live audio test only with explicit go-ahead.**

---

## Phase V — Semantic turn-detection (Bet 1)

**Current state.** Deepgram `speech_final` (fixed silence timeout) + `endsMidThought()` regex
context. Works, but silence-based endpointing either cuts callers off mid-thought or waits too long.

**The gap.** A learned end-of-turn model that decides "did the caller finish?" from semantics, not
just silence. Candidates from research: Smart Turn v3 (open-source, pipecat), OpenAI Realtime
semantic VAD, LiveKit transformer EOT, Speechmatics SLM.

**The change.** Introduce a pluggable EOT decision behind an interface, so it can sit *alongside*
the existing regex heuristic (belt-and-suspenders), not rip it out. `endsMidThought` stays as the
cheap first pass; the model refines the ambiguous cases. Feature-flag per agent, default OFF.

**Why last / the honest risk ledger.**
- **Hot path.** This is the single most latency-sensitive line in the product. A model call in the
  EOT loop adds round-trip latency that can *erase* the naturalness it buys.
- **Infra dependency.** Self-hosted (Smart Turn) = you now run a model server. Hosted (OpenAI
  Realtime) = new vendor lock + cost per minute on the hottest path.
- **Commoditizing treadmill.** This is exactly the Vapi/Retell benchmark war the strategy says NOT
  to chase for its own sake. Do it because calls are measurably getting cut off (Phase II data will
  tell you), not because a benchmark says 600ms.
- **Unmeasurable without II + III.** You cannot merge a hot-path change responsibly without the
  health detector (II) and the scenario harness (III) in place.

**Decision gate before starting Phase V.** Only start if Phase II health data shows a real
turn-taking problem (mid-thought cut-offs / excessive end-of-turn wait) on actual calls. If the data
doesn't show it, **do not build this** — spend the time on vertical depth instead.

**Files touched (when approved).** `packages/api/src/voice/stream.ts`, a new
`packages/api/src/voice/turn-detection/` module (interface + adapters), `agent.ts` (config flag),
`schema.ts` (flag).

**Test plan.**
- Unit: EOT decision adapter with mocked model responses; regex-first fallback path; latency budget
  guard (bail to silence-timeout if model is slow).
- Synthetic: a scenario battery of mid-thought pauses and trailing conjunctions → assert the agent
  waits vs. responds correctly.
- Live: A/B against Phase II health metrics (first-word timing, cut-off rate) — **explicit go-ahead
  required**, and only after a staging isolation story exists (staging+prod currently share
  `DATABASE_URL`).

---

## Cross-cutting rules (all phases)

- **Migrations:** `db:generate` (offline diff) is fine. **Never** `db:migrate` / `db:push` — shared
  staging+prod DB. Hand generated SQL to Rushikesh.
- **No live server boot / no write-path or call/email tests** without explicit go-ahead.
- **Every phase ends green:** `bun run typecheck` (api+web), `bun run build` (web),
  `bunx oxlint packages/api packages/web --deny-warnings`, `bun test --isolate src/...`.
- **Best-effort writes** (guardrail events, health status) swallow DB errors and never block a call
  — the `product_events` / `opt_out_events` precedent.
- **Focused commits**, exclude `audit/` scratch. Update `docs/changelog/2026-07.md` (newest-at-top)
  and `docs/brain/active-context.md` each session.
- **Tier-1 Peterson fixes** (transfer-fallback/advisor-presence, lead-state-at-intake gate, handoff
  payload) overlap Phases I/IV — fold them in where they touch the same files rather than as a
  separate track.

---

## The one decision I need from you

**Confirm the sequencing inversion:** research said turn-detection first; I'm recommending it
**last** (Phase V), gated on Phase II data, and starting with **Phase I (guardrail events table)** —
smallest, safest, highest differentiation-per-hour.

If you agree, I start Phase I. If you'd rather I start with Phase II (health detection) or still
want turn-detection first, say so and I'll re-order.
