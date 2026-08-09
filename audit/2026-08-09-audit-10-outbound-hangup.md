# Audit 10 — PSTN calls self-terminate mid-greeting

**Date:** 2026-08-09
**Scope:** root-cause diagnosis of "outbound call drops right after the greeting"
**Evidence:** production Supabase (`calls`, `transcripts`, `call_latency`) + Railway logs + source at `cf929b0`
**Status:** root cause confirmed against production data. No code changed.

---

## Verdict

**The agent hangs up on itself.** The caller-silence timer is armed when TTS finishes
*sending* audio, not when Twilio finishes *playing* it. Any turn longer than 8 seconds of
speech therefore guarantees a false "caller is silent" verdict while the caller is still
listening to that very turn.

AMD is **not** the cause. My earlier source-level hypothesis (Twilio `DetectMessageEnd`
redirecting live calls out of the media stream) is **dead** — see "Hypotheses killed" below.

Failure rate in production: **6 of 6 calls. 100%.** Inbound and outbound. Every call in the
database has ended this way, including the one from 2026-07-18.

---

## The proof

Call 20 (`CAd65a76cd8922196585edbfc6dd2926e3`, outbound, 2026-08-09 13:41):

| Event | Timestamp | Δ |
|---|---|---|
| `started_at` | 13:41:01.371 | — |
| first audio to caller (`pickup_to_first_audio_ms` = 2037) | ~13:41:03.4 | +2.0s |
| greeting turn finishes **sending** (transcript row) | 13:41:03.860 | +2.5s |
| "Are you still there?" | 13:41:12.128 | **+8.27s** ⟵ `SILENCE_WARNING_MS = 8000` |
| "I haven't heard back… Goodbye." | 13:41:19.393 | **+7.27s** ⟵ `SILENCE_HANGUP_MS = 7000` |
| `ended_at` | 13:41:20.666 | total **19.3s** |

Now count the audio the agent queued, using the codebase's own playback estimator
(`estimateRemainingPlaybackMs`, `stream.ts:70` — 55 ms/char):

| Turn | chars | est. playback |
|---|---|---|
| greeting | 217 | **11.9s** |
| "Are you still there?" | 59 | 3.2s |
| goodbye | 102 | 5.6s |
| **total** | | **20.7s** |

**20.7 seconds of speech was queued into a 19.3-second call.** That is physically
impossible over a realtime 8 kHz μ-law stream. The server was generating turns far ahead of
what the caller could possibly have heard, and it killed the call before its own greeting
had finished playing. The caller never got a gap to speak into — there was nothing wrong
with their audio, their line, or STT.

### The independent confirmation

Call 16 is the same agent, same greeting, and the caller *did* speak:

```
10:46:06.751  agent   "…Hi, this is Alice calling from Krisn — you'd recently
                       shown interest in insurance. Do you have a couple of minutes?"  (217 ch)
10:46:15.016  agent   "Are you still there? Let me know if you need anything else."     (59 ch)
10:46:22.239  caller  "Yes."
10:46:22.277  agent   "I haven't heard back, so I'll go ahead and end the call here…"
```

The caller answered **38 ms** before the goodbye line. Predict when they *heard* the
question: greeting queued at 06.751 + 11.9s playback + 3.2s warning playback = **10:46:21.9**.
They spoke at 10:46:22.239 — **~0.3s later.** A human responding instantly.

The caller was never silent. They were ~15.5 seconds behind the server's model of the call,
because the server's model of the call is wall-clock-from-send and the caller's reality is
audio playback.

Call 17 is the third confirmation: the caller barged in with "Hello?" 0.4s after the greeting
was *sent* (i.e. during its first second of playback), got an 8.5s reply, and was then hit
with the same 8s→7s silence sequence.

---

## Why the browser test call works

`voice/test-call-stream.ts` contains **no silence timer at all** — `armSilenceTimer`,
`SILENCE_WARNING_MS` and "Are you still there?" appear nowhere in that file (verified by
`rg`). The web preview cannot exhibit this bug. It was never evidence that the agent worked;
it was evidence that the preview path skips the code that breaks.

This is the more important structural finding: **the two paths do not share a turn-lifecycle
state machine**, so the surface you test on is not the surface you ship on.

---

## Mechanism, precisely

`stream.ts:1395-1401`, tail of `speak()`:

```ts
} else if (!ended) {
  armSilenceTimer(ws);
}
```

