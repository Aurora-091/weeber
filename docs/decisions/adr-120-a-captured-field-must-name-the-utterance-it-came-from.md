---
adr: 120
title: "A captured field must name the utterance it came from"
date: 2026-08-21
status: Accepted
---

## ADR-120 — A captured field must name the utterance it came from
**Date:** 2026-08-21
**Status:** Accepted — amends ADR-012

**Context:** ADR-012 made `calls.capturedState` the ground truth for a call and demoted the transcript
to scrollback: "structured call state as ground truth, not the transcript". The first two production
calls (`docs/audits/2026-08-21-first-two-production-calls.md`, finding 1) produced the exact case that
inverts that sentence.

On call 2 the agent asked for tobacco use three times (transcripts 40, 42, 44). The caller never
answered — the nearest thing to a reply was "just do some kind of drinks". The agent then said, on the
recording, *"for the sake of our records, I'll mark the tobacco use as a no,"* and called
`captureField` with `{"field":"tobacco","value":"no"}` (`tool_calls` id 20). That value landed in
`calls.capturedState` and went into the `crmSync` payload addressed to a licensed insurance advisor.
Tobacco use is a material underwriting fact. It was manufactured by the agent to close a loop.

Call 1 captured the same field honestly: the caller stated it (transcript 12) and the agent recorded
it. Both calls produce a byte-identical row. **Nothing downstream — dashboard, export, CRM payload,
`caller_memory` — can tell a stated fact from an invented one.** That is the defect, and it is a
property of the schema, not of the model: `Record<string, string>` has nowhere to put provenance, so
there was never anything to check.

Three existing guards all miss it, each for a coherent reason:

- **ADR-106** constrains what the agent *says*. Here what the agent said was honest — it announced the
  assumption out loud. The write is the lie.
- **`screenCapture` / `prohibited-capture.ts`** (wired at `stream.ts:709` and inside
  `tools/captureField.ts:52`) screens the *key*. `tobacco` is a legitimate key; it is on nobody's
  prohibited list, and should not be.
- **The synthetic scenarios** (`voice/synthetic-scenarios.ts:304`, `:346`) assert `toolNeverCalled`
  for prohibited keys and third-party attribution. There is no assertion of the form "this field was
  captured and the caller never said it", because there is no artifact that would let one exist.

`captureField`'s own description already carries the rule in prose — *"Record a durable fact the caller
has just told you"* (`tools/captureField.ts:32`) — and the tool obeyed it precisely 0% of the time it
mattered. A rule stated only in a prompt is a preference. This ADR makes it a schema constraint.

**Decision:** A captured field must carry the caller utterance it came from, and a field with no
utterance behind it is not written.

1. **`captureField` takes a third required argument: `heard`** — a short verbatim quote of the caller
   words the value came from. It is required, `min(1)`, and it is *not* free-form narration: the tool
   description states it must be words the caller said, not the agent's paraphrase or inference.

2. **`capturedState` becomes provenance-bearing.** Each entry is
   `{ value: string; heard: string; transcriptId: number | null; turn: number }` rather than a bare
   string. `mergeCapturedField` (`stream.ts:682`) records the id of the most recent caller-role
   transcript row at merge time. Every existing reader — `buildKnownFactsBlock` (`agent.ts`), the
   `crmSync` payload, `upsertCallerMemory` (`stream.ts:978`), the dashboard, `app/export.ts` — reads
   `.value` and is otherwise unchanged in behaviour.

3. **The write is verified against the transcript, in code, before it persists.** In
   `mergeCapturedField`, `heard` is matched against the caller-role transcript text of the current
   call. A field whose `heard` does not appear in anything the caller actually said is **refused**:
   the value is not merged, not persisted, not sent to `crmSync`, and the model is told
   `{ captured: false, reason: "not-heard" }` so it asks again instead of assuming. Matching is
   normalized (case, punctuation, whitespace) and forgiving on subset — it is checking that the words
   exist, not grading transcription.

4. **A refusal is a `guardrail_events` row**, category `fabricated-capture`, source `capture-guard`,
   detail carrying the field key and the unmatched `heard` — the same shape and the same reason as the
   `regulated-capture` refusal at `stream.ts:713`. The evidence survives; the value does not.

