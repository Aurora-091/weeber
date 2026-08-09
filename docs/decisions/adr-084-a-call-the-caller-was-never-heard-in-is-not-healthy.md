# ADR-084: A call the caller was never heard in is not healthy

- **Status:** Accepted
- **Date:** 2026-08-09
- **Relates to:** ADR-082 (a transfer outranks a hangup), ADR-083 (idle TTS socket ≠ broken provider). Same defect family: the call went wrong and every metric said it was fine.

## Context

`classifyCallHealth` took `transcriptCount` — total transcript rows, **both
roles combined**. That total cannot distinguish a two-sided conversation from
the agent talking to itself.

The production call that exposed this (call id 21, 2026-08-09, 54s): the model
emitted `transferToHuman` and `hangUp` in the same turn, the old code honoured
the hangup, and the caller was cut off immediately after being told "let me
connect you with a licensed advisor right now". The row that call wrote:

- `status = completed`
- `disposition = booked`
- three agent turns, transcript rows present
- every latency metric green

Health verdict: **healthy**. The existing greeting-only rule requires
`turnCount <= 1` and no disposition, so a multi-turn call with an outcome sailed
through. The one signal that would have caught it — the caller never said a
word — was averaged away inside the combined total.

Two separate failures were hiding in that shape:

1. **One-sided call.** The agent got past its greeting and produced audio, but
   no caller utterance was ever transcribed. Either STT stopped delivering
   finals, or the agent talked over / hung up on the caller.
2. **Fabricated outcome.** A `disposition` was recorded on a call in which the
   caller never spoke. This is the more dangerous of the two: every funnel and
   disposition dashboard counts it as a success, so it inflates precisely the
   metrics a pilot customer judges us on — and a `booked` / `qualified`
   disposition can push a lead to a human closer carrying facts no caller ever
   confirmed. In the insurance vertical that means a licensed advisor opening a
   call on qualifying answers nobody gave.

## Decision

Add `callerTranscriptCount` to `CallHealthInput`, tracked separately in
`stream.ts` (`logTranscript` already receives `role`, so this is a single
increment — no extra query, no schema change).

Two new silent-failure rules:

- **One-sided call** — `callerTranscriptCount === 0 && turnCount > 1 &&
  ttsFirstByteMs !== undefined`. Scoped to calls that got past the greeting and
  produced audio, so it does not overlap the greeting-only degraded rule.
- **Outcome not evidence-backed** — `hadDisposition &&
  callerTranscriptCount === 0`. Deliberately *not* gated on `turnCount`: the
  disposition, not the turn count, is what makes the row harmful, so a
  single-turn call that still recorded an outcome is flagged.

Both classify as `silent-failure` rather than `degraded`. A call whose recorded
outcome is unsupported by any caller speech is not a quality blemish, it is bad
data entering the funnel.

Calls that never connected are unaffected — the existing `!answered` early
return precedes both rules, and zero caller rows there is expected.

## Consequences

- `silent-failure` counts will rise. That is detection starting to work, not
  reliability regressing.
- Insurance dispositions become falsifiable: a `booked` with no caller speech is
  now visibly broken instead of being counted as a win. This is what makes
  pilot metrics safe to show a customer.
- The one-sided rule will also catch genuine STT delivery faults that previously
  presented only as "the agent seemed to ignore the caller" — a defect class we
  had no signal for.
- ADR-082's fix means the specific call-21 hangup shape should no longer occur.
  This rule is the detector that tells us if it does, or if something else
  produces the same shape. Fixing the cause and keeping the detector are not
  alternatives.

## What this does not fix

- **The zombie-turn question is now moot as a diagnostic.** Whether call 21 ran
  a turn *after* `finalizeCall` (phantom post-hangup transcript/tool rows) was
  going to be settled from a Railway log grep; that has been dropped in favour
  of evidence from a fresh call on corrected prompts. If phantom rows exist they
  would inflate `callerTranscriptCount` and could mask this rule — revisit by
  gating `logToolCall`/`logTranscript` on `ended` if a future call shows
  transcript rows timestamped after `ended_at`.
- **Caller speech is evidence of a two-sided call, not of consent or of an
  accurate outcome.** This rule cannot tell whether a disposition matches what
  the caller actually said. Semantic outcome verification is out of scope.

## Tests

`packages/api/src/voice/call-health.test.ts`, new describe block (6 tests):
one-sided multi-turn call, disposition with no caller speech, fabricated outcome
on a short call, never-connected call unaffected, greeting-only not
double-flagged, and healthy as soon as the caller is transcribed once.

Full suite green at 1150 pass / 0 fail (1005 api + 74 web + 71 compliance).