`speak()` resolves when the TTS provider reports it has sent every chunk (`resolveTtsDone`,
`stream.ts:1186-1189`). Cartesia streams a 12-second line in ~1-2 seconds of wall clock.
Twilio then plays it at realtime. So `armSilenceTimer` starts an 8-second clock at the moment
roughly **10 seconds of unplayed audio is still in flight**.

The code already knows this is wrong. `estimateRemainingPlaybackMs` exists precisely to
avoid cutting off a closing line — and it is applied on the `hangUp`/`transfer` path
(`stream.ts:1381-1383`) but **not** on the silence-arming path two lines below. The knowledge
was there; it was applied to one branch and not the other.

Secondary defect: `estimateRemainingPlaybackMs` is `Math.min(…, 4000)`. Even where it *is*
used, it caps at 4 seconds, so an 11.9-second closing line is still cut off. The 4s ceiling
is wrong for any turn over ~73 characters.

Also note `stream.ts:428`'s comment — *"this timer is the only backstop against a call that
stays open forever (there is no max-duration cap)"*. That is why this timer cannot simply be
deleted; it is currently load-bearing for cost control.

---

## Your Railway log line — related, and it makes it worse

```
[voice] system prompt contained 7 unresolved merge tag(s) — stripped before send:
{{company_name}}, {{agent_name}}, {{lead_name}}, {{interest_area}},
{{lead_source}}, {{reschedule_date}}, {{reschedule_time}}
13:41:04.543
```

It is **not** the cause — it is a `console.warn` in `merge-tags.ts:102-110` that strips text
and returns; it never ends a call. (Railway tags it `severity: error` because `console.warn`
goes to stderr. Worth fixing on its own — it means every real error in your logs competes
with cosmetic warnings.)

But it is a **direct aggravator**, and it is the same call, 0.7s after the greeting:

1. `stream.ts:1867-1877` only uses the fast literal greeting if **every** `{{tag}}` resolves.
   Seven tags did not resolve → `literalGreetingText` stays `undefined`.
2. So the call fell through to `runVoiceAgentGreeting` — the LLM path.
3. The LLM produced a **217-character** greeting. The audited literal template would have
   been shorter and deterministic.
4. 217 chars × 55 ms = 11.9s > the 8s timer. **The bug fires.**

So the merge-tag failure is what pushed this specific agent's greeting over the silence
threshold. A shorter greeting would have masked the timer bug — which is exactly why this
looks intermittent and agent-specific rather than systemic.

Root cause of the merge-tag failure itself: `greetingContext` (`stream.ts:1869-1873`) is
built from `capturedState` + `agent_name` + `merchant_name`/`company_name` only. `calls.captured_state`
is `{}` on **all six** production calls, and `lead_name`/`interest_area`/`lead_source`/
`reschedule_date`/`reschedule_time` are never populated from the `leads` row — even though
call 20 has `lead_id = 1`. The outbound workflow attaches a lead to the call but never binds
that lead's fields into the prompt context.

Note `{{company_name}}` and `{{agent_name}}` were *also* reported unresolved, and those two
*are* set in `greetingContext` — so the failure is not only missing lead data. That warning
comes from `scrubSystemPrompt` on the **system prompt**, a different render path from the
greeting template. Two separate unresolved-tag surfaces, one of them not fed at all.

---

## Hypotheses killed by the data

| Hypothesis | Killed by |
|---|---|
| Twilio async AMD redirecting the live call | No call has AMD's canned line ("sorry to have missed you") in `transcripts`. All six end with the silence goodbye. Inbound call 15 — which never goes through `place-outbound-call.ts`, so never gets AMD — fails **identically**. |
| Caller audio never reaching STT / no inbound media | Calls 16 and 17 have `caller` transcript rows. STT works. `stt_reconnect_count = 0` everywhere. |
| STT/TTS/LLM provider failure | `provider_failover_count = 0` on all six. `call_latency` is healthy throughout: `stt_connect_ms` 552-785, `llm_ttft_ms` 1299-1594, `pickup_to_first_audio_ms` 1770-2094. Nothing is slow. |
| Max-duration timer / `NUMBER_CONFIG` | Durations are 12.5s / 19.2s / 19.3s / 19.8s / 20.4s / 21.6s — not a fixed cap. They are `greeting_playback_estimate + 15s`, which varies with greeting length exactly as this bug predicts. |
| Telephony/carrier issue | `status = completed`, `ended_at` set cleanly, `recording_url` present on all six. The app hung up deliberately. |
| Health monitoring would have caught it | `health_status = healthy` on all six calls, with `health_reasons = []`. **This is the worst finding in this document.** |