5. **"Unanswered" is a real, expressible state.** A field the caller declined or ignored is recorded
   as unanswered — an explicit entry with no value — never as a guessed value, and never by omission.
   Downstream, unanswered and never-asked are different facts and must render differently. Phase A
   owns the surface; this ADR fixes the representation.

6. **The synthetic suite gains the assertion this defect needed.** A new assertion type
   (`fieldNeverFabricated`) fails a scenario when `capturedState` contains a field whose `heard` is
   absent from the caller's lines — and a scenario is added in which the caller is asked a material
   question three times and evades it every time, i.e. call 2, replayed. It must end with the field
   unanswered.

**Rejected:**

**Leaving it to the prompt — a stronger "never assume" instruction.** This is what already exists, in
the tool description, in exactly the words that would have prevented it. The model read that
description on every turn of call 2 and fabricated anyway, then narrated the fabrication. Prompt text
cannot be a control for a write to ground truth; ADR-088's lesson (a guard whose only effect was to
report the breach afterwards) is the same lesson one layer up.

**An LLM judge over the transcript after the call.** Post-hoc detection does not stop the row from
reaching the CRM, which is where the harm lands, and it puts a fabrication-prone component in charge
of catching fabrication. Deterministic string matching against what the caller literally said is a
weaker check that cannot itself invent an answer — the right trade for a write path.

**A confidence score on the value.** A number lets the model express "0.6 sure the answer is no" and
lets every reader pick its own threshold, which reproduces the ambiguity in a form that looks
quantitative. Provenance is binary here on purpose: the caller said it, or nobody did.

**Restricting this to underwriting-material fields.** A material-field list is a compliance artifact
this project does not have, would need per vertical, and would be wrong the first time the insurance
templates change. Every field is cheaper to constrain uniformly, and `heard` costs the model a handful
of tokens.

**Making the transcript ground truth instead (reversing ADR-012).** ADR-012's reasoning holds
completely — a growing transcript is not a state store, and re-asking is the failure it fixed (which
call 2 also exhibits, four times over, per audit finding 4). The transcript is not a better ground
truth; it is the *witness*. This ADR requires ground truth to cite its witness, which is a stricter
version of ADR-012, not a retreat from it.

**Consequences:**

- `calls.capturedState` changes shape. There are 2 rows in production, both from calls that are
  already closed and neither delivered anywhere (audit finding 2), so the migration is a rewrite of
  two JSON blobs, not a data-preservation problem. Any reader still expecting `Record<string, string>`
  breaks loudly at typecheck, which is the intent — `caller_memory` (2 rows) reads the same shape and
  must be migrated in the same commit.
- The failure mode moves from "silently wrong record" to "visibly incomplete record". A pilot org will
  see fields come back unanswered where it previously saw a confident `no`. That is the correct
  direction and needs to be said out loud in the pilot conversation, not discovered by them.
- Recall of legitimate captures will drop somewhat: a caller who answers in a way the STT mangles will
  produce a `heard` that fails to match, and the field goes unanswered instead of captured. Refusals
  are counted in `guardrail_events` precisely so this rate is measurable rather than argued about; if
  `fabricated-capture` fires on honest answers more than rarely, the matcher is wrong and gets fixed
  against those rows.
- `captureField`'s three-argument shape is more expensive per call in tokens and slightly slower to
  emit. Accepted without measurement: a fabricated underwriting field is not tradeable against
  latency.

**Known and unfixed:**

- A caller can state something false, and this ADR will faithfully record it with provenance. It
  buys traceability to an utterance, not truth.
- The matcher cannot distinguish "the caller said the words, about something else" from "the caller
  answered this question". A model determined to satisfy the check could quote an unrelated fragment.
  This raises the cost of fabrication from zero to deliberate; it does not make it impossible.
- Provenance stops at the call boundary. A field arriving via `caller_memory` from an earlier call
  carries that call's `heard`, and a field seeded from `leads` before dialling (`stream.ts:2662`) has
  no utterance at all and is marked as declared-not-heard. Nothing yet renders that distinction to an
  operator.
- `calls.sentiment` is still written by the model via `setDisposition`, and on call 2 it was set to
  `neutral` by the same turn that fabricated the tobacco field. This ADR does not touch it. Phase D
  refuses to build a sentiment scorer at all; that column's future is unresolved.
