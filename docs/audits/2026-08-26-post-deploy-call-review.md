# Post-deploy call review — 18 calls, 3 of them genuinely post-deploy

- **Date:** 2026-08-26
- **Source:** production Supabase (`qghtkadxbtptvbfbmsdz`), read-only, via `mcp__supabase__execute_sql`
- **Scope:** every row in `calls` (18 rows, ids 1-9,11,13-17,19-21 — ids 10/12/18 are identity gaps from
  the already-diagnosed fire-and-forget insert race, not new evidence of anything), plus `transcripts`,
  `tool_calls`, `guardrail_events`, `turn_latency`, `call_latency` for calls not already covered in depth
  by the two prior audits below.
- **What's new here vs. what's already written down:** `2026-08-21-first-two-production-calls.md` covered
  calls 1-2. `2026-08-25-ten-calls-full-pipeline-review.md` covered calls 1-9, 11. Neither had seen calls
  13-17 (2026-08-25, before this session's Phase C/D work deployed) or calls 19-21 (2026-08-25 ~11PM IST
  through 2026-08-26 afternoon — genuinely **after** the Railway deploy the user approved this session).
  This doc reviews 13-17 for the first time and goes deep on 19-21, the only calls that have actually run
  against Phase C/D's shipped code.
- **Class:** dated point-in-time artifact (ADR-118 class 2). Not a plan.

## Headline: pickup-to-first-audio is not a Phase C/D regression — it was never fixed, and still isn't

Every call in this system's history, from the very first (2026-08-20) to the three post-deploy ones
(2026-08-26), shows `pickup_to_first_audio_ms` well over the exit gate's <1200ms target:

| call | pickup_to_first_audio_ms | when |
|---|---|---|
| 1 | 1985 | 2026-08-20 (pre-A3) |
| 2 | 2753 | 2026-08-20 (pre-A3) |
| 3 | **10487** | 2026-08-24 (pre-C1-C4) |
| 4-9, 11 | 1761-4429 | 2026-08-24 (pre-C1-C4) |
| 13-17 | 1419-5928 | 2026-08-25 (pre-C1-C4) |
| 19 | 1992 | 2026-08-25 23:48 IST (**post-deploy**) |
| 20 | 2766 | 2026-08-25 23:51 IST (**post-deploy**) |
| 21 | 3052 | 2026-08-26 15:22 IST (**post-deploy**) |

There is no before/after break at the deploy boundary. Calls 19-21 (1992-3052ms) sit inside the exact same
range as every call that came before them, including the very first two ever made (1985/2753ms) — Phase
C's shipped work did not move this number, in either direction, on this sample.

**This is expected, not a regression, once you check what Phase C actually targeted.**
`2026-08-25-ten-calls-full-pipeline-review.md`'s Finding 3 already root-caused this exact gap before any
of Phase C shipped: on call 3, `stt_connect_ms` (209) + `llm_ttft_ms` (720) + `tts_first_byte_ms` (1050)
summed to 1,979ms against a `pickup_to_first_audio_ms` of 10,487ms — **8,508ms unaccounted for by any
column this codebase writes**, attributed to the "start" handler's own setup sequence (org/agent-config
resolution, the session lookup, the calls-row select/insert — every awaited step before
`connectSttForCall`/`runGreeting` are even reached), which has no metric of its own. Re-checked here on
calls 19-21: the same shape holds. Call 21's turn-0 numbers (`llm_ttft_ms` 984, `tts_first_byte_ms` 451,
sum 1,435) leave 1,617ms of its 3,052ms unexplained — proportionally the worst of the three, and the most
recent.

Phase C's actual scope (`phase-c-latency.md`): C1 reuses the TTS session across turns (helps turn 2+, not
the first connection), C2 fixes prompt-cache stability (helps repeat-turn LLM cost, not a cold first
turn), C3 confirmed STT-connect doesn't gate the greeting (`stt_connect_ms` was already small pre- and
post-deploy — 135-211ms on 19-21, never the bottleneck), C4 caps terminal-turn tool-call batching. **None
of C1-C4 targets the un-instrumented "start"-handler gap that Finding 3 named as the single largest
unexplained latency sink in the whole pipeline.** It's still there, still unmeasured, and — per this
sample — still the largest lever available for pickup-to-first-audio specifically. Turn-level
`voice_to_voice_ms` (the metric C1/C2 actually target) looks healthier: 8 sampled turns across 19-21 give
a rough p50 ≈1120ms, right at the exit gate's <1100ms edge — not a clean pass, but not obviously broken
either, and consistent with C1/C2 having *something* to show for themselves on the metric they were built
for.

