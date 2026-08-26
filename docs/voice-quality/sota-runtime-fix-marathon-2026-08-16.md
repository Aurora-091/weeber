# The SOTA-runtime fix marathon

**Date:** 2026-08-16 (Phase 0 items 0.1-0.4 and 0.6 shipped same day; 0.5 deliberately left open — see its entry)
**Status:** IN PROGRESS. It is a prioritized punch list, not an ADR — items get marked DONE in place as they ship.
**Purpose:** Turn the architecture roadmap in `docs/audits/2026-08-16-manus-weeber-vs-sota-voice-architecture.md`
(Phases 0–4) into concrete, file-level work items, cross-referenced against the two production audits it
was itself grounded in (`docs/audits/2026-08-10-audit-13-voice-pipeline-latency.md`,
`docs/audits/2026-08-14-audit-17-the-agent-narrates-tools-it-does-not-have.md` + its two addenda), and checked
against what commit `1f06ebb` and ADR-115 already shipped on 2026-08-15 so this doesn't re-litigate solved
problems.

**How to read this doc:** each item has a **Status** (`DONE`, `OPEN`), a **Source** (which audit/finding it
traces back to), **Where** (files to touch), **What**, and **Risk**. Items are grouped into the same five
phases the architecture assessment used, but re-ordered within each phase by what production evidence
says is actually costing the most right now — not by what's architecturally cleanest. Update this doc in
place as items land; when a phase is fully done, note it in `docs/brain/active-context.md` and
`docs/brain/progress.md` the way `1f06ebb`/ADR-115 already did.

---

## Already shipped — do not re-do

| Item | Where | Source |
|---|---|---|
| Greeting fast-path root cause (phone numbers not E.164-normalized on 3 of 4 lead-creation paths) | `leads.ts`, `ingest.ts`, `public-routes.ts` | audit-13 lever #1 (P0, ~1485ms/call) — fixed in `1f06ebb` |
| Barge-in fired on any non-empty interim result, no confidence/length/streak gate | `voice/barge-in.ts` (new), `stream.ts`, `test-call-stream.ts` | pilot audit — fixed in `1f06ebb` |
| No per-tool timeout on 5 network-bound tools; a slow CRM/Calendar/Shopify call could eat the whole turn budget | `agent.ts` (`withToolTimeout`) | audit-13 lever #5 (tool prefill/latency family) — fixed in `1f06ebb` |
| Transfer capability gate stripped the tool but not the promise — model still scripted a hand-off it couldn't perform | `stream.ts`, `handoff.ts`, call-control prompt composition | audit-17 F1 (P0) — fixed via ADR-115 |
| Migration 0050 (`org_agent_configs.human_transfer_number`) applied to production | — | audit-17 F9 — resolved 2026-08-15 |

Everything below is confirmed still open as of this doc's date — verified by reading the current source,
not assumed from the audits' original dates.

---

## Phase 0 — Make production truth measurable

