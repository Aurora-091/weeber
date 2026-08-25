# Phase D — Conversation intelligence

**Status:** In progress (2026-08-25) — started at the user's explicit direction. Phase C is code-complete
(all four sub-phases) and pushed, but its exit gate's live-measurement conditions are pending a manual
Railway deploy approval outside this session's reach (see `phase-c-latency.md`'s closing status). A
pre-deploy baseline is recorded there (v2v p50 1481ms, p95 3463ms) to satisfy this section's own
precondition well enough to start; whoever approves the pending deploys should re-run `latency:report`
against real post-deploy calls and reconcile that baseline before this phase's own exit gate condition 5/6
(latency-regression / p95-comparison) are trusted.
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

**Where:** the `unsourced-claim` detector added in Phase A (A5).

**How:** by this point there are rows. Read them. If precision is high, promote the detector from
logging to blocking-and-rephrasing. If it is noisy, keep logging and narrow the pattern. **Write the
decision and the row counts into the commit message either way** — this is the item most likely to be
silently dropped, because logging feels like it already handled it. It did not: a caller heard an
invented price range.

---

### D6. Endpointing has no concept of an incomplete dictated sequence

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
