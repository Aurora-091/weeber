---
adr: 101
title: A reply too short to trip the buffer was never spoken
date: 2026-08-12
status: Accepted
supersedes: none
amends: ADR-100 (retracts its "10/78 turns produced no audio" framing — 9 of the 10 are correct barge-in aborts), ADR-082 (third defect found in the same expressive-delivery feature)
related: ADR-082, ADR-083, ADR-090, ADR-100
---

# ADR-101 — A reply too short to trip the buffer was never spoken

## Status

**Accepted and implemented on 2026-08-12.** Two files under `packages/api/src/voice/`
(`tone-tags.ts`, `stream.ts`) plus 10 new tests. No schema change, no compliance change, no ratchet
widened.

## Context

ADR-100 deferred one item as "needs its own investigation": *10 of 78 `turn_latency` rows reserved a
turn index and recorded no TTS first byte*, described there as dead air. That description was wrong,
and the investigation is the point of this ADR — because collapsing ten rows into one label is what
hid the single real defect among them.

### The ten rows are not one thing

Reconciling every `turn_latency` row against the `transcripts` rows for the same call, by turn order:

| class | rows | what actually happened |
| --- | --- | --- |
| all three columns NULL | 9 | The caller kept talking and aborted the in-flight turn **before the first LLM token**. Correct behaviour. |
| `llm_ttft_ms` set, `tts_first_byte_ms` NULL | 1 | The LLM produced text. TTS was handed **nothing**. The caller heard silence. |

The 9 are provable rather than inferred. Call 25 has 27 turn rows and 23 agent transcript lines; the
4 all-NULL rows are exactly the 4 turns with no agent line at all, and each sits between two caller
lines under 1.5s apart — e.g. caller "Made of both." at 16:11:38.656, turn 2 opens, caller "But go
ahead." at 16:11:39.176, turn 2 dies with nothing, turn 3 speaks. Same shape in call 24 (turns 5, 14,
15) and at the tail of calls 16 and 17 where the caller stopped answering. Barge-in cancelling a turn
the caller no longer wants is the feature working.

A separate benign class was also miscounted into the "no LLM ran" bucket: 8 rows with `llm_ttft_ms`
NULL and `tts_first_byte_ms` around 405–439ms are the `speakCannedLine` re-prompt and goodbye lines
("Are you still there?"). No LLM is *supposed* to run on those.

### The one that is real

Call 21, turn 3, 2026-08-09: `llm_ttft_ms = 2779`, `tts_first_byte_ms = NULL`, transcript line
`"OK."` recorded as spoken by the agent, followed immediately by the transfer. The caller heard
nothing and was handed off.