**Recommendation:** instrument the "start" handler's own setup sequence before spending more effort on
C1-C4-style per-stage optimization — the biggest lever left is a gap nothing currently measures, named
twice now (2026-08-25 and here) and fixed neither time.

**Done 2026-08-26**: `stream.ts`'s "start" handler now times its own setup sequence — session lookup, the
`calls` row select/insert, and the `Promise.all` config batch (callerMemory, `resolveAgentConfig`,
`getEffectiveFlags`, the org row, `getLeadGreetingContext`) — and logs one consolidated breakdown line
right before `connectSttForCall`/`runGreeting`: `"start" handler setup breakdown — session lookup: Xms,
call row lookup: Xms, config batch: Xms, total so far: Xms (callSid)`. Deliberately console-log only, not
persisted to `call_latency` — a persisted column needs a schema migration against the production DB, which
is a separate, more committal change than logging, and wasn't attempted here. This closes the "still
unmeasured" half of the finding; the actual root cause (which of these three, or something even earlier,
is the real bottleneck) is now answerable from Railway logs on the next real call, not yet answered by this
change itself.

## New finding: `hangUp` called twice in the same turn produces a duplicated spoken goodbye and talks over the caller

Call 19 (post-deploy, a CSAT follow-up call, ~55 seconds total) — `tool_calls`:

```
19:19:42.243  hangUp  {"reason":"caller provided feedback, conversation concluded"}
19:19:42.730  hangUp  {"reason":"caller provided positive feedback and ended conversation"}
```

Two distinct `hangUp` calls, 487ms apart, different `reason` text each — the model genuinely emitted two
separate tool calls, not a retry of an identical one. `transcripts` shows the consequence directly:

```
19:19:43.024  agent    "Wonderful — thank you so much for sharing. We really appreciate it. Have a great day!"
19:19:40.397  caller   "the"                                              [logged out of order — see below]
19:19:45.25   agent    "Wonderful — thank you so much for sharing. We really appreciate it. Have a great day!
                         This call is now closed."
```

The exact same sentence is spoken twice, 2.2 seconds apart, character-for-character identical up to where
the second one appends "This call is now closed." The caller's trailing "...the way you guys interact and,
you know, [the]" (their full utterance across transcript rows 8 and 10) landed *between* the two goodbyes
by wall-clock time (`created_at` 19:19:40.397, before row 9's 19:19:43.024, despite being logged as
sequence 10 — the same out-of-order-transcript-write behavior the 2026-08-21 audit's Finding 4 already
documented) — so the caller was still finishing their sentence while the agent had already started closing
the call once, and closed it a second time before the caller's trailing word was even in the transcript.

`hangUp` is in `agent.ts`'s `TOOL_CALL_CAP_EXEMPT` set (Phase C4, deliberately never subject to the
per-turn tool-call cap — the plan's own reasoning: "delaying [hangUp] because a turn already spent its
budget on captured facts is exactly the class of subtle defect ADR-082/-105/-106/-115 have already
produced"). That reasoning is about not *deferring* a legitimate hangUp — it didn't anticipate the model
calling hangUp *twice* in the same turn, which the cap-exemption also doesn't guard against, since nothing
in `stream.ts`'s hangup handling deduplicates a second hangUp arriving moments after the first one already
started closing the call. This is a real, newly-observed, live defect — not present in either prior audit
because it needed a post-deploy call with this exact shape to surface it. Likely fix: make `performHangUp`
idempotent (a `hangupRequested` latch, the same pattern `transferLatched` already uses for the
transfer-vs-hangup ordering defect ADR-082 fixed) — not attempted here, this is a findings-only pass.

## Confirmed working live: D7's disclosure protection

All three post-deploy calls fired `disclosure_fired_at` cleanly, ~2 seconds after `started_at`, with no
sign of the greeting being interrupted or re-queued:

| call | started_at | disclosure_fired_at | gap |
|---|---|---|---|
| 19 | 19:18:48.512 | 19:18:50.596 | 2.08s |
| 20 | 19:21:18.024 | 19:21:20.079 | 2.06s |
| 21 | 09:52:30.572 | 09:52:33.594 | 3.02s |

Consistent with D7 item 2 (non-interruptible disclosure) holding up on real calls, for whatever a 3-call
sample with no caller actually attempting to barge in during the greeting is worth — none of these three
callers spoke early enough to test the protection itself, so this confirms disclosure *completes*
normally, not that the barge-in guard specifically fired live (that part is only tested synthetically so
far, in `stream-synthetic-suite.test.ts`).

## New finding: D2/D3's askCount ledger has a blind spot for re-asks that never call `markFieldUnanswered`

