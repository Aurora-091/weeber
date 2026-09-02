# Krishna Task List

Working list of open items surfaced 2026-09-02 while investigating call latency, turn detection,
and reviewing live Supabase call/transcript data. Ordered by priority. Each item names the exact
file(s) to start from and what evidence backs it, so it doesn't need to be re-derived from scratch.

Status key: 🔴 not started · 🟡 in progress · ✅ done

---

## 1. 🔴 Opted-out callers are not actually being suppressed (compliance)

**Priority: highest — this is a live compliance gap, not a quality issue.**

Confirmed against production data (Supabase project `Weeber`, `qghtkadxbtptvbfbmsdz`):

- `opt_out_events` has real rows (e.g. call 16, call 17 — same number, `+919359848364`) where a
  caller explicitly said "don't call me back" and the system correctly detected it.
- `dnc_propagated_at` is `null` on every row in `opt_out_events`.
- `do_not_call` has **zero rows**, total, across the whole database.
- `dncAdapter.add()` (`packages/api/src/voice/compliance/adapters.ts`) is fully implemented and
  works — but is never called anywhere in `packages/api/src`. `outbound-gate.ts` only ever reads
  the DNC list before dialing (`isOnDoNotCallList`); nothing ever writes to it.

This is a known, named gap, not a regression — `stream.ts`'s comment near the `opt_out_events`
insert says DNC propagation is "a separate step (Phase II / an existing DNC-add path)". That step
was never wired up.

**What to do:** in `packages/api/src/voice/stream.ts`, where `opt_out_events` gets its row
inserted (search for `cancellation_or_opt_out`), also call `dncAdapter.add()` for the same
phone number/org, and stamp `dncPropagatedAt` on the `opt_out_events` row once it succeeds.
Decide whether this should be automatic (every detected opt-out immediately propagates) or land
in an admin review queue first — automatic is simpler and closes the gap fastest, but a false
positive on intent detection would incorrectly block a real number. `packages/weeber-compliance`
itself doesn't need to change — the adapter is already there — but this is compliance-critical
enough to have a second person's eyes on the approach before merging.

---

## 2. 🔴 LLM-driven latency spikes — timeout-based failover (code shipped, not yet deployed)

**Status: code is done locally, uncommitted. Needs review + deploy decision.**

Root cause (confirmed from `turn_latency` data): `llm_ttft_ms` — not TTS, not endpointing — drove
p95 voice-to-voice latency to 4.7s and spikes to 13s. Traced to a 2026-08-27 Vercel AI Gateway
slowdown (`gateway/google/gemini-3.1-flash-lite` and `gateway/openai/gpt-5.4-mini` responses taking
5-10s to first token). `LLM_TRANSPORT_FAILOVER` is already `true` in prod, but
`streamWithTransportFailover` only failed over on a thrown error — a slow-but-successful response
never triggered it.

**Fix already written** (uncommitted, in the working tree):
- `packages/api/src/voice/llm/transport-stream.ts` — added `firstTokenTimeoutMs`, so a link that
  produces nothing within the window (2.5s, matching `call-health.ts`'s existing
  `LLM_TTFT_DEGRADED_MS`) is aborted and failed over, same as a thrown error. New
  `TransportChainExhaustedError` when every link is exhausted.
- `packages/api/src/voice/agent.ts` — wires the timeout through, only active when the transport
  chain is non-empty (flag off ⇒ unchanged behavior). Catch block now returns `FALLBACK_REPLY`
  instead of propagating a raw error when the chain is exhausted.
- `packages/api/src/voice/llm/transport-chain.test.ts` — updated + 4 new tests, all passing.
  Typecheck clean. Full suite diffed against baseline — zero new failures.

**Before merging:** confirm on Railway prod whether `AI_GATEWAY_FALLBACK_MODELS` actually contains
a `direct:groq/...` entry. There's an unresolved discrepancy — the test file's own comment claims
production's value is `"openai/gpt-5.4-mini,groq/llama-3.3-70b-versatile"` (no `direct:` prefix,
meaning the chain never actually leaves the gateway), but that contradicts what was reported back
during this session. Worth 30 seconds on the Railway dashboard before assuming the fix fully
bypasses the gateway rather than just bounding the wait.