Blocking prerequisite for every other phase. Three separate audits (13, 17, and 17's own addenda) each
independently concluded that a latency or correctness claim couldn't be trusted because the instrumentation
lying underneath it was wrong. Do this first or every later "we cut N ms" / "provider X is faster" claim in
this doc is unfalsifiable, same as the audits found.

### 0.1 — `calls.llm_provider_used` records config, not what actually served the turn — **DONE (2026-08-16)**
- **Source:** audit-17 Addendum 2 (the finding that invalidated its own earlier Correction 1 and the
  original section 5 groq-vs-gateway comparison). Confirmed still true by reading `stream.ts:869`:
  `llmProviderUsed: llmProviderOverride ?? null` — still the configured value, no equivalent of
  `activeTtsProvider`'s "what actually ran" fallback.
- **Where:** `packages/api/src/voice/stream.ts` (~line 861-870), wherever the LLM call is actually dispatched
  (`agent.ts`/`llm/index.ts`).
- **What:** add an `activeLlmProvider`/`activeLlmModel` field that's set from the transport that actually
  served the request (mirroring `activeTtsProvider ?? ttsProviderOverride`), not from config. Also increment
  a failover counter on LLM transport switches — `recordProviderFailover()` currently has exactly two call
  sites (`stream.ts:1579` TTS, `:2167` STT); add the LLM path so `provider_failover_count` isn't silently
  blind to the transport that matters most to tool-driven conversations.
- **Risk:** low — additive instrumentation, no behavior change.
- **Blocks:** 0.3, 1.1 (Groq-vs-gateway can't be re-tested honestly without this), 2.1/2.2 (can't attribute a
  tool-syntax leak to a route without it).
- **Shipped as:** `turnLatency.llmProviderUsed` (new column, migration `0051_sharp_starbolt.sql`) records
  `formatActiveModelLabel(activeLink)` per turn via a `turnLlmModelRef` ref (same pattern as the existing
  `turnLlmTtftRef`); `calls.llmProviderUsed` now falls back through `activeLlmProviderUsed ?? llmProviderOverride`
  the same way `ttsProviderUsed` already did. Also: `recordProviderFailover()` now has a third call site — a
  turn's actual served label is compared against `getActiveModelLabel(llmProviderOverride, llmModelOverride)`
  (what the primary link would have been), and a mismatch counts as a failover. This only catches our own
  transport-chain failover (ADR-109, `LLM_TRANSPORT_FAILOVER`) — the gateway's native multi-model fallback is
  still invisible to us by construction, since it never changes which link `streamText` was asked to open.
  1402/1402 tests pass, typecheck/lint/knip clean.

### 0.2 — Endpointing delay is invisible; `speech_final` vs `UtteranceEnd` (700ms apart) indistinguishable — **DONE (2026-08-16)**
- **Source:** audit-13 §5.1.
- **Where:** `packages/api/src/voice/stt/deepgram.ts` (`speech_final` ~300ms path at :98, synthetic
  `UtteranceEnd` ~1000ms path at :148-152), `stream.ts` (`turnStartedAt` at :1820).
- **What:** stamp the last-caller-audio-frame timestamp; diff against `speech_final`/`UtteranceEnd`; record
  which signal actually ended the turn. Persist both to `turn_latency`.
- **Risk:** low, instrumentation only.
- **Shipped as:** `SttTranscriptHandler` (stt/types.ts) gained an optional `endpointSignal` field, set by
  `deepgram.ts` at both call sites (`"speech_final"` / `"utterance_end"`; undefined on Sarvam/ElevenLabs,
  which have no second signal). `stream.ts` stamps `lastCallerAudioFrameAt` on every inbound media frame and
  diffs it against `turnStartedAt` into `endpointingDelayMs`. Both persisted to the new `turnLatency.endpointSignal`
  / `turnLatency.endpointingDelayMs` columns (migration `0051`).

### 0.3 — TTS socket-open time not separated from first-byte — **DONE (2026-08-16)**
- **Source:** audit-13 §3 (Finding 2, P1) — the ADR-083 lazy-connect hypothesis for the ~150-200ms Cartesia
  regression is plausible but unconfirmed at n=2 calls.
- **Where:** `packages/api/src/voice/tts/cartesia.ts` (`wss://api.cartesia.ai` connect at :27), `stream.ts`
  (per-turn TTS connect noted at :1338-1359).
- **What:** log socket-open duration as its own field, separate from `tts_first_byte_ms`. One number settles
  whether ADR-083's lazy connect is the actual regression source before touching the connect lifecycle (see
  1.2).
- **Risk:** none — pure logging.
- **Shipped as:** `ConnectTts` (tts/types.ts) gained an optional `onConnected(ms)` callback, mirroring STT's
  existing pattern — implemented in all three providers (cartesia.ts, elevenlabs.ts, sarvam.ts), each firing
  it once from the socket's own `"open"` listener with `Date.now() - connectRequestedAt`. Wired through
  `tts/index.ts`'s dispatcher and into `stream.ts`'s `attemptTts`, captured as `turnTtsSocketOpenMs` (only the
  turn's first socket counts — a mid-turn failover's connect time is a different cost) and persisted to the
  new `turnLatency.ttsSocketOpenMs` column. The actual §3 question (is ADR-083 the cause) still needs a
  production soak to answer — this only ships the instrument.

