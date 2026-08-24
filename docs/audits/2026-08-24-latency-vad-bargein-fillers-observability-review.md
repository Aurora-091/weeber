# Latency, VAD/endpointing, barge-in, fillers, observability, and cascade-vs-S2S — a code-grounded review

- **Date:** 2026-08-24
- **Source:** repo `main` @ `1cd709c`, plus `docs/audits/2026-08-21-first-two-production-calls.md`'s production
  numbers (2 calls, 31 turns — still the only real-call data this repo has)
- **Scope:** answers a founder questionnaire covering seven areas of the voice pipeline, asked as a
  pre-check before starting `docs/plans/phase-c-latency.md`'s C2. Every answer below is sourced from
  reading the actual code or the 2026-08-21 audit's production numbers — nothing here is inferred from
  intent or from what the plan docs say *should* be true.
- **Class:** dated point-in-time artifact (ADR-118 class 2). Not a plan, not a decision. Supersede with a
  new dated file if the code moves under it.

## Why this exists

Before starting Phase C2, the founder asked seven blocks of questions about latency instrumentation,
VAD/endpointing, barge-in behavior, conversational fillers, filler safety, observability, and the
cascade-vs-speech-to-speech decision. Several of those questions ask "does X exist" about mechanisms
(fillers, barge-in gating, per-turn latency columns) that already have real, non-trivial implementations
in the codebase — and several ask about production behavior that the 2026-08-21 audit already measured.
Answering from memory or from the plan docs' aspirational language would have re-litigated settled
questions and missed the gap that actually matters (see Finding 6). This file is the record of what was
actually checked.

## 1. Latency — what's measured, what isn't, and where the time goes

**Instrumentation exists in two tables** (`packages/api/src/database/schema.ts`):

- `call_latency` (:301-317, once per call): `sttConnectMs`, `llmTtftMs`, `ttsFirstByteMs`,
  `pickupToFirstAudioMs`.
- `turn_latency` (:353-409, one row per turn): `llmTtftMs`, `ttsFirstByteMs`, `voiceToVoiceMs`,
  `llmProviderUsed`, `endpointSignal` (`speech_final` | `utterance_end`), `endpointingDelayMs`,
  `ttsSocketOpenMs`, `llmInputTokens`/`llmCachedInputTokens`/`llmOutputTokens`.

So: VAD endpoint latency ✅ (`endpointingDelayMs`), STT finalization signal ✅ (`endpointSignal`), LLM TTFT
✅, TTS first-byte/first-audio ✅ (`ttsFirstByteMs`, plus `ttsSocketOpenMs` isolating the handshake since
Phase C1), **tool latency ⚠️ built but broken** (see Finding 8 below), **audio-delivery-to-caller ❌ not
instrumented at all** — nothing times Twilio-side playback or network transit.

**Current perceived latency** (2026-08-21 audit, the only real numbers this repo has):

- `pickup_to_first_audio_ms`: 1985ms / 2753ms against an 800ms bar — 2.5-3.4× over.
- per-turn `voice_to_voice_ms`, pooled across 24 non-null turns: p50 ≈ 1750ms, p95 ≈ 4500ms against
  800ms/1200ms bars.
- Decomposition (both calls post-ADR-107, so additive): **LLM ≈ 70%, TTS ≈ 23%, everything else ≈ 7%.**

**Biggest bottleneck: the LLM**, not architecture, not endpointing, not (as of Phase C1) the TTS socket
handshake. This is why `phase-c-latency.md` orders TTS-socket-reuse and `stt_connect` ahead of
endpointing work, and why C2's prompt-cache-stability task is the next-highest-leverage lever on the
dominant stage.

**Does TTS wait for the full LLM response? No — already streams.** `stream.ts:2348`:
`onTextDelta: (delta) => sendTtsTextWithTone(delta)` forwards every token delta to TTS as it arrives.
The only delay on the first chunk is `output-guard.ts`'s tone-tag filter holding back up to
`TONE_TAG_MAX_BUFFER_CHARS` (24) characters to check for a leading `[[tone:...]]` tag before releasing —
not a "wait for the sentence" buffer. This has been true since before Phase C1; Phase C1 changed the
socket lifecycle, not the streaming behavior.

## 2. VAD / Endpointing — configured, and empirically a non-problem

`stt/deepgram.ts:90-108`: nova-3, dual-signal — `endpointing: "300"` (300ms silence timeout driving
`speech_final`) plus `utterance_end_ms: "1000"` (a second, independent VAD-driven fallback,
`UtteranceEnd`). No pre/post-speech buffer parameters exist or are configurable — Deepgram's streaming
API doesn't expose that knob, so the question doesn't apply to this integration.