---

## The monitoring failure

Every one of these calls is recorded as `healthy`. A 100%-failure product self-reports as
fully operational. `call-health.ts:159-167` flags "greeted but no conversation followed and
no outcome was recorded" — yet calls 18, 19 and 20 have **zero** caller transcripts, empty
`disposition`, empty `intent`, empty `sentiment`, `captured_state = {}`, and still scored
healthy. Either the check isn't reached on this path or its conditions don't match reality.

Audit 09 flagged "detection-without-notification" across health/spend/scheduler. This is
worse: **detection that returns the wrong answer.** Fixing the timer without fixing this
means the next silent failure is equally invisible.

Also: `tool_calls` is **empty**. Zero rows, ever. No agent has ever successfully called a
tool in production — `setDisposition`, `captureField`, `hangUp`, none. Consistent with no
call ever reaching a second conversational turn, but it should be verified independently
rather than assumed to be downstream of this bug.

---

## Fix proposal (not applied — your call)

### P0 — stop arming the silence timer against unplayed audio

Two options.

**(a) Estimate-based — one line, ships today, still a guess.**
Delay arming by the remaining playback estimate:

```ts
} else if (!ended) {
  const waitMs = estimateRemainingPlaybackMs(fullText);
  setTimeout(() => { if (!ended) armSilenceTimer(ws); }, waitMs);
}
```

…and **remove the 4000 ms ceiling** from `estimateRemainingPlaybackMs`, or it under-waits on
exactly the long turns that trigger this. Keep the floor. The 55 ms/char constant is itself
unvalidated — it should be calibrated against real Cartesia/Sarvam output, per voice.

**(b) Mark-based — correct, and what I'd actually ship.**
Twilio Media Streams supports `mark` messages: send a `mark` after the last audio chunk of a
turn, and Twilio sends a `mark` event back **when playback of that audio actually completes**.
Arm the silence timer on that event. This replaces an estimate with ground truth and also
fixes the closing-line truncation on the `hangUp` path.

`rg` confirms **no `mark` handling exists anywhere** in `voice/`. This is the real gap: the
system has no idea what the caller has actually heard. Every latency metric, barge-in
decision, and turn-boundary judgement in the pipeline inherits that blindness. Fix (a)
patches the symptom; fix (b) removes the class of bug. Note Plivo/Exotel need their
equivalent (or fall back to (a) behind the transport abstraction).

### P0 — make the two stream paths share one turn lifecycle

`test-call-stream.ts` diverging from `stream.ts` is why this shipped. Until the silence
timer, hangup, and turn-boundary logic are shared, the preview will keep certifying builds
that cannot complete a phone call. This is an architectural fix, not a patch.

### P1 — bind lead data into the greeting and system prompt context

Populate `greetingContext` (and the system-prompt render path) from the `leads` row via
`calls.lead_id`. Then decide deliberately what an unresolved tag should do: today it silently
downgrades to a slower, longer, non-audited LLM greeting. For a compliance-sensitive
insurance script, a *silent* substitution of audited wording is a compliance problem in its
own right, independent of latency.

### P1 — fix the health check, then re-verify

A call with zero caller transcripts and no disposition must not be `healthy`. Until this is
true, you have no instrument. Backfill-recompute the six existing calls as a test of the fix.

### P2 — `console.warn` → structured `warn`, not stderr

So Railway's `severity: error` means something. Otherwise real errors drown.

---

## What to do next, in order

1. Pull `RE249339dc93e1b6eb3ba989df2ae81b02.mp3` (call 20's recording) and listen. You should
   hear the greeting talked over by "Are you still there?" at ~8s. That is the whole bug,
   audible, in 20 seconds. **Do this before writing any code** — it either confirms this
   document or falsifies it immediately.
2. Apply fix (a) + remove the 4s cap. Place one call. Expect a real conversation.
3. Then do (b) properly, plus the health check.

## Confidence

**High** on the mechanism — the 20.7s-of-audio-in-a-19.3s-call arithmetic and call 16's
38 ms near-miss are hard to explain any other way, and every alternative hypothesis is
contradicted by a column in the database.

**Not yet verified:** that the recording sounds like this document predicts (step 1), and
that the 55 ms/char constant matches real Cartesia output. Both are cheap to check and both
would change the fix if wrong.

**Sample size is 6 calls, all internal, mostly to one number (+919359848364).** This is a
real, reproducible, 100%-of-known-traffic bug — but "100%" here means six calls, not six
hundred. It has never been exercised by a stranger on an unknown handset.
