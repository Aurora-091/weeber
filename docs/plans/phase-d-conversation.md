# Phase D — Conversation intelligence

**Status:** Blocked on Phase C
**Blocks:** Phase E
**Preconditions:** Phase C's exit gate met, with the achieved p95 recorded in that phase's closing
commit. D changes turn structure and will move those numbers; there must be a recorded baseline to move
them from.
**Evidence:** `docs/audits/2026-08-21-first-two-production-calls.md`, findings 4, 8 and the sentiment
item under "smaller items"
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
   write the evidence down next to the constant.
4. **An idle line must be interruptible.** If the caller speaks while it is playing, it stops. That is
   a barge-in requirement, and it must hold for the greeting too.

**Test:** new `packages/api/src/voice/stream-idle-prompt.test.ts` — caller speech arriving 100 ms after
the timeout fires, and again mid-synthesis, must both prevent or cut the idle line. Encode the call-2
timing (0.4 s gap) as a named fixture citing the audit.

---

### D2. A question ledger — nothing gets asked twice

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

### D4. Outcome-neutral filler lines

**Where:** `packages/api/src/voice/stream.ts:1292` (`TOOL_CALL_FILLER_LINES`), used at `:1327`.

**How:** replace both lines with phrasing that does not promise a result — the current pair commits the
agent to having found something before the tool has returned, and Phase A makes "the tool returned
nothing useful" a first-class, frequently-true outcome. Keep them short: this line is spoken to cover
tool latency, so a long one costs the thing it exists to hide. Two or three variants, none of which
implies success.

Also check the persona copy in `docs/agent-prompts/` for the same presupposition. That directory is
**append-only and immovable** (`packages/api/src/database/seed.ts` resolves it at runtime from
`import.meta.dir`; a rename silently breaks seeding) — add a new file, never edit or move an existing
one.

**Test:** `bun run persona:gate` plus an assertion that no filler line asserts a successful lookup.

---

### D5. Decide on blocking unsourced claims

**Where:** the `unsourced-claim` detector added in Phase A (A5).

**How:** by this point there are rows. Read them. If precision is high, promote the detector from
logging to blocking-and-rephrasing. If it is noisy, keep logging and narrow the pattern. **Write the
decision and the row counts into the commit message either way** — this is the item most likely to be
silently dropped, because logging feels like it already handled it. It did not: a caller heard an
invented price range.

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

---

## Explicitly out of scope

- **A sentiment or emotion scorer.** Refused above, on the evidence.
- **Semantic turn detection as a *fix for cut-offs*.** Closed in Phase C: production has no cut-offs.
  If a flag is flipped here it is for a different, stated reason with its own measurement.
- **A compliance-required-fields schema per persona.** D2 may need it; if so it gets its own ADR first.
- **Market or region behaviour.** Phase E.
- **Changing what a licensed advisor is permitted to be told.** ADR-106's territory, untouched.