Call 16 (2026-08-25, pre-deploy, not previously audited) — the agent asks "are you thinking final expenses
or leaving something behind for your family" **four times in a row** (transcript sequences 9, 11, 13, 15)
against a caller giving one- or two-word fragmented answers ("your", "time to connect with", caller
audio/engagement was clearly poor), before finally getting a usable answer at sequence 18 ("final").
`tool_calls` for this call shows **zero `markFieldUnanswered` calls for `coverage_purpose`** anywhere —
the model just kept naturally re-phrasing the question inline, turn after turn, without ever invoking the
tracked-ledger tool.

D2/D3's `askCount` cap (`MAX_FIELD_ASK_COUNT = 2`, `agent.ts`) only increments when the model calls
`markFieldUnanswered` — it has no way to notice a field being re-asked purely through ordinary
conversational rephrasing that never touches the tool. In this call the loop resolved fine (a real answer
eventually came, nothing was fabricated) — later in the same call, `benefit_timing` shows the ledger
working exactly as designed (two tracked `markFieldUnanswered` calls, the second correctly refused by
`heardInCallerSpeech` for a paraphrased rather than verbatim quote, then a genuine answer captured once the
caller actually gave one) — so this is a **coverage gap, not a proven-harmful defect on this evidence**.
But it's the same shape as the original tobacco-loop finding that motivated D2 in the first place: a
question asked more times than is reasonable, invisible to the one mechanism built to catch that pattern,
because the model never called the tool the mechanism watches. Worth naming for whoever next touches D2 —
the fix isn't obvious (forcing `markFieldUnanswered` on every non-answer isn't something a prompt
instruction can guarantee any more than the original "call captureField immediately" instruction could,
per A3's own finding).

## Everything else checked and clean

- **Calls 13, 14, 15, 17** (2026-08-25, not previously audited): short calls — two opt-outs (13, 17), two
  early disqualifications (14, 15) where the caller asked "who are you?" / "what kind of policy" and the
  agent answered plainly and held the ADR-106 licensed-act boundary correctly each time. No repeated
  questions, no fabrication, no guardrail events. Unremarkable in the good sense.
- **Call 16's transfer-fallback**: advisor unavailable → agent correctly offers a callback instead of
  fabricating a connection (ADR-105-class behavior) → caller declines the callback → agent respects that
  and does not schedule anything, does not promise follow-up. Correct behavior, matches what A4/ADR-105
  were built to guarantee.
- **`guardrail_events` across 16/19/20/21**: every row is either a correctly-caught `undelivered-outcome`
  (CRM genuinely not configured for either org — `org_integrations` still empty, not a code defect) or a
  correctly-refused `fabricated-capture` (the `markFieldUnanswered` paraphrase on call 16, above). No
  guardrail fired that shouldn't have, and nothing that should have fired was silently missed in what was
  checked here.
- **Recordings**: not downloaded/re-transcribed. Nothing in the stored transcripts read as garbled,
  suspiciously short for the call duration, or contradicted its `health_status` badly enough to justify
  the cost of pulling `recording_url` + re-running it through Deepgram — the DB transcripts read as
  faithful, coherent conversations throughout.

## What this changes

1. **Phase C's exit-gate condition 5/6 (latency) should not be marked met on pickup-to-first-audio** —
   the number hasn't moved from the pre-Phase-C baseline, because nothing in C1-C4 targeted the actual
   bottleneck (the un-instrumented "start"-handler setup sequence, named twice now). `voice_to_voice_ms`
   is closer to its target and arguably fine to evaluate once n≥10 real post-deploy turns exist (currently
   n=8).
2. **A new, real, live-observed defect**: `hangUp` needs deduplication within a turn — not present in
   either prior audit, only surfaced because a post-deploy call happened to produce this exact shape.
   **Fixed 2026-08-26**: `hangupLatched` (`stream.ts`), the same shape as `transferLatched`'s ADR-082 fix —
   latched the instant `hangUp` is first requested, checked at the same STT-handler gate that already
   refuses a trailing caller turn once a transfer is latched. New regression test in
   `stream-hangup.test.ts` reproduces call 19's exact timing (a trailing utterance arriving 50ms after the
   first hangUp, while the closing-line wait is still in flight) and proves no second turn runs. Not
   deployed yet.
3. **A named, evidence-backed gap** in D2/D3's askCount ledger (re-asks that never call
   `markFieldUnanswered` are invisible to it) — not proven harmful on this evidence, worth tracking if it
   recurs with an actually-bad outcome.
4. **D7's disclosure mechanism is confirmed completing normally on real post-deploy calls** — not yet
   confirmed under a real live barge-in attempt, since no caller in this 3-call sample tried to speak
   during the greeting.