**Production data closes this question rather than opening it.** Of the 26 turns in the 2026-08-21 audit
that recorded an `endpoint_signal`, **all 26 were `speech_final`; `utterance_end` never fired once.**
`endpointing_delay_ms` ranged 1-22ms across all of them. There is no measured false-interruption or
false-wait rate from endpointing specifically — the audit's conclusion was that lowering the safety-net
timeout "is worth exactly 0 ms," and ADR-063's gate for wiring a semantic-turn-detection refiner is now
answerable: no evidence of cut-offs, so don't build it. `phase-c-latency.md` explicitly refuses both
endpointing-timeout tuning and the semantic refiner as C-phase work on this evidence.

**The real turn-taking defect found in production is a different mechanism entirely: the 8-second idle
prompt**, not VAD/endpointing. `stream.ts:151-152`: `SILENCE_WARNING_MS = 8000`. In the 2 audited calls
this fired 5 times total and **collided with the caller twice** — once 0.4s after the caller had already
started speaking (the `callerSpeechEpoch` re-check that's supposed to cancel this hadn't advanced yet).
Still live and unfixed: Phase B (`B1`-`B5`, shipped and closed per the `b27ddd1` commit) did not touch
this — it covered the latency-report CLI, `tool_call_latency`, `guardrail_events`, transcript ordering,
and health status. Idle-prompt/turn-taking tuning is explicitly Phase D's scope per
`phase-c-latency.md`'s "Explicitly out of scope" section, not C's.

## 3. Barge-in — deliberately built, one real gap found

`barge-in.ts` + `stream.ts:2594-2680`:

| Behavior | Answer |
|---|---|
| TTS stops immediately | Yes — `tts?.close()` + `closeTtsSession()` |
| Buffered audio continues playing | No — `ws.send(transport.buildClear(streamSid))` clears Twilio's playback buffer |
| STT captures the interruption immediately | Yes — STT is **never closed** on barge-in, stays connected for the whole call |
| LLM generation continues | No — `turnAbortController.abort()`, caught as `AbortError` |
| **Active tool call can be cancelled** | **No.** No file under `voice/tools/` reads `abortSignal`. `withToolTimeout` (`agent.ts:1022-1061`) deliberately lets an orphaned tool call keep running after the turn stops waiting on it, by design ("don't let the real call vanish just because the turn stopped waiting on it") — a barge-in mid-`crmSync`/`bookAppointment`/Shopify-write does not stop that side effect from completing. |
| Old response can accidentally continue playing | No — same clear+close path covers it |
| Conversation state after interruption | `fullText = spokenWords.join(" ")` (`stream.ts:2255-2256`) — history is rewritten to only what the caller actually **heard** (via TTS word-timestamps), not the full generated text |

**Detection logic** (`barge-in.ts`): persistence-gated. Text ≥`BARGE_IN_MIN_CHARS` (4) fires on the first
interim hit — urgent one-word interruptions ("wait", "stop") cut in immediately. Shorter fragments need
`BARGE_IN_STREAK_REQUIRED` (2) consecutive interim hits before triggering, specifically to filter coughs/
clicks/TTS audio bleeding back into the line. This exists because the prior "fire on any interim" version
caused false interruptions (2026-08-15 pilot audit, finding F5).

**Gap: none of the specific scenarios in the questionnaire have test coverage.** `barge-in.test.ts` tests
the pure `decideBargeIn(agentIsSpeaking, text, priorStreak)` function's threshold/streak arithmetic —
real scenarios like "caller corrects themselves," "caller changes the request halfway through," or
"caller talks over a filler line" are not scripted anywhere as an integration test.

## 4-5. Conversational fillers — built more completely than assumed, entirely inert in production

`stream.ts:1601-1693`, `agent.ts:996-1120`, `backchannel.ts` already implement most of what was asked:

| Question | Answer |
|---|---|
| Trigger only when a tool exceeds ~400ms | Yes — `TOOL_CALL_FILLER_THRESHOLD_MS = 400` (`agent.ts:996`) |
| Threshold configurable | **No** — hardcoded constant, not a per-org flag/config value |
| Cancelled if tool finishes first | Yes by construction (`withFillerTimer` only fires past the timer) |
| Cancelled if caller barges in | Yes — filler audio rides the same Twilio buffer as TTS, cleared by the same `buildClear` |
| Two fillers per tool call prevented | Yes — `fillerPlayedThisTurn` flag, "at most one filler line per turn" (`stream.ts:2338-2340`) |
| **Selected by which tool is running** | **No.** Two generic lines chosen at random regardless of tool (`stream.ts:1618`: `["One moment, let me check that.", "Let me look into that for you."]`) — no calendar-, lookup-, or booking-specific lines exist. |
| **Localized (Hindi/Hinglish/English)** | **No.** Both lines are hardcoded English text, cached per `(provider, voiceId, language, text)` — a Hindi-language call gets English-text filler spoken in the Hindi voice, untranslated. |
| Pre-generated/cached audio, not live synthesis | **Yes, correctly built this way.** `maybePlayToolCallFiller` never synthesizes live; a cache miss triggers a background warm and skips that turn's filler, specifically so the filler can't itself add latency (`stream.ts:1646-1665`). |
| Smooth transition into the real TTS response | Unverified — no test or measurement exists either way. |
| Measured for perceived-latency improvement or artificiality | **No measurement exists.** |

