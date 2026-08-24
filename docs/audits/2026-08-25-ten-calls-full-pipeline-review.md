# Ten calls, full pipeline — latency, VAD/endpointing, turn-taking, state integrity, and two root-caused defects

- **Date:** 2026-08-25
- **Source:** production Supabase (`qghtkadxbtptvbfbmsdz`, `aws-... ap-northeast-1`), read-only, via `mcp__supabase__execute_sql`
- **Scope:** every row in `calls`, `call_latency`, `turn_latency`, `transcripts`, `tool_calls`, `guardrail_events` at
  time of reading — 10 calls total (up from the 2 the 2026-08-21 audit read four days earlier)
- **Repo state:** `main` @ `cedb45c` at query time; two defects found here are fixed in this same session,
  landing after this file
- **Class:** dated point-in-time artifact (ADR-118 class 2). Not a plan. Supersedes nothing — extends the
  2026-08-21 audit with 8 new calls it could not have seen, and corrects one of its findings (VAD/endpointing)
  with more data.

## Why this exists

Phase C4 was blocked pending "real post-A3 production call data," reported as not existing. It does: 8 new
calls landed 2026-08-24 (four days after the last audit), unpushed from this session's own git log, on a
new org ("good insurance") that wasn't in the system on 2026-08-21. This is the actual read of that data —
plus two real defects it surfaced, root-caused and fixed in the same session.

## Inventory

| | Old data (2026-08-21 audit) | This read |
|---|---|---|
| `calls` | 2 | **10** |
| `turn_latency` rows | 31 | **76** |
| `transcripts` rows | 54 | **122** |
| `tool_calls` rows | 24 | **~62** |
| `guardrail_events` | 0 | **6** |
| orgs represented | 1 (HDFC) | **2** (HDFC + "good insurance") |

