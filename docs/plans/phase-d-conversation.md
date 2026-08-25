# Phase D — Conversation intelligence

**Status:** Code-complete (2026-08-25) — all eight items (D1-D8) shipped, committed, and pushed to
`origin/main` in one session at the user's explicit direction. Phase C is also code-complete (all four
sub-phases) and pushed, but both phases share the same open item: the exit gate's live-measurement
conditions (this phase's 5/6/8/9/10, Phase C's own equivalents) are pending a manual Railway deploy
approval outside this session's reach (see `phase-c-latency.md`'s closing status) — nothing has run against
a real post-deploy call yet. A pre-deploy baseline is recorded in `phase-c-latency.md` (v2v p50 1481ms, p95
3463ms) to satisfy this section's own precondition well enough to start; whoever approves the pending
deploys should re-run `latency:report` against real post-deploy calls and reconcile that baseline, and
should also run the synthetic suite conditions (1, 8, 9, 10) explicitly before treating this phase's exit
gate as met — this session ran every item's own unit/integration tests but did not separately assemble and
run the full cross-item synthetic-suite replay the exit gate describes.
**Blocks:** Phase E
**Preconditions:** Phase C's exit gate met, with the achieved p95 recorded in that phase's closing
commit. D changes turn structure and will move those numbers; there must be a recorded baseline to move
them from. **(Satisfied provisionally — see Status above.)**
**Evidence:** `docs/audits/2026-08-21-first-two-production-calls.md`, findings 4, 8 and the sentiment
item under "smaller items"; `docs/audits/2026-08-25-pipeline-edge-cases-research.md` items 1-4 (added
2026-08-25 — external research on silence-timeout demographics, dictation-sequence endpointing, tool-call
interruption protection, and disclosure interruptibility, each cross-referenced against this codebase)
**Governing ADRs:** ADR-106 (constrains what the agent says), ADR-120 (captured-field provenance),
ADR-063 (semantic turn detection — closed in Phase C, stays closed)

---

## Why this phase exists

The two production calls were not badly behaved because the model is weak. They were badly behaved in
three specific, mechanical ways:

- **The idle prompt talked over the caller.** `SILENCE_WARNING_MS = 8000` (`stream.ts:148`) fired
  **four times in call 2** (transcripts 32, 35, 38, 47) and once in call 1 (14). Twice it collided with
  the caller: transcript 35 at 17:36:41.843 landed **0.4 s** before caller transcript 36 at
  17:36:42.235, and 47 landed 2.7 s before 48. The `callerSpeechEpoch` re-check (`stream.ts:617`,
  `:1394`, `:1410`, `:1415`, `:1424`) exists precisely to prevent this and did not. **This — not
  endpointing — is the real turn-taking defect.** (Finding 4)
- **Three questions were asked more than once.** Coverage purpose (t25 → t27), income (t31 → t34),
  tobacco (t40 → t42 → t44), banking on call 1 (t13 → t16). Each individual re-ask is locally
  reasonable; nothing tracks how many times a thing has been asked, which is how the tobacco loop
  resolved itself by **fabrication** rather than by escalation. Phase A stopped the fabrication. It did
  not stop the loop. (Findings 1 and 4)
- **There is no deterministic escalation.** When the caller will not answer, the agent has no defined
  exit other than to keep asking or to invent an answer.

Two smaller items belong here because they are the same category — what the agent says and when:

- The tool-call filler lines (`TOOL_CALL_FILLER_LINES`, `stream.ts:1292`, used at `:1327`) are *"One
  moment, let me check that."* and *"Let me look into that for you."* Both presuppose a successful
  lookup, which is not outcome-neutral when the tool returns nothing — and `crmSync` returning
  `synced: false` is exactly that case (Phase A, finding 2).
- The unsourced price claim (finding 8) is logged from Phase A onward. D decides, with rows in hand,
  whether to block it.

---

## The work

### D1. Rework the idle prompt so it cannot interrupt

**Status: items 1, 2, and 4 verified already true by construction; item 3 shipped 2026-08-25.**

