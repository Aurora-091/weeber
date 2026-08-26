# Silence and "continue" pattern — root-caused

- **Date:** 2026-08-26
- **Source:** production Supabase (`qghtkadxbtptvbfbmsdz`), read-only — `transcripts`, `turn_latency` for
  calls 8, 16, 19, 20, 21, cross-checked against `packages/api/src/voice/turn-detection/heuristic.ts` and
  `dictation.ts` directly (not from memory).
- **Trigger:** user asked whether the live agent requires callers to explicitly prompt it (e.g. saying
  "continue") or goes silent, especially after an interruption, and reported this as an observed live
  pattern.
- **What's already written down:** `docs/audits/2026-08-26-post-deploy-call-review.md` names call 16's
  repeated question ("are you thinking final expenses or leaving something behind...", asked 4x) as a D2/D3
  `askCount`-ledger blind spot — true, but it treats the *symptom* (a question asked too many times) and
  attributes it to "the model just kept naturally re-phrasing the question inline." This doc goes one layer
  deeper: **why** the model kept re-asking, which turns out to be a distinct, more fundamental mechanism.
- **Class:** dated point-in-time artifact (ADR-118 class 2). Findings only — nothing implemented.

## Verdict, up front

Two distinct things are happening, and they should not be conflated:

1. **A real, reproducible defect: slow/broken-up caller speech gets endpointed word-by-word, and each
   isolated fragment fires an independent, context-blind agent turn** — call 16 is direct proof. This is
   the concrete, fixable finding.
2. **The "Are you still there?" (D1 silence-timeout) re-prompt firing repeatedly is, on the timing evidence
   checked, working as designed** — it's catching genuine caller silence/hesitation and successfully
   getting a response almost immediately after firing, in both instances checked. Not a bug on this
   evidence.

Call 21's caller literally saying **"Yes. Continue."** is real, first-hand evidence a caller felt like
nothing was happening — but the transcript shows this was the caller filling a long *thinking* pause on an
open-ended question, not a response to a stuck/silent agent (no "Are you still there?" had fired yet at
that point in the call). It's a pacing observation, not proof of a hang.

## Finding 1: caller speech gets endpointed word-by-word, producing repeated, context-blind re-asks

Call 16 (2026-08-25, `docs/audits/2026-08-26-post-deploy-call-review.md` already flagged the symptom),
transcript sequences 8-23, `created_at` order:

```
09:10:13  caller  "I have okay. That's"
09:10:14  agent   "...is your main goal ... final expenses, or ... leave something behind for your family?"
09:10:15  caller  "time to connect with"                                    [1.7s later]
09:10:16  agent   "...is your interest ... final expenses, or ... leave something behind for your family?"
09:10:17  caller  "your"                                                    [1.1s later]
09:10:18  agent   "...are you looking to cover final expenses, or ... leave something behind for your family?"
09:10:22  caller  "agent"                                                   [4s later]
09:10:25  agent   "I'm not a licensed agent myself, but... final expenses, or ... leave something behind..."
09:10:43  caller  "I'm going with"                                          [18s later]
09:10:44  agent   "...would you say your goal is more for final expenses or for leaving something behind..."
09:10:46  caller  "final"                                                   [2s later]
09:10:47  agent   "...do you have a preference between a traditional burial or cremation?"
09:10:48  caller  "expense"                                                 [1.4s later]
09:10:49  agent   "...between a traditional burial or cremation, do you have a preference..."
09:10:50  caller  "coverage."                                               [1.1s later]
09:10:51  agent   "...are you thinking more along the lines of a traditional burial or a cremation..."
09:11:08  agent   "Are you still there? Let me know if you need anything else."                [17s later]
09:11:09  caller  "Traditional."
```

`I'm going with` → `final` → `expense` → `coverage.` is one continuous answer — **"I'm going with final
expense coverage"** — spoken slowly and cut into four separate pieces, each 1-2 seconds apart. `turn_latency`
confirms these were not near-misses or holds: call 16 has **33 real `turn_latency` rows** (`turn_index`
0-32), each with genuine sub-1s-to-3.6s LLM+TTS timing — every single fragment triggered a full, real,
separate `runVoiceAgentTurn` call. The model, seeing each fragment with no memory that it's mid-answer,
answers each one as a fresh non-answer and re-asks essentially the same question, never acknowledging
"final" + "expense" + "coverage" as pieces of one sentence.

**None of stream.ts's own turn-detection heuristics caused this — the fragments sail straight through as
"done":**

- `endsMidThought` (`heuristic.ts:19`) only catches a fixed list of trailing filler words:
  `and|so|but|or|because|um+|uh+|like|well|then`. None of "your", "agent", "with" (in "I'm going **with**"),
  "final", "expense" appear in that list — despite "with" being exactly the same *grammatical* shape as
  "and"/"so"/"but" (a trailing function word implying more is coming). The list simply doesn't cover common
  trailing prepositions/articles beyond the ~10 words chosen.
- `endsWithIncompleteDictation` (`dictation.ts:34-36`, D6, this session) checks for a lone trailing
  digit/letter/hyphen — none of these fragments match either; they're whole words, not spelled-out letters
  or digit sequences.
