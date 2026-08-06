# ADR-074: Clearing a timer does not cancel a timeout that already fired

- **Date:** 2026-08-06
- **Status:** Accepted
- **Supersedes / relates to:** ADR-071 (ending a call is a local guarantee)

## Context

The agent hung up on a caller who was answering. This is not a hypothesis — it is two adjacent rows in
production `transcripts`, on call 16, **38 milliseconds apart**:

```
16:16:22.239  caller  "Yes."
16:16:22.277  agent   "I haven't heard back, so I'll go ahead and end the call here.
                       Feel free to call back anytime. Goodbye."
```

The caller-silence machinery is a two-stage timer in `voice/stream.ts`. After 8s of quiet the agent
re-prompts ("Are you still there?"); after another 7s it says goodbye and hangs up. `armSilenceTimer`
schedules `handleSilenceTimeout`, and the STT handler cancels it the moment a caller utterance is
consumed:

```ts
silenceWarningIssued = false;
clearSilenceTimer();
```

That cancellation is only sound while the timeout is still *pending*. Once the timer has fired,
`clearTimeout` on an already-elapsed handle cancels nothing, and `handleSilenceTimeout` is already
running — suspended inside `await speakCannedLine(...)`, which is not instant: it reads feature flags,
may consult the TTS cache, and then runs a full `speak()` turn through the provider. The whole hangup
decision was made *before* that await and acted on *after* it, with no re-check in between. Any caller
speech arriving inside that window was recorded to the transcript and then ignored.

So the window is the entire duration of synthesizing and sending a spoken line — hundreds of
milliseconds to seconds, on every single silence timeout. Call 16 landed in it. This is a race that gets
hit, not a theoretical one.

Two attempted-fix shapes had to be rejected before the right one was clear:

- **Check `silenceTimer === null` after the await.** Does not work. `speak()` re-arms the silence timer
  on its own tail (`else if (!ended) armSilenceTimer(ws)`), so by the time the canned line finishes,
  `silenceTimer` is non-null again regardless of what the caller did.
- **A timer-generation counter bumped by `clearSilenceTimer()`.** Does not work, for the same reason:
  the canned line spoken *by* `handleSilenceTimeout` re-arms the timer and therefore bumps the counter
  itself. A post-await generation check would abort every timeout, including the legitimate ones, and
  no caller would ever be hung up on.

The signal has to be **caller speech**, not timer state.

## Decision

Introduce `callerSpeechEpoch`, a monotonic counter in the stream closure.

- The STT handler bumps it via `recordCallerSpeech()` at the one place a caller utterance is consumed as
  a real end-of-turn — immediately beside the existing `silenceWarningIssued = false; clearSilenceTimer();`
  reset.
- `armSilenceTimer` captures the current value and threads it into `handleSilenceTimeout(ws, armedAtEpoch)`.
- `handleSilenceTimeout` checks `ended || callerSpeechEpoch !== armedAtEpoch` **at entry and after every
  await** — before re-arming in the warning branch, and before `performHangUp` in the hangup branch.

An in-flight timeout therefore abandons itself the moment the caller turns out to have been talking. The
already-spoken line is not retracted (it cannot be), but the call is not ended.

**Only that one call site bumps the epoch.** The barge-in block, a few lines above, deliberately does
not — and this is the load-bearing constraint, not an oversight. Aborting a timeout leaves no silence
timer armed, and that timer is the only backstop against a call that stays open forever; there is no
max-duration cap anywhere in the stack. The end-of-turn site is safe to abort from because every path
below it re-arms: the mid-thought branch calls `armSilenceTimer` explicitly, and everything else reaches
`speak()`, whose tail arms it. The barge-in block offers no such guarantee — it fires on interim text
that may never be followed by a `speechFinal`, so bumping there could trade a wrong hangup for an
immortal call. That is a worse failure, so it is not taken.

## Consequences

- A caller who answers during the goodbye line stays connected. The proven production failure is closed.
- The re-prompt/hangup escalation is unchanged for a genuinely silent caller — pinned by a second test so
  the fix cannot be "achieved" by disabling the feature.
- The residual gap is explicit: a caller who barges in with interim speech that never reaches
  `speechFinal`, entirely within the goodbye window, is still hung up on. Narrower than what was fixed,
  and closing it requires the backstop question above to be answered first (most likely a hard
  max-call-duration cap, at which point barge-in can safely bump too).
- `voice/stream-silence-timeout.test.ts` drives the real state machine with fake timers across both
  stages, gating `getEffectiveFlags` to place caller speech precisely inside the await the race lived in.
  Verified to fail against the pre-fix `stream.ts` and pass after.

## Alternatives considered

- **Make `speakCannedLine` non-interruptible and just accept the race.** Rejected: the observable
  behaviour is the agent hanging up on a paying customer mid-sentence. There is no framing in which that
  is acceptable.
- **Check a boolean `callerSpokeRecently` flag instead of a counter.** Works for one timeout but is
  ambiguous across nested/overlapping arms — a counter compared against a captured value says exactly
  "did anything happen since *this* timer was armed", which is the actual question.
- **Shorten `speakCannedLine` so the window is small.** Shrinks the race, does not remove it, and trades
  a correctness fix for a latency gamble against TTS provider variance.
- **Abort the canned line itself on caller speech.** Barge-in already cuts the audio; the bug is not that
  the line plays, it is that the hangup follows. Fixing the audio path would have left the hangup intact.