### 0.4 — No build SHA / boot time / region on `/health` — **DONE (2026-08-16), partial**
- **Source:** audit-13 §5.5, cited by three separate audits as blocking "what's actually running in prod."
- **Where:** `packages/api/src/index.ts` `/health` route (currently reports `activeTtsProvider`,
  `activeLlmProvider` (config, not actual — see 0.1), `activeModel`, compliance flags — no deploy identity).
- **What:** add `buildSha` (from Railway's injected env var if available, else git describe at build time),
  `bootTime`, and `region` (see 0.5) to the existing `/health` payload.
- **Risk:** none.
- **Shipped as:** `/health` now returns a `deploy: { buildSha, bootTime, region }` block —
  `RAILWAY_GIT_COMMIT_SHA`/`RAILWAY_REPLICA_REGION` read from Railway's own injected env vars (both report
  `"unknown"` outside Railway, e.g. local dev — expected, not a bug), `bootTime` captured once at module load.
  **Partial:** `region` will read `"unknown"` until 0.5 is actually decided and `railway.json` sets one — this
  item only builds the visibility, it doesn't answer the region question itself.

### 0.5 — Deployment region not pinned or discoverable — **OPEN — needs a decision, not just code**
- **Source:** audit-13 §4, explicitly called out as re-pricing levers #2, #6, #8: "if the API runs in India
  and Cartesia/Deepgram/the gateway terminate in the US, a chunk of #2's 200ms and some of #6 is pure RTT."
- **Where:** `railway.json` (`deploy` block currently has no `region` key).
- **What:** pin a region in `railway.json` matched to where STT/TTS/LLM providers actually terminate, and
  surface it via 0.4. Cheap; do before spending engineering time on 1.2/1.5/1.7 since it changes their ROI.
- **Risk:** low — Railway region changes may involve a redeploy; confirm no data-residency/compliance
  constraint first (this repo treats compliance as STOP-AND-ASK for `packages/weeber-compliance`, and
  region choice interacts with data-residency promises — check before changing).
- **Not done, deliberately:** this is a deployment-topology decision (which Railway region, checked against
  where STT/TTS/LLM providers actually terminate, and against any data-residency commitment) rather than a
  code fix — guessing a value here risks a redeploy for the wrong answer. 0.4's `region` field in `/health`
  is the prerequisite that makes this checkable at all; use it to see the current (implicit) region before
  deciding.

### 0.6 — Greeting fast-path hit/miss isn't logged — **DONE (2026-08-16)**
- **Source:** audit-13 §5.4 — "This finding took a database join to discover and should have been a log
  line," referring to the now-fixed F1, but the observability gap itself wasn't closed by `1f06ebb`.
- **Where:** `packages/api/src/voice/stream.ts` (`runGreeting`, the `literalGreetingText` guard).
- **What:** one log line recording hit/miss and, on miss, the unresolved merge-tag name. Cheap regression
  guard against this exact class of silent fallback recurring on a new template.
- **Risk:** none.
- **Shipped as:** the miss branch was already logged (2026-08-12, predates this doc) with the unresolved tag
  names — only the hit branch was silent, which meant the hit/miss *ratio* still wasn't greppable, only misses
  were ever visible. Added a matching `console.log` on the hit branch (`stream.ts`, next to
  `literalGreetingText = rendered`).

---

## Phase 1 — Fix the hot path without changing the product

Ordered by audit-13's own ranked-levers table, minus the already-fixed greeting lever, and re-sequenced so
0.5 (region) lands before anything whose ROI it changes.