- Tested by hand against every short/fragment caller line pulled from calls 8, 16, 19, 20, 21 (not just the
  ones quoted above): the two heuristics correctly leave alone genuinely-complete one-word answers
  elsewhere in the very same calls — `"Traditional."`, `"Sure."`, `"No."`, `"Okay."` — which is exactly why
  a blunter fix (e.g. "hold any single-word utterance") would be wrong: those are real, complete answers.

**Root cause is one level below stream.ts's heuristics: Deepgram's own `speech_final`/endpointing signal is
firing on brief pauses between this caller's individual words**, treating each pause as end-of-utterance.
The heuristic layer was explicitly designed (see `heuristic.ts`'s and `dictation.ts`'s own doc comments) to
catch a *specific, named* set of "obviously incomplete" shapes cheaply, without a model call — it was never
designed to and cannot reliably distinguish "final" as a genuinely complete one-word answer to some
hypothetical question from "final" as the first word of "final expense coverage" cut short by a slow
speaker's natural pauses. That's a real ceiling on the current regex-based approach, not an oversight in
either heuristic's specific pattern list.

This is the same shape the currency-research audit already named for Deepgram Flux
(`docs/audits/2026-08-25-provider-currency-deep-dive.md`) — Flux's turn-detection is described as
distinguishing a genuinely-paused caller from a finished one using acoustic/semantic signals beyond a fixed
silence threshold, which is exactly the class of signal this defect needs and neither `endsMidThought` nor
`endsWithIncompleteDictation` can provide from text alone.

### What this is not

- **Not a D6 regression.** D6's dictation detector is doing exactly what it was built for (lone
  digit/letter/hyphen) and doesn't apply to this shape of fragment at all.
- **Not the out-of-order-transcript-write artifact** (2026-08-21 audit Finding 4) — `turn_latency` proves
  each fragment produced a genuinely separate, real turn; this isn't a logging ordering illusion.
- **Not new** — the D2/D3 askCount blind spot already named this call's *symptom* one day earlier; this
  finding explains the *mechanism* underneath it.

## Finding 2: the D1 silence-timeout re-prompt is working as designed on the evidence checked

Call 19, two instances in one short call:

```
19:19:06  agent  "...how would you rate your experience with us?"
19:19:20  agent  "Are you still there? Let me know if you need anything else."     [14.2s later]
19:19:22  caller "yeah, I will later on four."                                     [1.1s after the nudge]

19:19:24  agent  "Is there anything specific you'd like to share..."
19:19:38  agent  "Are you still there? Let me know if you need anything else."     [14.4s later]
19:19:39  caller "But but yeah. It it it was all good..."                          [0.8s after the nudge]
```

Both times, the caller responds within ~1 second of the re-prompt — consistent with genuine caller
silence/distraction that the nudge successfully interrupted, not with a caller who'd been talking into dead
air. ~14s matches the expected shape (a several-second spoken question + the ~8s silence-warning threshold,
measured from end of *playback* per Audit-10's fix, not end of send). No evidence here of the agent failing
to respond to something the caller actually said.

Call 21's `"Yes. Continue."` (sequence 8, at 09:53:40) landed 15.4s after the agent's prior question with
**no "Are you still there?" row between them** — the silence timer hadn't fired yet at that point. This
call's persona has a longer elevated silence threshold (D1, `insurance-final-expense-qualifier`'s
12000/10000ms override), so 15.4s alone doesn't cross it. Read plainly, the caller paused to think about an
open-ended three-way question ("final expenses, leaving something behind for family, or both?") and said
"continue" as a hedge/filler rather than an actual answer — the agent's next turn re-asks essentially the
same question, consistent with "Yes. Continue." not having resolved anything. This is a real, first-hand
signal that ~15s of silence *feels* long enough for a caller to feel the need to say something — worth
knowing about — but it is not evidence of the agent being unresponsive or requiring a magic word; the
system was never stuck, and no code condition was blocking it.

## What this changes

1. **A specific, scoped, real defect to consider fixing**: caller utterances arriving in quick succession
   (each within a few seconds of the last, no agent turn actually addressing what was said) should be
   recognized as a continued answer rather than independently completed turns. This is a different, harder
   problem than D6's regex-shape detection — it needs either (a) a genuinely wider/smarter text heuristic
   (accepting it will still have a ceiling), (b) evaluating whether Deepgram's own endpointing sensitivity
   can be tuned per-call (e.g. for personas serving an elderly/slower-speaking demographic, same reasoning
   D1 already used to raise silence thresholds for `insurance-final-expense-qualifier`), or (c) the model
   itself recognizing from `history` that its last turn's question went unanswered and adjusting — not
   attempted or recommended definitively here; needs its own design pass given the ceiling named above.
   Not implemented — findings only.
2. **The D1 silence-timeout mechanism itself needs no fix on this evidence** — it's doing its job. Worth
   continuing to watch as more real calls land, but nothing here calls for a change to `SILENCE_WARNING_MS`
   or its per-template overrides.
3. **Call 16's repeated question is now explained end to end**: D2/D3's `askCount` ledger correctly recorded
   it as unanswered activity (per the prior audit), and now this doc explains *why* the caller's real answer
   never registered as one — the STT endpointing granularity, not the model or the ledger.
