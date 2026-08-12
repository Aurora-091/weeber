# ADR-107: A stage that is charged for another stage's time cannot be optimized

- **Date:** 2026-08-12
- **Status:** Accepted (implemented 2026-08-12)
- **Supersedes / amends:** corrects the `turnLatency` doc comment introduced with the per-turn latency work (2026-07-17) and the anchor it describes, which the 2026-07-17 fix left in place while fixing an adjacent bug. Interacts with ADR-083's lazy TTS connect, which supplies the correct anchor. Does **not** change `voiceToVoiceMs`, ADR-101's dead-air alarm, or any call behaviour.

## Context

Production `turn_latency`, all 78 rows (11 internal test calls,
2026-07-18..2026-08-10):

| metric | p50 | p95 |
| --- | --- | --- |
| voice-to-voice | 1878 ms | 4364 ms |
| llm_ttft | 1381 ms | — |
| tts_first_byte | 1748 ms | — |

Those numbers cannot all be true at once. `tts_first_byte` is 93% of a turn
that `llm_ttft` already claims 74% of. Read literally, the dashboard says the
vocoder is the problem and the model is nearly free.

The row-level pattern is what settles it. Sorted by voice-to-voice, every
single row:

```
llm 3648 | tts 4051 | v2v 4180   ->  v2v - tts = 129 ms
llm 3441 | tts 3862 | v2v 3990   ->  128 ms
llm 2584 | tts 2991 | v2v 3118   ->  127 ms
llm 1645 | tts 2065 | v2v 2193   ->  128 ms
```

`v2v - tts` is pinned at ~127 ms across a 2-second spread of LLM time. A real
TTS measurement cannot track LLM latency that rigidly. `tts_first_byte_ms` was
not measuring TTS.

### Why

`stream.ts` captured `ttsRequestedAt = Date.now()` at the top of `speak()`,
then computed the TTS stage from it. But `speak()` starts *before*
`generate()` runs the model. Between that instant and the first character
reaching TTS sits the entire LLM TTFT, plus any tool round-trip. So the
column meant "speak() entry -> first audio byte", which contains the LLM
stage in full. The ~127 ms constant is the only part that was ever really
TTS-and-dispatch.

Both components therefore contained the same milliseconds, and the schema doc
comment asserting they were "the two components of that budget, kept
separately so a regression can be attributed to the right stage" was false as
written. The one metric that was always correct is `voiceToVoiceMs` — it is
anchored on the caller, not on an internal function boundary.

The consequence is not a cosmetic reporting error. The next latency decision
this repo makes is which LLM transport to run (direct Groq vs the gateway),
and the instrument on hand said the LLM was a minor contributor. Corrected,
the p50 turn decomposes to roughly **127 ms dispatch / 1381 ms LLM / ~370 ms
TTS** — the model is about three quarters of the caller's wait, and TTS
provider shopping would have bought almost nothing.

This is the same defect class as ADR-090, one level up: the metric had a real
caller and real rows, so nothing looked broken. Only its *meaning* was
detached from its name, and no test asserted meaning.

## Decision

**1. Anchor the TTS stage where TTS work actually begins.** `ttsFirstByteMs`
(per-turn and call-level) is now measured from `ttsTextFirstSentAt` — the
first character handed to TTS, captured inside ADR-083's lazy-connect facade.
Deliberately set *before* the socket opens, because connect time is genuine
TTS cost and belongs inside the number.

**2. Redefine the existing column rather than adding a second one.** All 78
pre-cutover rows are internal test calls with no customer traffic behind them.
Carrying a parallel column forever to preserve them would be the worse trade.
The cutover instant is recorded in the `turnLatency` doc comment in
`database/schema.ts`; rows from either side of it must not be pooled. This is
not a schema change — no column is renamed or dropped, so the additive-only
migration invariant is untouched.

**3. Hold `voiceToVoiceMs` exactly as it was**, in meaning and in value. It
was previously reconstructed as `ttsRequestedAt + turnTtsFirstByteMs -
turnStartedAt`, which was only correct while `turnTtsFirstByteMs` happened to
share that anchor. It now reads a `turnFirstAudioAt` absolute instant
directly, which is both invariant to this change and one less thing to get
wrong later.

**4. Assert the meaning, not just the presence, of the metric.**
`stream-latency-attribution.test.ts` drives a turn whose LLM stalls before its
first token in front of a TTS that answers instantly, and asserts the stall
lands in `voiceToVoiceMs` and *not* in `ttsFirstByteMs`. Verified to fail
against the old anchor (2 of 3 assertions; the double-counting assertion
reported `241 <= 142`, reproducing the doubling on demand) and pass against
the new one.

## Measured

- `bun run --cwd packages/api test`: 1281 pass, 0 fail, 3441 expect() calls, 130 files.
- `lint`, `knip:gate`, `design:guard`, `contrast:gate`, `persona:gate`: green, no baseline widened.
- No change to any audio path, provider selection, failover chain, or persisted call outcome. The only behavioural deltas are the values written to `turn_latency.tts_first_byte_ms` and `call_latency.tts_first_byte_ms`.

## Consequences

- Dashboard TTS p50 will drop by roughly the LLM TTFT (~1.4 s) at the next call. That is a measurement correction, not an improvement, and must not be reported as one.
- Any pooled query spanning 2026-08-12 returns a meaningless `tts_first_byte_ms` distribution. `org-queries.ts` percentiles are computed over a rolling window, so this self-heals once the window clears the cutover; until then those percentiles are bimodal.
- The cache-hit path records `ttsFirstByteMs = 0` and now also stamps `turnFirstAudioAt`, without which v2v would have gone null on every cached turn — a regression this change would otherwise have introduced silently.
- Still unmeasured: STT finalization lag before `speechFinal` fires. The ~127 ms dispatch residue is the floor we can see, not the caller's true floor.
- Out of scope: acting on the corrected numbers. Direct-Groq as a second LLM transport is deferred to its own ADR, and this one is a precondition for judging it.

## Rejected

- **Adding a second column and leaving the old one.** Two columns with near-identical names, one permanently wrong, is a trap for whoever reads this table next. Justified only if real customer history depended on the old semantics; none does.
- **Deleting the 78 pre-cutover rows to make the column uniform.** A destructive production write to tidy a column, when a dated doc comment conveys the same thing and preserves the evidence this ADR is built on.
- **Anchoring on the TTS socket-open instant.** Would have excluded connect time from the TTS budget and understated a real provider cost — the same class of error being fixed here, in the other direction.
- **Keeping `voiceToVoiceMs`'s derived formula and just swapping the anchor variable.** Works, but leaves the caller-truth metric depending on an internal accounting choice that has now been wrong once.
- **Trusting the numbers and optimizing TTS.** The path the uncorrected dashboard pointed at. Recorded because it was the plan of record until these rows were read side by side.