Calls 1-2 are the original HDFC calls (2026-08-20, pre-A3, already audited — unchanged, included here only
for pooled stats). Calls 3-9 and 11 (call 10 doesn't exist — an identity gap, not evidence of anything)
are new: org "good insurance," same `insurance` vertical, all outbound to the same `+91` number, all
2026-08-24 between 11:39 and 12:49 UTC. **None of this session's own Phase C1-C4 work is deployed** — this
session's commits are 6 ahead of `origin/main`, and A3 (`c858d56`) is the newest commit actually on
`origin/main`. So this data is genuinely post-A3, pre-everything-this-session-shipped.

## Latency, pooled across all 76 turns

| metric | p50 | p95 | min | max |
|---|---|---|---|---|
| `voice_to_voice_ms` | 1613 | 3442 | 944 | 4846 |
| `llm_ttft_ms` | 1259 | — | — | — |
| `tts_first_byte_ms` | 361 | — | — | — |
| `tts_socket_open_ms` | 207 | — | — | — |

Consistent with the 2026-08-21 baseline (p50 ≈1750, p95 ≈4500) — slightly better, not meaningfully
different, and expected: none of this session's C1 (TTS session reuse) or C2 (cache-prefix fix) is live.
`tts_socket_open_ms` p50 of 207ms is the pre-C1 per-turn-reconnect cost, present on essentially every turn
— this is the number C1 targets, and it's still there because C1 hasn't shipped to production yet.

**Provider mix, uniform across all 10 calls:** LLM `gateway/google/gemini-3.1-flash-lite`, TTS `cartesia`,
STT `deepgram`. No failover observed in this sample.

## Finding 1 — the VAD/endpointing conclusion from 2026-08-21 needs a correction

The prior audit's Finding 1a says: *"`endpoint_signal` is `speech_final` on all 26 turns that recorded
one. `utterance_end` never fired once."* That was true of the 26-turn sample it had. It is not true of 76:

| `endpoint_signal` | count |
|---|---|
| `speech_final` | 45 |
| `utterance_end` | **16** |
| `null` (greeting turns, aborted turns) | 15 |

**`utterance_end` fired on 16 of 61 signalled turns — 26%, not 0%.** All 16 are on the new org's calls
(3-9, 11); the original two calls still show 0 (consistent with the prior read, since those rows didn't
change). This reopens, but does not by itself resolve, ADR-063's gate (a) — "evidence of callers being cut
off." `UtteranceEnd` firing is not proof of a cut-off; Deepgram's own docs describe it as a legitimate
second signal for genuinely-finished speech that `speech_final` missed, not exclusively a symptom of
premature endpointing. What changed the number is more calls and a different org/template mix, not a code
change to `stt/deepgram.ts` (untouched since 2026-08-12). **Correction, not a reversal:** this doesn't
mean the semantic-turn-detection refiner should be built — it means "the answer is no" (2026-08-21's
conclusion) should go back to "unproven either way," and the next step if this matters is reading whether
any of the 16 `utterance_end` turns actually correspond to a caller who kept talking and got answered on a
fragment (the real failure mode), not just counting which signal fired. Not done here — flagged, not
chased, to stay in scope.

`endpointing_delay_ms` p50 is still 13ms, max 22ms — the signal itself remains cheap regardless of which
path fires it.

## Finding 2 — the terminal-turn spike is real but partial, and it's captureField batching, not a mystery

C4 step 1 asked: do post-A3 calls still show a terminal-turn latency spike? Per-turn data for the 6 calls
with turn rows (3-8):

| call | slowest turn | is it the last turn? | output tokens on that turn |
|---|---|---|---|
| 3 | turn 6 of 7 | no | 238 |
| 4 | turn 3 of 3 (terminal) | **yes** | 69 (unremarkable — this call's terminal turn is actually its *fastest*) |
| 5 | turn 3 of 6 | no | 73 |
| 6 | turn 11 of 12 | no (turn 12 is a null/aborted tail) | **413** |
| 7 | turn 4 of 4 (terminal) | yes, but it's the *fastest* turn of the call | 119 |
| 8 | turn 7 of 7 (terminal) | **yes** | 276 |

**2 of 6 (calls 6, 8) clearly reproduce the spike; call 4 and call 7's terminal turns are their fastest.**
A3's prompt-only fix reduced but did not eliminate the pattern. The mechanism is now directly visible,
not inferred: call 6's `captured_state` shows `tobacco`/`income_type`/`banking_ready`/`budget_comfort`/
`service_preference` — 4 of 5 fields — all stamped `"turn": 11`, the exact turn with 413 output tokens and
the call's worst `voice_to_voice_ms` (3453ms). **The model batched four `captureField` calls into one turn
near the end of the call, despite A3's "call this immediately" instruction, and that turn is the latency
spike.** Call 8's two captured fields are spread across turns 4 and 7 — A3 working as intended there. So
the same call sample shows A3 both working and not working, which is exactly why C4's plan text made step
2 (a structural per-turn tool-call cap) conditional on this measurement rather than assumed.

**This does not yet justify building the cap** — n=2 calls showing the pattern, out of 6, is real evidence
but still thin, and the cap is the highest-risk change available in this phase (see the C3/C4 commit's
reasoning on ADR-082/-105/-106/-115). It does mean the plan's own "if the model still batches" condition is
now partially confirmed rather than fully open.

## Finding 3 — an 8.5-second gap in `pickup_to_first_audio_ms` that no component metric explains

Call 3: `pickup_to_first_audio_ms` = **10,487ms**. Its own components: `stt_connect_ms` 209, `llm_ttft_ms`
720, `tts_first_byte_ms` 1050 — these sum to **1,979ms**. The other **8,508ms is unaccounted for** by any
column this codebase currently writes. `callLatency`'s own schema doc comment says
`pickup_to_first_audio_ms` covers "every DB round-trip, provider connect, and greeting-generation step" —
meaning the missing time is almost certainly in the "start" handler's own setup sequence (org/agent-config
resolution, the session lookup, the calls-row select/insert — all the awaited work before
`connectSttForCall`/`runGreeting` are even reached), which has no metric of its own today. This is a new,
previously-unmeasured latency sink, worse in this one call than every componentized stage combined. Not
chased to a specific line here — flagged as the next latency-instrumentation gap, likely ahead of C3/C4 in
actual caller-perceived impact for whichever calls hit it.

## Finding 4 — 0 of 8 new-org calls are healthy

| health status | count |
|---|---|
| healthy | 2 (calls 1, 2 — the old org, unchanged) |
| degraded | 3 |
| silent-failure | 5 |

Guardrail events, all on the new org: 3× `fabricated-capture` (all one call, see Finding 5), 2×
`undelivered-outcome` (`crm-sync` — CRM genuinely not configured for this org, correctly logged, not a
code defect), 1× `unauthorized-promise` (agent self-reported a boundary correctly held, logged as
evidence not as a violation). Idle-prompt ("are you still there") fired 7 times across 10 calls; the
4-in-a-row collision from the 2026-08-21 audit's Finding 4 is unchanged (still call 2, still unfixed,
still Phase D scope); the new org's two firings (calls 3, 5) are both single, at the tail end of an
already-ending call — not new collisions.

## Two defects, root-caused and fixed this session