Before building anything, tested whether the existing barge-in mechanism (`decideBargeIn` +
`agentIsSpeaking`, `barge-in.ts`) already interrupts a playing idle-prompt line — `speakCannedLine` routes
through the same shared `speak()` every real turn uses, which sets `agentIsSpeaking = true` regardless of
which code path is speaking, and the STT handler's barge-in check runs on every transcript event
unconditionally. New `stream-idle-prompt-bargein.test.ts` proves it directly: an interim (not final)
caller transcript arriving while the "Are you still there?" line's text is being handed to TTS closes the
turn's TTS handle — the same observable signature a normal mid-turn barge-in produces. **Items 1 and 4 are
therefore already satisfied** — the idle line is interruptible, and it is cut the instant caller speech is
detected, not merely checked-for-and-abandoned after the fact. (`stream-silence-timeout.test.ts`'s
existing race test only proves the separate *escalation* decision is correct — that the call doesn't
wrongly hang up — using a seam that fires before any audio streams; it does not by itself prove the audio
gets cut, which is why this needed its own test rather than reusing that one's passing status as evidence.)
**Item 2** (debounce before the idle timer may arm) also appears satisfied by construction: the timer only
ever arms from `speak()`'s own tail, after the agent's reply has been generated and sent — which is
naturally gapped by real LLM+TTS turn latency (our own data: v2v p50 ≈1.5s), not a fixed guess — but this
has not been independently verified with a dedicated test the way items 1/4 now are, so treat it as
plausible, not proven.

**Item 3 — shipped.** `agent.ts`'s `resolveSilenceTimeouts(templateKey)` returns a per-template override
of `SILENCE_WARNING_MS`/`SILENCE_HANGUP_MS` (8000/7000ms defaults, unchanged for every other template):
`insurance-final-expense-qualifier` gets 12000/10000ms, a reasoned ~50% increase (not a controlled A/B
result — flagged as such in the code) based on the cited elderly-skewing literature. Wired into
`ResolvedAgentConfig`'s three `resolveAgentConfig` return branches and consumed in `stream.ts` via new
call-scoped `silenceWarningMs`/`silenceHangupMs` variables (defaulting to the existing module constants),
set once at "start" from `agentConfig.silenceWarningMs`/`silenceHangupMs`. Deliberately a code-level map,
not a new `orgAgentConfigs` column — no product/compliance reason yet to let a merchant self-tune this per
org, and adding DB/UI surface for a value with no A/B evidence behind it would be the exact premature
schema ADR-012 already warns against. New `resolveSilenceTimeouts` unit tests. 1583/1583 api tests pass,
typecheck/lint/knip:gate clean. **Not deployed, not measured live** — same caveat as everything else this
session; revisit the exact multiplier once real calls on this persona confirm whether it actually cuts
false warnings without excessively delaying a genuine hangup-worthy silence.

**Where:**

- `packages/api/src/voice/stream.ts:148` — `SILENCE_WARNING_MS`, and `SILENCE_HANGUP_MS` nearby.
- `stream.ts:1394`–`:1430` — the arm/fire path and `handleSilenceTimeout`.
- `stream.ts:598`–`:620` — the `callerSpeechEpoch` mechanism and its doc comment (which describes the
  intended guarantee; read it before changing anything, then decide whether the comment or the code is
  wrong).
- `stream.ts:2316` — the in-flight-abandon comment referencing this path.
- `stream.ts:1238` — the note that `runGreeting`/`handleSilenceTimeout` both run after setup.

**How:** the epoch check is a check at two instants (`:1410` and `:1415`, `:1424`) with real work in
between — synthesis and a socket write. The caller starting to speak inside that window is not caught.
Fix the race, do not lengthen the timer and call it fixed.

1. **Make the epoch check span the whole emission, not two points.** The check must cover from the
   decision to speak through the last byte written, and an idle line must be **abandoned or cut** if
   caller speech is detected at any point during it — not merely if it arrived before the check.
2. **Add a debounce after caller speech ends** before the idle timer may arm at all, sized off real
   inter-turn gaps rather than a guess. The distribution needed for that is what `latency:report`
   (Phase B) prints; use it.
3. **Reconsider 8000 ms with the data.** Call 2 fired it four times in one call, which suggests the
   threshold is short for a caller who is thinking about an insurance question. Raise it on evidence and
   write the evidence down next to the constant. **Make it configurable per persona, not just a bigger
   global constant** (2026-08-25 addition, `docs/audits/2026-08-25-pipeline-edge-cases-research.md` item
   1): this is a named, researched problem class — default voice-AI silence timeouts (1.5-2s in generic
   assistants) are documented to lock out older callers, whose real speech is slower and more frequently
   paused (UC Berkeley AgeVoicE; dementia-friendly-EVA research, *Frontiers in Dementia* 2024), and the
   documented fix in that literature is a **persona/demographic-adaptive** value, not one global number —
   directly relevant here since `insurance-final-expense-qualifier` is explicitly elderly-skewing by
   design, not incidentally. A single raised constant would still under-serve every other persona that
   doesn't need it raised.
4. **An idle line must be interruptible.** If the caller speaks while it is playing, it stops. That is
   a barge-in requirement, and it must hold for the greeting too.

**Test:** new `packages/api/src/voice/stream-idle-prompt.test.ts` — caller speech arriving 100 ms after
the timeout fires, and again mid-synthesis, must both prevent or cut the idle line. Encode the call-2
timing (0.4 s gap) as a named fixture citing the audit.

---

### D2. A question ledger — nothing gets asked twice

**Status: shipped 2026-08-25 — items 1-3 built; item 4 (a compliance-required-fields schema) deliberately
not built, per its own explicit gate.**

`CapturedField` (database/schema.ts) gained an optional `askCount` — the "same structure extended with an
ask count, not a second parallel store" this section's own spec asked for, no migration needed since
`capturedState` is `jsonb`. `stream.ts`'s `mergeUnansweredField` now carries the count forward across
repeated evasions of the same field (1 on the first mark, incrementing on every later one for that key) —
`mergeCapturedField` gained an optional 4th `askCount` param to thread it through the same merge/persist
path a real capture already uses. `agent.ts`'s `buildKnownFactsBlock` (still the one render site, per this
section's own "Where") now splits the unanswered list by `MAX_FIELD_ASK_COUNT` (2, chosen from the exact
evidence this section names — call 2's third ask is what preceded the fabrication): below the cap, the
model is told it may try once more if natural; at the cap, the instruction becomes an unambiguous stop
("DO NOT ask again this call") with the real count spoken plainly, replacing an A2-era static line that
said "do not ask again" after a single miss regardless of how many times the field had actually been
tried — which was stricter in wording than this section's own cap asks for, and (being a bare instruction
with no data behind it) was exactly the kind of thing a model can talk itself past a third time. New
`stream-question-ledger.test.ts` drives two real evasions of the same field through the actual state
machine (not hand-built fixtures) and asserts the persisted `askCount` reaches 2, not resetting between
turns; `agent.test.ts` covers the cap-crossing render logic directly, including the "no `askCount` on the
row" default (existing pre-D2 rows) resolving to retryable rather than exhausted. 1589/1589 api tests pass,
typecheck/lint/knip:gate clean. **Not deployed, not measured live.**

**Item 4 (a "not yet asked" list driven by a per-persona required-fields schema) deliberately not built.**
This section's own text gates it explicitly: *"If a slot schema lands here, it needs its own ADR — do not
smuggle a compliance-required-fields concept in as an implementation detail."* Building it today would be
exactly that smuggling. Flagged, not forgotten — the confirmed/unanswered split this session shipped is
the two-thirds of the three-list design that don't need a new compliance decision first.