The same cache/threshold architecture backs **backchannels** (`"Mm-hm."`, `"Right."`, `"Okay."` —
`backchannel.ts:54`): mid-utterance, caller-still-talking, rate-limited, same English-only gap.

**Filler safety (section 5 of the questionnaire) is already satisfied by construction** — both existing
lines are "let me check"/"let me look into" phrasing, never a completion claim, consistent with the
`fabricated-outbound-text` discipline ADR-106 already enforces elsewhere for tool-output text.

## Finding 6 (this audit's own numbering) — the filler/backchannel system has never once played in production

Both `maybePlayToolCallFiller` and `maybePlayBackchannel` are gated on
`feature_flags["hybrid-audio-cache"]` (`HYBRID_AUDIO_CACHE_FLAG`, `tts-cache.ts:22`). The 2026-08-21
audit found **`feature_flags` has 0 rows in production** — every flag resolves to its code default, which
is off. **The plumbing described in sections 4-5 above is fully built and has never once executed in a
real call.** This is the single highest-leverage fact in this document: turning fillers/backchannels on
is a flag flip, not a build task — though it ships today with the tool-specificity and localization gaps
noted above still open.

## 7. Observability — the columns exist, the trace view doesn't

`bun run latency:report` (`packages/api/scripts/latency-report.ts`) is a **pooled/aggregate** report —
p50/p95/min/max across many turns and calls — not a single-call chronological timeline. Building the
questionnaire's example trace (`00:00.000 User stops speaking / 00:00.180 VAD endpoint / ...`) would
require joining `turn_latency` + `tool_call_latency` + `transcripts` by call and turn, ordered by
wall-clock offset from turn start; no such renderer exists today.

Two things are missing beyond the renderer itself:

1. **Filler/backchannel start time is never persisted** — `console.log` only (`stream.ts:2437`), no DB
   row. A trace could not show "Filler started" without adding a write.
2. **`tool_call_latency` writes 0 rows against 24 real tool calls** in the only production data available
   (2026-08-21 audit, Finding 8). The writer (`persistToolCallLatency`, `stream.ts:483`) shipped before
   the audited call but produced nothing — either not deployed at call time, or failing silently (it's
   fire-and-forget with a `.catch` that only `console.error`s). Passing unit tests run against a mock and
   would not catch this. **A trace's "Tool started"/"Tool completed" rows depend on a column that is
   currently empty in production**, independent of whether a renderer exists.

`transcripts` rows can also be **written out of order** relative to when they were spoken (same audit,
Finding 4) — any trace or replay tool that trusts `id`/`createdAt` ordering will reconstruct a
conversation that did not happen.

## 8. Cascade vs. speech-to-speech — already answered and refused in writing

`docs/plans/phase-c-latency.md`'s "Explicitly refused" section, on production evidence:

> "Revisiting the cascade architecture (ADR-001) or moving to speech-to-speech. Production says the cost
> is LLM TTFT (≈70% of v2v), which is addressable inside the cascade — provider, prompt size, cache, and
> the tool-batch tail. A rewrite is not justified by this evidence and is out of bounds for this plan."

What S2S would cost, concretely, given what this audit found the cascade currently buys for free: the
tobacco-fabrication finding (2026-08-21 audit, Finding 2), the fabricated-callback-promise finding
(Finding 3), and the barge-in `spokenWords` reconstruction in section 3 above all depend on an
inspectable transcript and structured tool-call log that S2S would make substantially harder to obtain.
Debugging visibility, transcript/control, and model flexibility are real, structural costs of S2S visible
directly in this codebase's own defect history — not abstract tradeoffs. Sequencing (cascade
optimization before any S2S experiment) is already the committed plan, not an open question.

## What this changes

1. **`tool_call_latency` writing 0 rows is a live, unresolved defect** (carried over from the 2026-08-21
   audit, restated here because it independently breaks both the section-1 tool-latency question and the
   section-6 trace-observability question). Not fixed by this document.
2. **The filler/backchannel system is a flag flip away from being live**, not a build task — the
   remaining real gaps are tool-specific line selection and localization, both scoped, neither started.
3. **VAD/endpointing tuning and semantic-turn-detection remain correctly out of scope** for Phase C —
   production evidence supports that call twice now (2026-08-21 audit, this review).
4. Nothing here blocks or changes the sequencing of `docs/plans/phase-c-latency.md`'s C2-C4.