### Defect A — a legitimately-answered fact discarded because of a missing space at a turn boundary

Call 6's caller self-corrected mid-word: `speech_final` fired on "No. I'm looking for funeral ex", then
again moments later on "funeral expenses." The agent's response to the first fragment was barge-in-aborted
before it spoke a single word — `wasInterrupted && spokenWords.length > 0` was false, so nothing was
pushed to `history` for that turn — leaving two consecutive `{role: "user"}` messages with no assistant
turn between them. The model later quoted the caller's answer for `captureField`'s `heard` argument and
read the two adjacent messages as one continuous utterance, gluing them **with no space**:
`"funeral exfuneral expenses."` ADR-120's `heardInCallerSpeech` (`capture-provenance.ts`) — token-sequence
matching, deliberately strict — correctly refused the malformed quote (the glued word never appeared in
the caller's real, space-separated transcript). It refired 3 times as the model kept retrying with the
same fabricated string, and `coverage_purpose` — a real, clearly-answered field — was never captured.

**The guard was not the bug.** The bug was upstream: two intentionally-separate caller utterances had no
structural boundary once the turn between them vanished. Fix: `stream.ts`'s caller-turn handler now merges
into the previous `history` entry (space-joined) instead of pushing a second one, whenever the last entry
is already `{role: "user"}` — i.e. whenever no assistant turn separated this fragment from the last.
`transcripts` is unaffected (still two distinct rows, faithful to what was said and when); only the
model-facing `history` merges. New test: `stream-caller-self-correction.test.ts`, verified to fail against
the pre-fix code before being locked in.

### Defect B — a lost `INSERT ... ON CONFLICT DO NOTHING RETURNING` race silently discarded an entire call's telemetry

Calls 9 and 11: the live in-call health classifier recorded real turns ("agent took 3-4 turns") from
in-memory counters, yet `transcripts`, `tool_calls`, `turn_latency`, and `guardrail_events` all show **zero
rows** for both. Root cause: `routes.ts`'s `/incoming` webhook inserts the `calls` row **fire-and-forget**
(a 2026-07-17 latency fix, explicitly not awaited so it doesn't block the TwiML response), relying on
`stream.ts`'s own SELECT-then-fallback-INSERT in the "start" handler to recover the row if the media stream
connects first. Both inserts use `onConflictDoNothing()`. When `stream.ts`'s SELECT ran before *either*
insert had landed (found nothing), and its own fallback INSERT then lost the conflict against the
concurrent `/incoming` insert, `onConflictDoNothing().returning()` came back **empty for the losing
statement** — the row was not harmed (a row exists, written by the insert that won), but the old code did
`row = inserted ?? row`, and `row` had already been `undefined` from the earlier SELECT. `dbCallId`
resolved to `null` for the rest of that call. Every live write in this codebase is gated on `dbCallId`;
the final status update at hangup is the one thing that isn't (it matches on `callSid`), which is exactly
why the `calls` row itself looks fine while everything downstream of it is empty.

Fix: on a lost conflict (own insert returns empty), re-SELECT by `twilioCallSid` to pick up whichever
insert won. New test: `stream-call-row-race.test.ts`, verified to fail against the pre-fix code before
being locked in.

**Both fixes are unverified against real production traffic** — same caveat as every other fix this
session: not deployed (`origin/main` is still 6 commits behind), so the actual rate of either failure mode
in the wild remains whatever this 10-call sample implies (1 call showing Defect A's mechanism, 2 of 10
showing Defect B's) until confirmed live.

## What this changes

1. **C4 step 1 is now answered with real data, not "blocked"**: the terminal-turn spike is real but
   partial (2/6), directly traced to `captureField` batching in this sample. Step 2 (the structural cap)
   remains not-yet-justified on this sample size, per the plan's own conditional language — this finding
   sharpens the open question, it doesn't close it.
2. **Finding 1 (VAD/endpointing) from 2026-08-21 is corrected, not reversed**: `utterance_end` fires 26%
   of the time in this larger sample, not 0%. ADR-063's gate (a) goes back to unproven rather than
   answered-no. Not re-opened as active work — flagged for whoever next touches turn-taking.
3. **A new, unmeasured latency sink** (the "start" handler's own setup sequence, 8.5s in one observed
   case) likely outranks C3/C4 for actual caller-perceived impact on the calls it hits, and has no metric
   today.
4. **Two real defects fixed**, both with regression tests proven to fail pre-fix: a data-loss bug in the
   capture-guard boundary (Defect A) and a silent-telemetry-loss race in call-row resolution (Defect B).
   Neither is deployed yet.