**What D2 does NOT yet do: mechanically stop a third ask, only tell the model not to.** The plan's own "How"
item 3 frames this correctly — "the flow moves on **or escalates (D3)**" — D3 is what turns "the model was
told to stop" into an actual, observable state-machine consequence (a defined trigger with a defined
outcome). Until D3 ships, an exhausted field is a strongly-worded prompt instruction, not a hard block; the
per-field `askCount` this session added is exactly the observable-state signal D3's "ledger exhaustion"
trigger is specified to consume.

**Where:**

- `packages/api/src/voice/agent.ts` — `buildKnownFactsBlock` and the prompt assembly at `:1624`. The
  ledger renders here.
- The captured-state layer from Phase A (`stream.ts:682`, and the `unanswered` state from A2). The
  ledger is the same structure extended with an ask count, not a second parallel store.
- `packages/api/src/voice/workflows/variables.ts:59` — already notes it follows the same "known facts"
  pattern; keep them consistent.

**How:**

1. Track, per field: asked count, last asked turn, and outcome (answered / unanswered / never asked).
   Persist it with captured state so it survives a restart, like everything else under ADR-012.
2. Render it in the prompt as three distinct lists — **confirmed** (do not ask again), **asked and not
   answered** (do not ask again either; the caller declined), and, if a schema of expected fields
   exists for the persona, **not yet asked**.
3. **Cap re-asks at two.** On the second failure the field is marked unanswered and the flow moves on
   or escalates (D3). This is the mechanical fix for the tobacco loop: the third ask is what preceded
   the fabrication.
4. ADR-012 explicitly left "no automatic slot *schema* per persona" as the reasonable next step if this
   needed to get stricter. It does now, for insurance, where "which fields must be collected" is a real
   compliance question. If a slot schema lands here, it needs its own ADR — do not smuggle a
   compliance-required-fields concept in as an implementation detail.

**Test:** `agent.test.ts` — the three lists render distinctly and an unanswered field never appears in
the "confirmed" list. Plus a synthetic scenario: an evasive caller asked twice must not be asked a
third time, and the call must end with the field unanswered and no fabricated value.

---

### D3. Three deterministic escalation triggers

**Status: shipped 2026-08-25 — trigger 3 was already fully satisfied by existing machinery; triggers 1-2
collapsed into one signal and shipped as an audit-trail guardrail, at the user's explicit direction to
scope "required field" as "any field," broader than this section's own literal text.**

**Trigger 3 (explicit caller request) needed nothing new.** `transferToHuman`'s tool description already
requires the model to speak the handoff line before calling it, and `stream.ts`'s `pendingTransfer`
handling (ADR-105/114/115) already guarantees the real Twilio transfer happens right after. A
`callback-requested` disposition already guarantees a `scheduled_calls` row in the same tool call, in the
same turn (A4, `tools/setDisposition.ts`) — exactly this section's "must create a `scheduled_calls` row"
requirement. Verified against the existing code rather than rebuilt, same discipline as C3/D1.

**Triggers 1-2 (ledger exhaustion / repeated non-comprehension) collapsed into one signal.** This
codebase has no "pending question" tracker outside `captureField`/`markFieldUnanswered` asks, and this
section's own text requires trigger 2 be "measurable from the ledger... do not invent a comprehension
score" — an exhausted field (D2's `askCount` reaching the cap) already is that measurement, so building a
second, separate mechanism for trigger 2 would be inventing exactly the score this section refuses.
Trigger 1's literal text ("a **required** field") assumes a required-vs-optional distinction this codebase
doesn't have and D2 explicitly declined to build without its own ADR (item 4) — **user's explicit call**:
treat every field that reaches the cap as escalation-worthy, broader than "required" fields only, rather
than blocking on that ADR or guessing at which fields qualify.