The cause is in the tone-tag filter (ADR-082's feature). `sendTtsTextWithTone` holds streamed deltas
back until it can decide whether a leading `[[tone:value]]` marker is present, because that marker
arrives split across deltas and half a tag must never be spoken. It released the buffer on the first
of three conditions: a complete tag matched, any `]]` seen, or 24 characters accumulated.

There is no fourth condition for *end of stream*. A turn whose entire text is shorter than 24
characters and contains no `]]` satisfies none of the three, so when `generate()` returned, the
buffer was still holding every character of the reply. `tts.endTurn()` then found `realTts ===
undefined` (ADR-083's lazy connect — no socket, because no text was ever sent), took its
"turn produced no speakable text at all" branch, and resolved the turn cleanly. Nothing errored.
Nothing logged. The transcript recorded the line as said.

Exposure is every short reply the model does not tag: *"Sure, one moment."* *"Got it, thanks."*
*"OK."* The tone instruction in `agent.ts` is unconditional, so in the common case the model emits
`[[tone:calm]]`, `]]` appears, and the buffer releases — which is why this is 1 turn in 78 and not
1 in 5. It is a model-compliance-dependent silent mute, and `gemini-3.1-flash-lite` skipping a
formatting instruction on a 3-character reply is not an exotic failure to plan for.

This is ADR-090's defect class in its purest form. The filter was a closure inside a 2000-line
`stream.ts`, reachable by no test; `tone-tags.test.ts` covered `stripToneTag` (the pure function) and
never the buffering built on top of it. It is also the **third** defect in this one feature: ADR-082
found `setTone` silently unwired for months, ADR-083 found its socket lifetime burning the failover
chain, and now the text path itself.

## Decision

**1. `flush()` — the missing release condition.** The state machine moves out of `stream.ts` into
`tone-tags.ts` as `createToneTagFilter({ onTone, onText })` with `push(delta)` and `flush()`. Behaviour
of the three existing release conditions is unchanged. `flush()` releases whatever is still held, strips
a tag if one is there, returns the text it emitted (`""` when nothing was pending), and is idempotent.

`speak()` calls it in the `finally` block **before** `tts?.endTurn()`, and warns when it actually
rescued something — a flush that emits text means the model skipped the tag it was asked for, which is
worth knowing separately from the fix.

**Not called when the caller barged in.** That text was correctly abandoned; speaking it after an
interruption would talk over someone who just interrupted. Dead air on an aborted turn is the right
outcome.

A malformed partial tag (`"[[tone:calm"` with no close) is flushed **as-is** and spoken. Audible
garbage beats silence: it is a model defect either way, and the version that a human can hear is the
version that gets reported.

**2. The alarm that was missing.** `speak()` now logs `console.error` with `DEAD AIR on turn N` when a
turn produced text and TTS emitted zero audio bytes, excluding barge-ins. Until now that condition was
recorded only as a `NULL` in `tts_first_byte_ms`, indistinguishable from the three benign reasons that
column is NULL — which is precisely why this sat in production unexamined and why ADR-100 mislabelled
all ten rows.

**3. The extraction is part of the fix, not tidying.** The buffer stays testable at the unit level
because untestable placement is how the bug survived, and 10 tests now cover it — split-delta tag
stripping, cap release, post-resolution passthrough, unknown tone values, and five `flush()` cases
including the exact call-21 reproduction.

## Rejected alternatives

- **Drop the hold-back entirely; strip the tag from `fullText` after the fact.** `fullText` only exists
  once the LLM has finished. Streaming to TTS is what makes the agent start talking before the model
  stops, and giving that up costs every turn ~1s of the p50 to fix 1 turn in 78.
- **Lower `TONE_TAG_MAX_BUFFER_CHARS` so short replies trip the cap.** The cap must exceed the longest
  valid tag (`[[tone:empathetic]]`, 19 chars) or valid tags get spoken aloud. Any cap has replies
  shorter than it; this only moves the boundary.
- **Require the tag and retry the turn without it.** A retry doubles the latency of the exact turns
  already at the top of the tail, to fix formatting the caller cannot hear.
- **Add a `turn_outcome` column to `turn_latency` instead of a log line.** The right long-term answer
  and additive-safe, but it needs the outcome taxonomy this ADR is the first to establish
  (aborted-pre-token / canned line / tool-only / real failure). Logged now, columned when the taxonomy
  has survived contact with more than 11 calls.

## Consequences

- Short untagged replies are spoken. The transcript stops claiming lines that were never audible.
- Any future total-TTS-silence turn announces itself in the logs instead of hiding in a NULL.
- ADR-100's deferred item #2 is closed; its "10/78 turns produced no audio" phrasing is retracted here
  rather than edited there, per ADR-078's precedent.
- Still deferred, still unearned: the LLM TTFT fat tail (needs per-request gateway timing),
  Cartesia-vs-ElevenLabs first-byte at n=2, and any write to production data.
- Unresolved and *not* addressed here, but visible in the same reconciliation: the silence re-prompt
  fired 3 times in call 25 alone, and on each one the caller answered within ~3s of being asked "Are
  you still there?" — the agent is interrupting people who are thinking. That is a timer-tuning
  judgement call on n=1 call, not a fix to make silently.

## Verification

`packages/api` `tsc --noEmit` ✓ · `bun run test` **1146 pass / 0 fail** (124 files, 3101 expects) ·
root `bun run lint` 0 warnings / 0 errors (481 files) · `bun run knip:gate` OK, baseline
**61 → 61 unchanged** · `design:guard` and `contrast:gate` unchanged (no `packages/web` files touched).