### 1.1 — TTS connection is per-turn, not per-call/pre-warmed — **OPEN**
- **Source:** audit-13 lever #2, ~150-200ms/turn, "measured drift, inferred cause" pending 0.3.
- **Where:** `stream.ts:1338-1359`, `tts/cartesia.ts`.
- **What:** hold the TTS socket for the call, or pre-open during LLM prefill so the handshake overlaps
  instead of serializing behind the first token. Must preserve ADR-083's "idle socket ≠ broken provider"
  invariant — a held/pre-warmed socket needs an idle keepalive and health check so it isn't mistaken for a
  live failure.
- **Depends on:** 0.3 (confirm the mechanism before touching connect lifecycle — audit-13 explicitly warns
  against skipping this).
- **Risk:** medium — touches the TTS failover chain ADR-083 just fixed; needs its own regression test against
  "socket nobody has spoken on is not a broken provider" (ADR-083).

### 1.2 — No explicit reasoning-effort/verbosity/temperature/max-tokens on the LLM call — **OPEN**
- **Source:** audit-13 lever #3, 300-700ms cited (Artificial Analysis gpt-5-mini minimal 0.91s vs default
  1.38-1.65s TTFT — brackets the measured 1288ms almost exactly).
- **Where:** `packages/api/src/voice/agent.ts` (~line 1151-1165, `providerOptions`).
- **What:** set an explicit low/minimal reasoning effort. OpenAI's own voice guidance says start at `low`,
  not `minimal` — start conservative given ADR-081's qualify-and-transfer job has real compliance stakes
  attached to what the model decides.
- **Risk:** medium — some quality loss on multi-step tool turns is the explicit tradeoff; needs an eval (see
  Phase 4), not a stopwatch, before shipping past `low`.

### 1.3 — No stable-prefix prompt caching — **OPEN**
- **Source:** audit-13 lever #4, 13-31% TTFT cited (up to 70-90% on a well-ordered stable prefix). Persona
  is up to 19,480 chars (`insurance-final-expense-qualifier`).
- **Where:** `agent.ts:1142` (concatenation order: workflow-context + caller-memory + known-facts on top of
  persona).
- **What:** reorder so static persona/tool-schema content forms a stable, cacheable prefix and volatile
  per-call facts (caller memory, known facts) are appended last. Requires the AI Gateway to actually pass
  caching through — verify that before counting on the win.
- **Risk:** low-medium — pure reordering, but must not change what facts are visible to the model, only where
  they sit.

### 1.4 — All 13 tools ship on every request regardless of vertical — **OPEN**
- **Source:** audit-13 lever #5; audit-17 F8 (config 6 has 13 tools enabled including `confirmCodOrder` and
  `offerCartRecoveryDiscount` — Shopify-only tools on an insurance agent — against the template's own
  8-tool `default_tools`).
- **Where:** `agent-frame.ts:16` (`AVAILABLE_TOOL_NAMES`), org agent config tool resolution.
- **What:** prune to per-vertical/per-workflow tool sets. This is both a latency lever (50-150ms est.,
  compounds with 1.3 since schemas are prefix-cacheable) and a correctness fix (F8) — a smaller tool
  surface is also less for a 70B model to hallucinate syntax against (relevant to Phase 2).
- **Risk:** low — config-level narrowing, same shape as the existing `filterTransferTool` pattern ADR-115
  just extended.

### 1.5 — Semantic end-of-turn detection not wired; hard endpointing floor at 300/1000ms — **OPEN**
- **Source:** audit-13 lever #6, 150-300ms cited. Seam already exists: `turn-detection/index.ts`,
  `SEMANTIC_TURN_DETECTION_FLAG`, `refiner: null`. ADR-063 shipped the seam and deliberately deferred the
  model behind the gate.