---

## 3. 🔴 `unsourced-claim-guard.ts` may have a false negative

Call 2's transcript has the agent saying *"cremation services typically run between five thousand
and eight thousand dollars"* — this is the exact scenario the guard was built for (the same
sentence shape that motivated writing the detector, per its own doc comment). No `unsourced-claim`
guardrail event fired for call 2 in `guardrail_events`. Worth checking why this phrasing didn't
trip the detector — could be a wording/pattern-matching gap, or the persona-baked-in case is
handled differently than a model-generated one.

---

## 4. 🔴 Turn-segmentation quality varies a lot by caller — worth a look

Call 16's caller (self-identified as an elderly retired Army officer) got fragmented into
one-and-two-word transcript turns ("One.", "$25.", "Second of month.") noticeably more than other
calls in the sample. Might be an STT/endpointing sensitivity issue for certain speech patterns
(slower speech, pauses) rather than a general defect — worth pulling a larger sample before
concluding anything, but flagging now since it surfaced from reading real transcripts.

---

## 5. 🔴 Deepgram Text Intelligence — post-call enrichment opportunity

Weeber already pays for Deepgram (STT, `DEEPGRAM_API_KEY`). Deepgram separately ships a
**Text Intelligence** API (`/read` endpoint — Summarization, Topic Detection, Intent Recognition,
Sentiment Analysis) that runs on stored text, decoupled from live audio.

Today, `calls.sentiment` and `calls.intent` are set entirely by the live LLM's own tool calls
(`setDisposition`/`setIntent`) — same model carrying the turn's latency budget, and not always
reliable (see call 2: the agent inferred "tobacco: no" from the caller saying "I drink sometimes" —
a question about alcohol, not tobacco, answered ambiguously and resolved wrong).

**Proposal:** run Deepgram Text Intelligence as a post-call, async batch job against
`transcripts` — no live-latency cost — to get an independent sentiment/intent/topic read and a
structured call summary. Use it as a cross-check against the LLM's own `setDisposition`/`setIntent`
calls, and as a foundation for merchant-facing call summaries (no `summary` field exists on `calls`
today). Not urgent, but low-friction (same vendor, same key, works off data already stored).

---

## 6. 🔴 RLS disabled on 45 tables, both Supabase projects

`Weeber` (`qghtkadxbtptvbfbmsdz`) and `Weeber Staging` (`zbcrwexrqfmjxhewirgp`) both have Row Level
Security **disabled** on every public table — anon/authenticated keys can read or write every row.
Flagged by Supabase's own advisor. Not touched — enabling RLS blind breaks the app if policies
aren't written first. Needs a deliberate pass: write per-table policies (org-scoped access is the
obvious shape given the multi-tenant schema), test against the app, then enable.

---

## 7. 🔴 Wire a turn-detection model into the existing seam

Carried over from the 2026-08-27 SOTA comparison audit (`docs/audits/2026-08-28-full-pipeline-sota-audit.md`):
Weeber has no ML turn-detection model — just a regex over Deepgram's `speech_final`
(`voice/turn-detection/{heuristic,composite,budgeted}.ts`), deliberately, behind a clean seam
(ADR-063). Pipecat's Smart Turn v3 (BSD-2-Clause, ~8MB int8, runs during VAD silence — the exact
pattern `composite.ts` already implements) was the audit's top recommendation: highest
quality-to-risk ratio, bounded by the existing 300ms budget. Separate from item #2 above — this
improves interruption/naturalness, not raw response latency.

---

## Reference

- Live data pulled from Supabase projects `Weeber` (prod) and `Weeber Staging` via MCP, 2026-09-02.
- Full comparative audit: `docs/audits/2026-08-28-full-pipeline-sota-audit.md`.
- ADR-109 (cross-transport LLM failover), ADR-062 (opt-out events), ADR-063 (turn-detection seam).