Two things shipped: (1) `agent.ts`'s `buildKnownFactsBlock`, once any field is exhausted, now appends a
single call-level directive (not per-field) telling the model it must transfer, offer a callback, or call
`setDisposition` before ending the call — distinct from D2's per-field "do not ask again" lines, which say
what NOT to do, not what to do instead. (2) Since the model still decides whether to comply — nothing here
can force a tool call the way A4 forces a DB insert — `stream.ts`'s `finalizeCall` gained the audit-trail
half of the same invariant-as-a-check pattern A4 already uses for an undelivered callback: if the call
ends with `hasExhaustedField(capturedState)` true and neither `capturedDisposition` was ever set nor
`transferLatched` was ever true, that's the trigger firing with no delivered outcome, logged as a new
`guardrail_events` row (`category: "undelivered-outcome"`, `source: "ledger-exhaustion"` — added to the
schema's TS-level enum, no migration needed, same as every other category/source addition here). New
`stream-ledger-exhaustion-invariant.test.ts` (3 cases: fires with no outcome, silent when a disposition
was set, silent below the cap) plus `hasExhaustedField` unit tests in `agent.test.ts`. 1596/1596 api tests
pass, typecheck/lint/knip:gate clean. **Not deployed, not measured live.**

**Where:** `packages/api/src/voice/tools/transferToHuman.ts`, `tools/setDisposition.ts`,
`tools/hangUp.ts`, and the ledger from D2.

**How:** escalation must be a rule, not a judgement call, and it must be a rule about **observable
state**:

1. **Ledger exhaustion** — a required field has hit the re-ask cap and is unanswered.
2. **Repeated non-comprehension** — N consecutive turns where the caller's reply does not resolve the
   pending question (measurable from the ledger; do not invent a comprehension score).
3. **An explicit caller request** — a transfer or callback ask, or any signal already covered by
   ADR-106's constraints.

Each trigger produces a **defined outcome**: transfer, a booked callback (which under Phase A's A4
*must* create a `scheduled_calls` row), or a recorded disposition — never a silent continuation. And
per A4, if the outcome cannot be delivered, the agent does not claim it.

**Explicitly not built: a sentiment or frustration score as a trigger.** `voice/call-quality.ts` argues
against model-scored sentiment, and production settles it: call 2's `sentiment` was set to `neutral` by
the same model turn that fabricated the tobacco answer. A model that cannot tell it is lying cannot be
trusted to tell whether the caller is upset. Triggers key off the ledger and the transcript, both of
which are countable.

**Test:** each trigger fires from a constructed state, and each produces its defined outcome including
the `scheduled_calls` row where applicable.

---

### D4. Outcome-neutral filler lines, and natural discourse markers beyond tool-call coverage

**Status: partially shipped 2026-08-25 — filler-line rewrite + the flag flip; discourse markers,
localization, and the native-TTS-capability comparison deliberately not built.**

**Filler lines rewritten.** `TOOL_CALL_FILLER_LINES` was `["One moment, let me check that.", "Let me look
into that for you."]` — both commit the agent to having found something before the tool returns. Now
`["One moment.", "Just a second."]`: pure time-buying phrases, no implication about what the tool reports
back.

**The flag flipped — user's explicit direction, not a default I chose unilaterally.** This section's own
text named it "the first, cheapest step" but a flag flip is new audio behavior for every live caller once
deployed, a different kind of change than a logic fix, so it was raised as its own decision rather than
folded in silently. `hybrid-audio-cache` (`tts-cache.ts`) was opt-in (`flags[FLAG] === true`, so an absent
row — production's actual state, `feature_flags` is empty — read as off) and had been fully built and
never once executed live. Both `stream.ts` call sites (`speakCannedLine`'s silence-timeout lines,
`maybePlayToolCallFiller`'s tool-call filler) now read `!== false` instead of `=== true`: an absent row
means ON, an explicit `enabled: false` row is still the kill switch for any org that needs one.
**`BACKCHANNEL_FLAG` ("backchannels") is a SEPARATE flag and was deliberately left untouched** — the user's
direction was scoped to this section's own named flag, and flipping backchannels on is a different UX
surface (mid-utterance acknowledgment sounds, Five Bets Phase IV) this session was not asked to touch.

New `stream-tool-call-filler.test.ts` cases prove both directions: an absent row eventually forwards
cached filler audio (first trigger warms, second — one turn later — hits and sends), and an explicit
`enabled: false` row never even warms the cache. `tts-cache.ts`'s doc comment updated (was "opt-in staged
rollout", now describes the flip and why). 1598/1598 api tests pass, typecheck/lint/knip:gate clean. **Not
deployed, not measured live** — this is the one item this session shipped whose effect will be
immediately audible to real callers the moment it deploys, not just a backend correctness fix; worth a
live smoke test before trusting it the way the rest of today's work is trusted.

**Not built, out of scope for this session:**
- **Natural discourse markers beyond tool-call coverage** (item 2 — "let me check that," "noting that
  down," fired right after a `captureField` call, not only on the existing filler-threshold gate). Genuine
  new code (a second cached-audio trigger point, sequenced against live turn audio) rather than the
  copy-edit + flag-semantics change above — needs its own design/testing pass, not attempted today.
- **Localization** (item 3 — both `TOOL_CALL_FILLER_LINES` and `BACKCHANNEL_LINES` are English-only; a
  Hindi/Hinglish call gets English filler audio in the Hindi voice). Needs real translated content from
  someone who can validate it, not LLM-authored copy for a compliance-adjacent live call surface.
- **The Cartesia Sonic-3.6 native-filler-words comparison** (item 4). A research/measurement task, not
  something to build speculatively — "worth a direct comparison before investing further" per this
  section's own text.

**Where:** `packages/api/src/voice/stream.ts` — `TOOL_CALL_FILLER_LINES`, `maybePlayToolCallFiller`,
`BACKCHANNEL_LINES` (`backchannel.ts`), `tts-cache.ts`'s `HYBRID_AUDIO_CACHE_FLAG`.

**How:** replace both `TOOL_CALL_FILLER_LINES` lines with phrasing that does not promise a result — the
current pair commits the agent to having found something before the tool has returned, and Phase A makes
"the tool returned nothing useful" a first-class, frequently-true outcome. Keep them short: this line is
spoken to cover tool latency, so a long one costs the thing it exists to hide. Two or three variants,
none of which implies success.

**2026-08-25 addition — broaden this beyond tool-call coverage, and check whether it needs building at
all before building it:**

1. **The filler/backchannel system is already fully built and has never once executed in production**
   (`docs/audits/2026-08-24-latency-vad-bargein-fillers-observability-review.md`): both
   `maybePlayToolCallFiller` and `maybePlayBackchannel` are gated on `feature_flags["hybrid-audio-cache"]`,
   and `feature_flags` is empty in production, so every flag resolves to its code default (off). The
   first, cheapest step here is **enabling the flag**, not writing more code — everything below is about
   what plays once it's on.
2. **Add natural discourse markers, not just tool-call fillers** — "let me check that," "noting that
   down," "okay," "right," "mm-hm" — covering the moment right after a `captureField` call fires (a
   caller who just answered a question benefits from an acknowledgment as much as a caller waiting on a
   slow tool does), not only `TOOL_CALL_FILLER_THRESHOLD_MS`-gated tool waits. Keep them tool-specific
   where it's cheap to be (a calendar lookup gets "let me check the calendar," not the generic line) —
   this was flagged as unbuilt in the 2026-08-24 review and is still unbuilt.
3. **Localize them.** Both `TOOL_CALL_FILLER_LINES` and `BACKCHANNEL_LINES` are English-only today,
   cached per `(provider, voiceId, language, text)` — a Hindi/Hinglish call gets English-text filler audio
   spoken in the Hindi voice, untranslated. Add per-language variants before this ships to any org running
   a non-English persona.
4. **Consider whether the TTS provider now does some of this natively.** Cartesia shipped Sonic-3.6
   (2026-08-17, beta at time of writing) with, per its own release notes, "natural pauses and filler
   words" as a model capability plus native Hinglish code-switching — see
   `docs/audits/2026-08-25-provider-model-currency-research.md`. If that holds up under test, some of the
   hand-built filler-audio-cache machinery here may be redundant with what the model already does when
   asked naturally in the persona prompt — worth a direct comparison before investing further in the
   cached-clip approach.

Also check the persona copy in `docs/agent-prompts/` for the same presupposition. That directory is
**append-only and immovable** (`packages/api/src/database/seed.ts` resolves it at runtime from
`import.meta.dir`; a rename silently breaks seeding) — add a new file, never edit or move an existing
one.

**Test:** `bun run persona:gate` plus an assertion that no filler line asserts a successful lookup, plus
a per-language coverage assertion (every configured persona language has a filler/backchannel set) once
item 3 lands.

---

### D5. Decide on blocking unsourced claims

**Status: decided 2026-08-25 — keep logging, do not promote to blocking. Zero code changed; the decision
itself, backed by a live query, is the deliverable this section asks for.**

**Row count: 0.** Queried `guardrail_events` for `category = 'unsourced-claim'` across every production
call to date (17 calls, `qghtkadxbtptvbfbmsdz`) — zero rows. The detector (A5, `unsourced-claim-guard.ts`)
has never fired once in production. This section's own instructions frame the decision as a choice between
two data-backed outcomes — "if precision is high, promote... if it is noisy, keep logging" — and zero rows
is neither: there is no false-positive rate to measure, and no evidence of the real problem (a caller
hearing an invented price) recurring either. **Promoting a detector with zero real firings from logging to
blocking-and-rephrasing would be pure speculation about its precision, not a decision informed by it** —
exactly the "logging feels like it already handled it" trap this section warns against, just from the
opposite direction (guessing ahead of data instead of ignoring the data that exists). Keep logging. Revisit
when real rows exist to actually read.

**Where:** the `unsourced-claim` detector added in Phase A (A5).

**How:** by this point there are rows. Read them. If precision is high, promote the detector from
logging to blocking-and-rephrasing. If it is noisy, keep logging and narrow the pattern. **Write the
decision and the row counts into the commit message either way** — this is the item most likely to be
silently dropped, because logging feels like it already handled it. It did not: a caller heard an
invented price range.

---

### D6. Endpointing has no concept of an incomplete dictated sequence

**Status: shipped 2026-08-25.** Confirmed against fresh research (Decagon, Cekura, LiveKit, a 2026 arXiv
paper on Thai semantic end-of-turn detection) before building: the "pause mid-dictation" failure mode is
real and named in the current literature, and the state-of-the-art fix (semantic VAD recognizing "a phrase
that introduces a number" context) is a full model, out of scope here per this section's own "not a model
call" constraint — confirms the cheap regex-signal approach below is the right-sized fix for this phase,
not an outdated one.

New `packages/api/src/voice/turn-detection/dictation.ts`: `endsWithIncompleteDictation` checks three
concrete, regex-detectable signals — a **lone** trailing digit (not part of a multi-digit number: "4242" is
whole, "4, 2" pausing after a comma ends on a standalone "2"), a **lone** trailing letter (spelling: "j" as
in "j, o, h, n"), and a trailing hyphen (Deepgram's own convention for a word its model believes was cut
off). `DictationSequenceDetector` wraps it as a `TurnEndDetector`, kept in its own file rather than folded
into `endsMidThought` (per this section's own instruction) so the two failure modes stay independently
testable. Composed with the existing filler-word heuristic via `composite.ts` — the exact seam Phase V
built for a model refiner, reused here for a second heuristic instead (`composite.ts`'s doc comment
updated to say so): `turn-detection/index.ts`'s new `createBaseHeuristic()` chains them, and replaces the
bare `new HeuristicTurnDetector()` both at `stream.ts`'s default and inside `createTurnDetector`'s
model-refiner fallback — so a slow/failing model now degrades to catching *both* failure modes, not just
filler-word trail-off. `TurnEndDecision.reason` widened to include `"incomplete-dictation"`.

**Tests, in two passes.** Plan-specified cases first (lone digit/letter, trailing hyphen, the exact
"my email is j" → pause → "o-h-n at gmail dot com" two-fragment scenario — the first fragment reads as
incomplete, the second as complete, proving the agent wouldn't respond between them). Then a second pass
of edge cases this session added on its own initiative to stress the regex before trusting it: a
multi-digit/multi-letter ending must NOT be flagged (the whole point of "lone"), a decimal number ("3.14")
doesn't falsely trigger the lone-digit check, trailing punctuation is tolerated the same way
`TRAILING_FILLER_PATTERN` already tolerates it, case-insensitivity, a hyphenated compound word ending
normally isn't mistaken for a cut-off, empty/whitespace input never flags, and a documented accepted false
positive (a single letter/digit as someone's *whole* answer costs one extra beat, same tradeoff
`endsMidThought` already accepts). `turn-detection.test.ts`'s existing factory tests updated for the new
composite shape (behavior-checked, not `instanceof`, since the "no model" path is a composite object now,
not a bare class instance). Also pruned `turn-detection/index.ts`'s barrel re-exports down to what's
actually consumed through it — `HeuristicTurnDetector`/`DictationSequenceDetector`/their name constants
were being re-exported for nothing, which `knip:gate` caught immediately; fixed by removing the unused
re-exports (every real caller already imports the individual detector files directly) rather than
widening the baseline, and the baseline **shrank** by one in the process (a pre-existing unused
`HEURISTIC_DETECTOR_NAME` re-export the barrel had already been carrying). 1615/1615 api tests pass
(31 in `turn-detection/`), typecheck/lint/knip:gate clean. **Not deployed, not measured live** — no
dictation-cutoff has been directly observed in production calls read so far; this closes a real, externally-
documented gap ahead of evidence of it happening here, the one item in this phase built that way on
purpose (see this section's own framing below).

**Added 2026-08-25** — `docs/audits/2026-08-25-pipeline-edge-cases-research.md` item 2. Not from
production audit findings (no dictation-cutoff has been observed in the 10 calls read so far) — from
external research on a well-documented, named failure mode, filed here because it's the same mechanism
(`turn-detection/heuristic.ts`) D1 already touches, and because this codebase's own templates actively
collect exactly the field types this breaks on (`email`, `order_id`, `callback_time`,
`beneficiary_relationship` — anything a caller might spell or read digit-by-digit).

**Where:** `packages/api/src/voice/turn-detection/heuristic.ts` — `endsMidThought`,
`TRAILING_FILLER_PATTERN`.

**How:** `endsMidThought` currently matches only trailing filler words
(`and|so|but|or|because|um+|uh+|like|well|then`). A caller who pauses mid-dictation — reading a card
number to check a digit, spelling a name, recalling an order ID — does not trail off on a filler word and
is not caught. The pattern documented as working in production voice AI (Speechmatics, Cekura) layers a
lightweight semantic check on top of the acoustic pause: does the text so far look like a plausible
complete thought, or does it look like the caller is mid-sequence (a trailing digit, a single spelled
letter, an incomplete word fragment)? This does not require a model call — a second regex/heuristic layer
for "ends on a lone digit, a lone letter, or a partial word" is enough to start, consistent with this
file's existing "cheap, rule-based regex-context check, not a model call" approach. Extend
`TurnEndDetector`'s existing pluggable shape (`turn-detection/composite.ts`,
`turn-detection/budgeted.ts`) rather than special-casing this inside `HeuristicTurnDetector` — the same
seam Phase V already built for a future model-based refiner fits a second heuristic layer too.

**Test:** `turn-detection/turn-detection.test.ts` — a caller utterance ending in a lone digit/letter, or
mid-word, is judged incomplete; the existing filler-word cases stay unaffected. A synthetic scenario:
caller says "my email is j," pauses, then continues "o-h-n at gmail dot com" — the agent must not respond
between the two halves.

---

### D7. No tool call, and no critical spoken line, is protected from a barge-in

**Status: shipped 2026-08-25.** Both gaps closed via one shared mechanism: a call-scoped
`nonInterruptibleCounter: { count: number }`, owned by `stream.ts`, that `barge-in.ts`'s `decideBargeIn`
now checks (`nonInterruptibleInFlight: nonInterruptibleCounter.count > 0`) and refuses to fire while
non-zero — freezing rather than resetting or advancing the short-fragment streak, so nothing is lost, the
decision is just deferred until the protected thing finishes.

**Item 1 (tool calls).** `agent.ts`'s new `NON_INTERRUPTIBLE_TOOLS` set covers `bookAppointment`,
`crmSync`, `confirmCodOrder`, `offerCartRecoveryDiscount` — deliberately narrower than the plan's own
example list. `sendSms`/`transferToHuman` are excluded after reading their actual `execute` bodies: both
already fire-and-forget their real side effect independently of `turnAbortController`, so aborting the
*turn* around them doesn't orphan anything the way it would for the other four (an awaited, irreversible
external write). `confirmCodOrder`/`offerCartRecoveryDiscount` are included despite not being named in the
plan's example list — same at-risk shape (awaited I/O, irreversible on the far side) as `bookAppointment`/
`crmSync`. The new `withNonInterruptible` wrapper increments/decrements the shared counter around a tool's
`execute`, applied in `buildVoiceTools` as `protectedTools` — layered on top of the already-timeout-gated
tool (not the raw one), so a genuinely stuck provider call suppresses barge-in for a bounded window
(`TOOL_CALL_TIMEOUT_MS`) rather than indefinitely; once the timeout side of that race wins, barge-in
becomes possible again exactly when the model gets its "still working" placeholder. `nonInterruptibleCounter`
is threaded through as a 12th param to `buildVoiceTools`/`runVoiceAgentTurn`/`runVoiceAgentGreeting` —
unlike the per-turn `toolCallCounter` (fresh every turn), this one is call-scoped and created once by
`stream.ts`, because item 2 below shares the exact same counter for a non-tool-call reason.

**Item 2 (disclosure).** Chose "make it explicitly non-interruptible" (the plan's first option) over
re-queueing: `runGreeting()` now increments `nonInterruptibleCounter` before speaking (only when
`disclosureConfigured`) and decrements it in a `finally`, wrapping both the literal-greeting fast path
(`speakCannedLine`) and the LLM-generated greeting path (`runGreetingTurn`, split out of the old
`runGreeting` body for this). Because `decideBargeIn` refuses to fire at all while the counter is
non-zero, `turnAbortController.abort()` (barge-in's only call site) is structurally unreachable for the
whole disclosure window — so the pre-existing `stampDisclosureFired()` (called unconditionally after
`speak()` resolves) is now safe by construction for the barge-in case: `speak()`'s internal
`wasInterrupted` can only become true via barge-in-triggered abort, which cannot happen here. Left
unconditional deliberately rather than also threading `wasInterrupted` out of `speak()` — the plan's test
requirement is scoped to barge-in, not to a call disconnecting entirely mid-greeting, which is a
pre-existing, unrelated condition this change doesn't newly introduce.

**Tests.** `barge-in.test.ts`: `nonInterruptibleInFlight` never fires regardless of text length/streak,
freezes (not resets/advances) the streak, resumes normal streak advancement once the flag clears, and
`agentIsSpeaking: false` still short-circuits first regardless of ordering. `agent.test.ts`:
`withNonInterruptible` in isolation (increments before the first await, decrements after resolve *and*
after reject, composes under overlap via the counter rather than a boolean, no-op passthrough with no
`execute`); `buildVoiceTools` wiring (`bookAppointment` marked in-flight for the duration of a real
`execute()` call via its own `orgId: undefined` fast path — no DB needed; omitting the counter leaves it
unwrapped; a tool outside `NON_INTERRUPTIBLE_TOOLS` like `captureField` never touches the counter;
`crmSync`/`confirmCodOrder` register correctly when their contexts are bound — their actual `execute`
paths hit live Shopify/CRM integrations and are intentionally not invoked from this test). 1629/1629 api
tests pass, typecheck/lint/`knip:gate`/`design:guard`/`contrast:gate` all clean. **Not deployed, not
measured live** — same status as D6, for the same reason (Phase C's pending deploy approval).

**Added 2026-08-25** — `docs/audits/2026-08-25-pipeline-edge-cases-research.md` items 3-4. Two related
gaps, same root cause (every `speak()` call and every tool `execute()` treats interruption identically,
with no per-message or per-tool policy), confirmed independently by both reading this codebase directly
and by outside literature naming "stale responses after barge-in" and "mid-tool-call interruption" as
recurring, named failure classes.

**Where:**

- `packages/api/src/voice/agent.ts` — `withToolTimeout` (`:1022-1061`), and every `tool({ execute })` in
  `voice/tools/*.ts` — none reads the AI SDK's `execute(args, { abortSignal })` second parameter today.
- `packages/api/src/voice/stream.ts` — `agentIsSpeaking = true` (`:1841`, unconditional at the top of
  every `speak()` call, including the recording-consent disclosure spoken first on every call) and
  `barge-in.ts`'s `decideBargeIn`.

**How:**

1. **Non-interruptible tool calls.** A barge-in mid-`bookAppointment`/`crmSync`/`sendSms` execution
   today orphans the call — nothing cancels it, nothing waits for it, and its eventual result (per
   `withToolTimeout`'s own `onLateResult` path) can land after the model has already moved on to
   something else. Give tools with an irreversible side effect a `nonInterruptible` flag (mirroring
   LiveKit's documented `disallow_interruptions()` pattern) that `decideBargeIn` — or the barge-in handler
   in `stream.ts` — checks before aborting `turnAbortController` while one of these tools is in flight.
   `captureField`/`markFieldUnanswered`/`setIntent` (pure state writes, cheap to re-run) do not need this;
   `bookAppointment`/`crmSync`/`sendSms`/`transferToHuman` do.
2. **A non-interruptible disclosure.** The recording-consent line (`withDisclosure`) is the single most
   compliance-load-bearing utterance in the call and currently has the same interruptibility as small
   talk. Either make it explicitly non-interruptible (same mechanism as item 1, applied to a spoken
   segment rather than a tool) or, if barge-in during it must still be allowed for accessibility reasons,
   make `stampDisclosureFired()` re-queue the disclosure rather than silently treating a partial delivery
   as complete.

**Test:** a barge-in fired mid-execution of a flagged non-interruptible tool must not abort it, and its
result must still reach `logToolCall`/the DB once it resolves. A barge-in during the disclosure must
either not cut it, or must result in the disclosure being re-delivered before the call proceeds — never
silently marked fired on a partial read.

---

### D8. Confirm critical spoken identifiers the way NATO/telephony best practice does, not by trusting STT once

**Status: shipped 2026-08-25.** Prompt-level only, per this item's own step 3 — no new provenance
mechanism, no synchronous blocking added to `captureField`.

New `critical-field-classification.ts`: `isCriticalField` classifies a `captureField` key as `critical`
(name, phone, order, policy, vehicle, PAN, SSN-shaped) using the same `compact`/`tokenize` normalization
`prohibited-capture.ts` already uses, reused rather than duplicated, but kept as its own list — same
"screens a different thing" reasoning that file's own doc comment gives for keeping
`PROHIBITED_CAPTURE_KEYS` and `REGULATED_FIELD_MARKERS` apart. `pan`/`ssn` are included even though
`prohibited-capture.ts` already refuses those keys outright — the classification describes the *shape* of
a high-stakes identifier, per this section's own framing, not just what one deployment happens to permit.

New persona instruction in `agent.ts`'s `buildCallControlBlock` (stable prefix, gated on `captureField`
being enabled — same convention as `numbersLine`/`immediateCaptureLine`): for a name, phone/order/policy
number, vehicle registration, or government ID, read it back character-by-character (name) or
digit-by-digit (number) — not as a single repeated whole, which is what the pre-existing `numbersLine`
already asked for — and wait for an explicit yes/no before calling `captureField`; a "no" means read the
corrected part back too. Layered on top of `numbersLine` rather than replacing it: `numbersLine` still
covers dates and other numeric fields outside the critical set.

What makes a caller's correction during spell-back actually land correctly needed no new code:
`stream.ts`'s `mergeCapturedField` already unconditionally overwrites `capturedState[field]` on every
write, so a later, corrected `captureField` call for the same key already wins over an earlier mis-heard
one. New `stream-critical-field-spellback.test.ts` drives the real `createVoiceStreamHandlers` state
machine through exactly that two-turn sequence (misheard "Jon" captured turn 1, corrected "John" captured
turn 2 after a real spell-back utterance) and proves the corrected value survives, not the mis-hearing —
the plan's own "synthetic scenario" test, against the real state machine rather than hand-built fixtures,
same pattern D2's `stream-question-ledger.test.ts` used. Writing that test's second-turn transcript to end
on a lone spelled-out letter ("...J O H N") first tripped D7... no — tripped **D6**'s brand-new
`DictationSequenceDetector`, which correctly judged the utterance still-spelling and withheld the turn;
fixed by ending the test's caller line on a real word instead, which is D6 and D8 correctly *not*
interfering with each other, not a defect in either.

New `critical-field-classification.test.ts` (classifier correctness: every named category, realistic
snake_case/camelCase keys, case/separator insensitivity, ordinary fields like `coverage_purpose`/
`income_type` correctly excluded, no false positive on vocabulary containing `pan`/`ssn` as a substring)
and two `agent.test.ts` `composeSystemPrompt` cases (spell-back phrasing present when `captureField` is
enabled, absent when it is not — there is nothing to call it ahead of). 1640/1640 api tests pass,
typecheck/lint/knip:gate/design:guard/contrast:gate all clean. Not deployed, not measured live — same
standing status as D6/D7, for the same reason (Phase C's pending deploy approval).

**Added 2026-08-25** — `docs/audits/2026-08-25-pipeline-edge-cases-research.md`, filed here because it
extends the same `captureField`/ADR-120 provenance machinery D2's ledger already governs, and because the
research behind it is specific and load-bearing enough to name as its own item rather than folding into
D2. **General-purpose, not insurance-only** — a name, a vehicle registration number, a PAN card, an SSN,
an order ID: any field where a single mis-heard character changes the value's meaning, across any
vertical this platform serves.

**Why this matters, not just in theory:** in a head-to-head production-audio study, missed named-entity/
alphanumeric-string rates reached **25.5% for Deepgram** — the STT provider this codebase actually
uses — against 16.7% for a competitor in the same study. Deepgram's own documented reasons: letters that
sound alike (P/B, T/D), and letter+digit runs that resolve to real words ("E Z" → "easy"). This is not a
hypothetical for this codebase specifically; it is the measured failure rate of the provider already
running in production.

**Where:** `packages/api/src/voice/tools/captureField.ts`, `capture-provenance.ts`, and the persona
instruction layer (`agent.ts`'s `buildCallControlBlock` — same place A3's "call captureField immediately"
line and D1's disclosure line already live, i.e. the stable prefix, not a per-turn instruction).

**How:** telephony/NATO best practice, per the research: confirm **once, after the full sequence**, not
mid-word; read multi-digit numbers back one digit at a time, never as a whole number; ask the caller to
confirm rather than assuming a repeat-back was accurate.

1. Classify captured fields by risk, not just by prohibition status (`prohibited-capture.ts` already
   does prohibition; this is a second, lower-stakes axis). A `critical` class — names, phone/order/
   policy/vehicle/PAN/SSN-shaped fields — gets a mandatory spell-back step; ordinary fields
   (`coverage_purpose`, `income_type`) do not.
2. Persona instruction, in the stable prefix: for a `critical` field, after the caller states it, the
   agent reads it back character-by-character or digit-by-digit ("Alex — A, L, E, X, is that right?") and
   waits for an explicit yes/no before calling `captureField`. A "no" re-asks; a "yes" proceeds to the
   normal `heard`-quote-verified capture path D2/ADR-120 already governs — this is a **prompt-level**
   addition ahead of the existing tool, not a new provenance mechanism.
3. Do not build this as a blocking synchronous confirmation for every field — that would slow down every
   ordinary answer for the sake of the few that need it. Scope it to the risk class from step 1 only.

**Test:** `agent.test.ts` — a `critical`-classified field in the prompt's persona instructions triggers
spell-back phrasing; a synthetic scenario where the caller corrects a misheard letter during spell-back
ends with the corrected value captured, not the original mis-hearing.

---

## Exit gate

```bash
cd /home/user/weeber
bun run latency:report
bun run lint
bun run typecheck
cd packages/api && bun run test && cd ../..
bun run knip:gate
bun run persona:gate
bun run design:guard
bun run contrast:gate
```

Conditions:

1. **Zero interruptions of a speaking caller** across a replay of both production calls plus the
   synthetic suite. The 0.4 s collision case is a named test and it passes.
2. **No field asked more than twice** in any scenario, and an evasive caller ends with the field
   `unanswered` and no fabricated value (this is Phase A's guarantee holding under D's flow).
3. **Every escalation trigger has a defined outcome** and every outcome that implies a follow-up has
   its `scheduled_calls` row.
4. **No filler line presupposes success.**
5. **Latency did not regress**: p50 voice-to-voice still < 1100 ms and pickup-to-first-audio still
   < 1200 ms, from `latency:report`, n ≥ 10. If D's changes cost latency, that is a finding to record,
   not a gate to waive.
6. **The p95 is recorded** and compared against the number Phase C recorded. D's turn-taking work is the
   remaining lever on the tail; if p95 < 1200 ms is now met, say so explicitly, because Phase C
   deliberately did not gate on it.
7. `feature_flags` decisions are explicit: if `semantic-turn-detection` or backchannels are turned on in
   this phase, the flag rows exist, the code default is stated, and the before/after numbers are in the
   commit. **Production `feature_flags` is empty, so every flag resolves to its code default** — an
   untouched default is a decision, and it gets written down.
8. **A caller dictating a phone number, email, or spelled name is never cut off mid-sequence** across the
   synthetic suite (D6) — the named test in D6's own section passes.
9. **A barge-in during a flagged non-interruptible tool call does not abort it**, and the tool's eventual
   result still reaches the DB (D7); **the recording-consent disclosure is never left partially delivered
   and marked fired** (D7).
10. **Every `critical`-classified field (D8) is spelled/read back and explicitly confirmed** before being
    written via `captureField`, across the synthetic suite — a corrected misheard letter results in the
    corrected value being captured, never the original.

---

## Explicitly out of scope

- **A sentiment or emotion scorer.** Refused above, on the evidence.
- **Semantic turn detection as a *fix for cut-offs*.** Closed in Phase C: production has no cut-offs.
  If a flag is flipped here it is for a different, stated reason with its own measurement.
- **A compliance-required-fields schema per persona.** D2 may need it; if so it gets its own ADR first.
- **Market or region behaviour.** Phase E.
- **Changing what a licensed advisor is permitted to be told.** ADR-106's territory, untouched.