- **Where:** `packages/api/src/voice/turn-detection/index.ts`, `stt/deepgram.ts:98,108`.
- **What:** wire a refiner (Deepgram Flux is the audit's suggested reference) behind a strict budget
  (architecture doc suggests 200-300ms) with an unconditional heuristic fallback — the model must never add
  unbounded latency to the hottest line in the call.
- **Risk:** medium — Twilio's own guidance (cited in the architecture doc) is that smart endpointing cuts
  median but can introduce tail stutter. This is a migration, not a config flip; needs real-call A/B, not a
  synthetic test.
- **Depends on:** 0.2 (can't evaluate an endpointing change without first measuring the current split).

### 1.6 — Transcript write sits in the critical path between `speech_final` and `runTurn` — **OPEN**
- **Source:** audit-13 lever #7 — part of the measured 122ms pre-LLM overhead, likely most of it.
- **Where:** `stream.ts:1861` (`await logTranscript("caller", text)`).
- **What:** make non-essential writes asynchronous but ordered — fire-and-forget loses ordering guarantees
  on the transcript, so this needs an event buffer/durable append worker, not a bare `void`.
- **Risk:** low-medium — ordering guarantee is the thing to protect; don't trade a latency win for a
  scrambled transcript.

### 1.7 — Provider default (`gateway`) vs Groq direct — **OPEN, blocked**
- **Source:** audit-13 lever #8; audit-17 §4 (F6) originally reported groq 1122ms vs gateway 1793ms p50 as a
  provider result — **audit-17's own Addendum 1 (Correction 1) retracted this**: the gap tracked whether the
  turn executed a tool, not which provider served it. Addendum 2 then found `llm_provider_used` isn't even a
  measurement of what ran (see 0.1).
- **What:** do **not** re-run this comparison, or make any provider-default decision from it, until 0.1
  ships. When it does, re-test on tool-executing turns only (Addendum 1's explicit correction to its own
  first attempt) — comparing idle-turn latency across providers reproduces the same mistake twice.
- **Risk:** this item exists specifically to prevent a decision being made on bad data — treat "not yet
  measurable" as the current, correct answer.

---

## Phase 2 — Tool-call correctness: stop unvalidated model output from reaching the caller

The architecture assessment placed this under its Phase 2 (`VoiceRuntime` interface, §5.4/§6). Pulling it
forward here because audit-17 shows it's an active, observed production defect right now (9 of 68 agent
lines leaked tool syntax to a caller across 3 calls), not a hypothetical architectural gap — and because
0.1's instrumentation is a hard prerequisite for even diagnosing it further.

### 2.1 — Tool-call syntax leaks into spoken output; root cause still unresolved — **OPEN**
- **Source:** audit-17 F2/F3 + Addenda 1 and 2. History matters here — read it before touching this:
  - Original hypothesis (persona teaching bad syntax) — **fixed** in `eafc762`, verified byte-for-byte
    against production, **did not stop the leak** (3 dialects in 2 days).
  - Addendum 1 hypothesis (context growth degrading tool-calling grammar) — **killed** by Addendum 2's
    replay experiment (6 runs, real persona, real tools, zero leaks; failures cluster at the *smallest*
    contexts, not the largest).
  - Addendum 1 hypothesis ("model told to use a tool not in the request") — **killed**, replayed with both
    missing tools removed, still zero leaks.
  - Addendum 2's replay found the real Groq-direct behavior is a clean 400 rejection when the model
    malforms a call — **never falls through to spoken text**. This means call 11's actual leaked turns were
    "very likely not served by direct Groq, whatever `llm_provider_used` says" — the gateway route is the
    live suspect, specifically a gateway that catches an upstream validation failure and returns the raw
    generation as content.
- **Do not:** add a fourth output-guard regex (three have already been added and each one fits only the last
  observed dialect — audit-17 calls this "a pattern chase, and it is losing"). Do not rewrite the persona
  again — Addendum 2's replay proves the persona isn't the mechanism.
- **What:** ship 0.1 first (per-turn transport+model+finish-reason, `activeLlmProvider`). Then pull Railway
  logs for the 2026-08-14 17:00:41 UTC window on call 11 to see the actual gateway response for a malformed
  tool call — the 400s (or their absence) are "in there and nowhere else." This is a diagnosis task blocked
  on infra access (a live Railway token), not a code task yet.
- **Risk:** N/A — this is instrumentation + log-pull, not a fix, until the mechanism is confirmed.

### 2.2 — No typed event-stream separation between model output and spoken output — **OPEN**
- **Source:** architecture doc §5.4's structural recommendation, motivated directly by 2.1: "a tool call
  must be an event with a validated schema and execution receipt, never a string that can fall through to
  TTS."
- **What:** once 2.1 identifies the actual leak path (gateway response handling is the current lead
  suspect), the durable fix is architectural, not another regex: a turn should produce a typed event stream
  (`assistant_text`, `tool_call_requested`, `tool_call_rejected`, `tool_call_started`,
  `tool_call_succeeded`, `tool_call_failed`, `assistant_audio`), and only `assistant_text` plus approved
  deterministic system lines should ever reach TTS. This is the first concrete piece of Phase 3's
  `VoiceRuntime` contract and can be scoped narrower than the full interface — just the
  model-output/spoken-output boundary inside the existing `stream.ts` turn loop.
- **Risk:** medium-high — this changes how every turn's output is routed; needs the full existing test suite
  plus new tests replaying audit-17's exact leaked-syntax transcripts as regression fixtures.
- **Depends on:** 2.1 (fix the actual source before adding a structural gate around it — a gate without a
  known mechanism is another regex with worse ergonomics).

### 2.3 — `FALLBACK_REPLY` blames the caller for a model failure; empty greeting turns don't retry — **OPEN**
- **Source:** audit-17 F5 (P1). Calls 7 and 10: the *greeting* turn itself produced nothing, so the first
  thing two callers heard was "Sorry, I didn't quite catch that" before the agent had said anything.
- **Where:** `packages/api/src/voice/agent.ts:1469` (empty spoken text), `:1479` (turn timeout).
- **What:** two separable changes — reword to not blame the caller ("Give me one second" is honest and buys
  the same time), and retry once (or fall back to the template's stored `greeting_line`) before speaking a
  clarification request into silence on an empty greeting turn specifically.
- **Risk:** low — copy change plus a bounded retry, no architectural dependency.

### 2.4 — `flagGuardrailEvent`'s only production firing was a false positive — **OPEN**
- **Source:** audit-17 F10 — fired on "caller asked about plan details" (not a promise), while the two real
  unauthorized promises in the dataset (F1, F4) fired nothing.
- **Where:** guardrail event classification logic (wherever `flagGuardrailEvent` is invoked from the tool
  layer).
- **What:** tighten the classifier so it distinguishes a caller question from an agent promise. Low priority
  relative to 2.1/2.2 — this is a signal-quality issue on a detector that isn't yet the primary defense
  (2.2 is), but worth fixing so guardrail data is trustworthy once it *is* load-bearing.
- **Risk:** low.

---

## Phase 3 — Introduce a `VoiceRuntime` contract

This is the architecture doc's own Phase 2, unchanged — it's a genuine interface-design task, not something
production evidence has made urgent yet the way Phases 0-2 are. Summarizing rather than re-deriving; see
`docs/audits/2026-08-16-manus-weeber-vs-sota-voice-architecture.md` §6.1-6.2 and §7 Phase 2 for the full
design (Media Edge Gateway → Voice Session Runtime → Turn Manager → Cascaded/S2S Adapters → Policy/Executor).

- **What:** extract the current cascade out of `stream.ts` behind a `VoiceRuntime` interface (session
  start/stop, audio input, speech events, agent text/audio events, interruption, tool calls, side-effect
  receipts, playback acks) before attempting a second implementation (LiveKit/Pipecat-style, or an OpenAI
  Realtime S2S adapter).
- **Sequencing note:** do this *after* Phase 2 ships, not before — 2.2's typed event stream is a strict
  subset of what this interface needs, and building it twice (once ad hoc for the leak fix, once properly
  for the interface) is waste. Land 2.2 first, generalize it into the full contract here.
- **Risk:** high — this is the item most likely to become a rewrite-in-disguise if scoped loosely. The
  architecture doc's own final recommendation is explicit: extract and interface, do not rewrite the
  business backend. Treat any PR here that touches `packages/api/src/voice/webhooks.ts`, compliance gates,
  or workflow execution as a scope violation.

---

## Phase 4 — Production-scale session infrastructure

Architecture doc's Phase 3, unchanged in substance. Not urgent at current single-org/single-instance pilot
scale, but the default matters: `session-store.ts` is already dual-mode (process-local `Map` default,
Redis-backed opt-in via `REDIS_URL`), and `ecosystem.config.cjs` is a single PM2 fork (`exec_mode: "fork"`,
`instances: 1`) — confirmed current, not stale.

- **What:** lease-based session registry (Redis for ephemeral session metadata/locks/cancellation tokens,
  Postgres for durable state, a queue/stream for ordered noncritical writes), a fenced owner per live
  session so a reconnect can't double-execute an irreversible tool, dedicated media workers separate from
  the dashboard/control API, capacity-aware dispatch, graceful drain.
- **Trigger condition:** this doc recommends treating this as a "when we have a second concurrent-call
  customer" problem, not a "do it now" problem — the single-fork default is a real gap but not the one
  costing the pilot org anything today. Revisit sizing once org count or concurrent-call volume actually
  requires it.
- **Risk:** high, infra-level — needs a canary rollout plan, not a direct main-branch change.

---

## Phase 5 — Quality engineering and evaluation

Architecture doc's Phase 4, unchanged in substance.

- **What:** a replayable eval set (real anonymized audio, code-mixed Hindi/English, interruptions, silence,
  numbers/dates/DTMF, transfer requests, tool failures, provider failover, prompt injection, ambiguous
  identity), scored on endpointing accuracy, interruption quality, first-audio latency, tool-call validity,
  side-effect correctness, disclosure compliance, hallucinated promises, outcome completion.
- **Immediate seed material already exists and should be used, not re-collected:** audit-17's actual leaked
  transcripts (F2/F3) and the fabricated-confirmation call (F4) are ready-made regression fixtures for
  2.1/2.2. Addendum 2's `replay11.ts`/`replay11b.ts` scripts are a working replay-harness prototype — reuse
  the pattern rather than building a new one.
- **Depends on:** 1.2 explicitly needs this before any reasoning-effort change ships past `low` — audit-13
  says so directly ("each one trades quality for milliseconds and needs an eval, not a stopwatch").
- **Risk:** low to build, but only useful once Phase 0's instrumentation makes eval results attributable to
  an actual model/provider/route rather than a config field (same lesson as 0.1/1.7).

---

## Suggested working order

1. ~~**Phase 0 in full** (0.1-0.6)~~ — **0.1, 0.2, 0.3, 0.4, 0.6 shipped 2026-08-16** (migration `0051`,
   1402/1402 tests, typecheck/lint/knip clean). **0.5 (region) is still open** — it's a deployment decision,
   not a code change; see its entry for why it wasn't guessed at. Every later phase either depended on this
   or risked repeating an already-debunked conclusion (audit-17's own history is the cautionary tale here —
   it drew three different wrong conclusions in a row from the same uninstrumented gap).
2. **2.3, 2.4** — cheap, isolated, no dependencies, real caller-facing quality wins.
3. **1.3, 1.4** — low-risk latency/correctness levers, no architectural dependency.
4. **0.5 (region)**, then **1.1, 1.5, 1.6** — re-price these against the region finding before investing in
   them.
5. **2.1** — diagnosis, blocked on Railway log access; can run in parallel with the above once 0.1 ships.
6. **2.2** — once 2.1 names the actual leak mechanism.
7. **1.2** — only after Phase 5's eval harness exists to score the quality tradeoff.
8. **1.7** — re-attempt only after 0.1 ships, and only on tool-executing turns.
9. **Phase 3** — after 2.2, generalizing its typed-event work into the full `VoiceRuntime` contract.
10. **Phase 4** — deferred until concurrent-call volume actually demands it.
