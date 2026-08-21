# Phase A — Integrity: stop fabricating facts, stop losing leads

**Status:** Approved 2026-08-21 — ready to start, begin at A1
**Blocks:** Phase B (and therefore everything after it)
**Preconditions:** none — this is the first phase
**Evidence:** `docs/audits/2026-08-21-first-two-production-calls.md`, findings 1, 2, 3, 8, 9
**Governing ADR:** ADR-120 (captured-field provenance), amending ADR-012

---

## Why this phase exists

Two calls went out on 2026-08-20. Both completed, both were marked `health_status = healthy`, and both
are broken in ways nothing in the system noticed:

- **Call 2 invented a material underwriting fact.** The agent asked about tobacco use three times
  (transcripts 40, 42, 44), never got an answer, said *"for the sake of our records, I'll mark the
  tobacco use as a no"*, and wrote `{"field":"tobacco","value":"no"}` (`tool_calls` id 20) into
  `calls.capturedState`. Call 1 captured the same field from an actual caller statement. **The two rows
  are indistinguishable.** (Finding 1)
- **Neither call was delivered anywhere.** `crmSync` returned
  `{"crm":null,"synced":false,"message":"(not configured) ..."}` on both, and the code carried on as if
  it had succeeded. `org_integrations` and `webhook_outbox` are empty. (Finding 2)
- **A promised callback does not exist.** Call 2 ended with `setDisposition` =
  `callback-requested` and a `hangUp` reason of `"issue resolved; callback booked"`. `scheduled_calls`
  has **0 rows**. (Finding 2)
- **All captured state is written at hangup.** Call 1 wrote 8 of 12 tool calls inside the same 30 ms at
  `11:55:30.02x`; call 2 wrote 7 of 12 at `17:39:32.18x`. A call that drops loses the entire intake.
  (Finding 3)
- **An unsourced dollar figure went out on the recording** — *"cremation services typically run
  between five thousand and eight thousand dollars"* (call 2, transcript 31). No source, no
  `guardrail_events` row. (Finding 8)

Everything here is a *correctness* defect on a write path. That is why it is Phase A rather than
somewhere convenient: an insurance pilot that returns invented answers or produces no leads cannot be
sold, whereas one that is slow can.

---

## The work

### A1. Give `captureField` provenance, and refuse writes that don't have it

**Status: shipped 2026-08-21.** `heard` is a required argument, the write is verified against this
call's caller-role transcript before it persists, and a non-match is refused with one
`fabricated-capture` guardrail event. Provenance only — A2 (unanswered as an explicit state) is
deliberately still open, so a refused capture currently leaves the field absent rather than marked
asked-and-unanswered. Deviations from the plan text below, both recorded in the commit body: the
`0055` migration backfills legacy rows with an empty `heard` (declared-not-heard) rather than
reconstructing quotes, and the synthetic assertion re-runs the live matcher over the scripted
transcript instead of scoring tool names.

Implements ADR-120. This is the largest task in the phase; do it first because A2 and A3 build on the
shape it introduces.

**Where:**

- `packages/api/src/voice/tools/captureField.ts` — the tool definition (`inputSchema` at :39).
- `packages/api/src/voice/stream.ts:682` — `mergeCapturedField`, the single write path.
- `packages/api/src/voice/stream.ts:693` — the `logToolCall` branch that already screens `captureField`
  for prohibited keys; the new check goes alongside it, not instead of it.
- `packages/api/src/database/schema.ts` — `calls.capturedState` and `callerMemory`'s equivalent column.
- `packages/api/src/voice/agent.ts` — `buildKnownFactsBlock` and `buildTurnPromptParts` (:1379,
  :1624) read the state into the prompt.
- Readers to migrate in the same commit: `voice/tools/crmSync.ts`, `stream.ts:978`
  (`upsertCallerMemory`), `stream.ts:990`/`:2033`/`:2132` (webhook + finalize payloads),
  `app/export.ts:101`–`:119`, and the dashboard call-detail component that renders captured state.

**How:**

1. Add a third field to the tool's `inputSchema`: `heard: z.string().min(1)`, described as *the caller's
   own words this value came from — quote them, do not paraphrase, do not infer*. Update the tool
   description in the same edit so the prompt and the schema say the same thing.
2. Change the stored shape from `Record<string, string>` to
   `Record<string, { value: string; heard: string; transcriptId: number | null; turn: number }>`.
   Add a single `CapturedField` type next to the schema and import it everywhere rather than
   re-declaring the object inline — typecheck failures are the migration checklist, so let them
   happen and work through them.
3. In `mergeCapturedField`, before merging: normalize `heard` (lowercase, strip punctuation, collapse
   whitespace) and check it appears within the concatenated normalized text of this call's
   **caller-role** transcript rows. Keep the caller text in memory as it is appended — do not issue a
   query per capture on the hot path.
4. If it does not match: **do not merge, do not persist**. Return
   `{ captured: false, field, reason: "not-heard" }` to the model, and insert a `guardrail_events` row
   with `category: "fabricated-capture"`, `source: "capture-guard"`, and a detail carrying the field
   key and the unmatched `heard` string. Mirror the existing `regulated-capture` insert at
   `stream.ts:713` — same fire-and-forget shape, same "key/evidence survives, value does not" rule.
5. Keep the prohibited-key screen first. A prohibited key must be refused before its `heard` is
   examined, so a rejected SSN never has its digits written into a guardrail detail.

**Tests:**

- `packages/api/src/voice/tools/captureField.test.ts` — extend for the three-arg shape; assert a
  missing/empty `heard` fails schema validation.
- New: `packages/api/src/voice/stream-capture-provenance.test.ts` — a captured field whose `heard` is
  in the caller transcript merges; one that is not is refused, produces no state change, and writes one
  `guardrail_events` row. Include the literal call-2 case: caller says *"just do some kind of drinks"*,
  the model attempts `{field:"tobacco", value:"no", heard:"no"}` — must be refused.
- `packages/api/src/voice/synthetic-scenarios.ts` — add the `fieldNeverFabricated` assertion type
  (implement it in the checker used by `synthetic-test.test.ts:32`) and add an evasive-caller scenario
  that asks a material question three times and never answers it. Expected outcome: field unanswered.

---

### A2. "Unanswered" must be a state, not an omission

**Where:** `voice/tools/captureField.ts` (or a sibling tool — decide at implementation time and record
which in the commit), `stream.ts`'s state merge, `agent.ts`'s `buildKnownFactsBlock`, the dashboard
call-detail view.

**How:** A field the caller declined or evaded is recorded explicitly as unanswered — an entry with a
null value and the `heard` of the evasion — never guessed and never left absent. `buildKnownFactsBlock`
must render unanswered fields in their own list, phrased so the model treats them as *asked and not
answered* rather than *unknown, go ask again* — this is what breaks the three-ask loop from finding 4
without needing the full question ledger (which is Phase D).

Downstream, **unanswered and never-asked must render differently** in the dashboard and in the CRM
payload. An advisor reading a lead needs to know the difference between "we asked and they wouldn't
say" (a signal) and "we never got there" (an incomplete call).

**Test:** extend `packages/api/src/voice/agent.test.ts` — a state containing one answered and one
unanswered field renders two distinct blocks, and the unanswered field does not appear in the
"already confirmed, do not ask again" list.

---

### A3. Persist captured state per turn, not at hangup

**Where:** `packages/api/src/voice/stream.ts` — `mergeCapturedField` (:682) already persists on every
call and is correct. The defect is upstream: the *model* emits its `captureField` calls in a batch at
the end. Sites to look at: the tool-call handling around `:693`–`:805`, the finalize path at
`:978`–`:1007`, and the turn assembly in `agent.ts`.

**How:** this is a prompt-and-flow fix, not a persistence fix.

1. The persona/system prompt must require the capture on the turn the fact is stated. `captureField`'s
   description already says *"Call this immediately after the caller states such a fact — do not wait
   until the end of the call"* (`tools/captureField.ts:36`) and production ignored it, so the
   instruction also needs to be in the composed persona, i.e. inside `stablePrefix`, not only in the
   tool description. **Put it in the stable prefix, not the dynamic suffix** — Phase C depends on that
   prefix being stable, and a per-turn-varying instruction would poison the prompt cache.
2. Add a counter: number of `captureField` calls occurring in the final turn versus earlier turns.
   Cheapest place is the existing tool telemetry (`onToolTelemetry` at `stream.ts:1994`/`:2131`). Phase
   B turns this into a reported metric; here it just needs to be recorded.

**Why it matters beyond data loss:** the terminal turns are also the slowest turns in both calls (call
1 turn 11: TTFT 3582 ms, v2v 4031 ms; call 2 turn 18: TTFT 4436 ms, v2v 4846 ms with 319 output tokens
against a typical 40–77). Moving the batch off the last turn removes the worst latency number we have.
That benefit is *collected* in Phase C; the change belongs here because it is the same edit.

**Test:** `packages/api/src/voice/stream-*.test.ts` — assert the counter distinguishes a mid-call
capture from a terminal-turn one. The behavioural half is a synthetic scenario, not a unit test: a
scenario where the caller states a fact early and the call is cut short must still show that fact in
`capturedState`.

---

### A4. `synced: false` is not success, and a promise must create a row

Two defects, one theme: an outcome the system reports but never delivers.

**Where:**

- `packages/api/src/voice/tools/crmSync.ts:92` — the `{ synced: false, message: "(not configured) ..." }`
  return.
- `packages/api/src/voice/tools/setDisposition.ts` — where `callback-requested` is set.
- `packages/api/src/voice/tools/hangUp.ts` — the reason string that claimed the callback was booked.
- `packages/api/src/voice/workflows/scheduler.ts:135`, `:261`–`:311` — the `scheduled_calls` reader and
  the immediate-dispatch path. This is what a booked callback must produce a row for.
- `packages/api/src/database/schema.ts` — `webhookOutbox`, `scheduledCalls`.

**How:**

1. **Make the no-CRM case loud.** `crmSync` returning `synced: false` must (a) tell the model plainly
   that the record was **not** delivered, so it does not tell the caller it was, and (b) write a
   durable row — a `webhook_outbox` entry or a `guardrail_events` row of category
   `undelivered-outcome`. Right now a completed call with a full intake and zero delivery is
   indistinguishable, in the database, from a delivered one. Do not fail the call: an org without a CRM
   configured is a legitimate state. The requirement is that it is *visible*, and that the caller is
   never told a record was filed when it was not.
2. **A promised callback creates a `scheduled_calls` row in the same transaction as the disposition**,
   or the agent is not permitted to promise one. Prefer the former: on `callback-requested`, insert a
   `pending` row (using the captured `callback_time` if present — which now carries provenance from A1,
   so a callback time cannot be invented either). If the insert fails, the disposition must not claim a
   booking, and `hangUp`'s reason must not either.
3. **Add the invariant as a check, not a hope.** A finalized call whose disposition implies a follow-up
   and which has no corresponding `scheduled_calls` row is a defect. Assert it in the finalize path and
   record it. Phase B counts these.

**Tests:**

- `packages/api/src/voice/tools/crmSync.test.ts` — the not-configured path returns an explicitly
  undelivered result and produces the durable row.
- New: `packages/api/src/voice/workflows/scheduler-callback-invariant.test.ts` —
  `callback-requested` produces exactly one `pending` `scheduled_calls` row; a failed insert does not
  yield a call claiming the callback was booked.

---

### A5. An unsourced price claim is a guardrail event

**Where:** `packages/api/src/voice/tools/flagGuardrailEvent.ts` and the heuristic detector referenced
at `org-queries.ts` (`"guardrail-heuristic-detector"`); the agent-side text path in `stream.ts` where
model output is emitted to TTS.

**How:** add a narrow deterministic detector over outbound agent text for **unsourced quantitative
claims about price or cost** — currency figures and spelled-out amounts ("five thousand to eight
thousand dollars") in a sentence that carries no source. It writes a `guardrail_events` row of category
`unsourced-claim`. It does **not** block the utterance in this phase: the false-positive rate is
unknown, and blocking mid-sentence is a worse failure than logging. Collect rows first; decide about
blocking with data, in Phase D.

Also update the insurance persona in `docs/agent-prompts/` — **by adding a new file, never editing an
existing one** (that directory is append-only and, per ADR-118 and the runtime resolution in
`packages/api/src/database/seed.ts`, also immovable) — to state that costs are quoted only from
provided material.

**Test:** `packages/api/src/voice/*guardrail*.test.ts` — the literal call-2 sentence produces one
`unsourced-claim` row; a sentence quoting a figure with an attached source does not.

---

## Exit gate

All of the following must hold. Phase B does not start until they do.

```bash
cd /home/user/weeber
bun run lint
bun run typecheck
cd packages/api && bun run test && cd ../..
bun run knip:gate
bun run persona:gate
bun run design:guard
bun run contrast:gate
```

Plus these specific conditions:

1. **The call-2 fabrication cannot be reproduced.** The replay/synthetic scenario built in A1 ends with
   `tobacco` unanswered and one `fabricated-capture` guardrail row. No fabricated field reaches
   `capturedState`.
2. **The call-1 honest capture still works.** The same field, stated by the caller, is captured with
   `heard` populated and a non-null `transcriptId`.
3. **Every promise has a row.** A `callback-requested` disposition with no `scheduled_calls` row is
   impossible, asserted by the A4 test.
4. **Undelivered is visible.** A completed call with `synced: false` produces a durable row that a
   query can find. Verify against the production read-only connection that the query returns the two
   existing calls as undelivered.
5. `bun run knip:gate` passes **without** widening `tools/dead-code/knip-baseline.json`, and
   `design:guard` passes without widening `tools/ui-guard/design-budget.json`. Widening either is not
   an acceptable way to pass this gate.
6. The migration of `capturedState`'s shape has been applied and the two existing production rows read
   correctly under the new type.

Remote CI is red for billing reasons unrelated to this work and is out of scope; **local green is the
accepted bar** for this plan.

---

## Explicitly out of scope

- **Anything latency.** Even the terminal-turn tail that A3 incidentally fixes — the *measurement* of
  it belongs to B and the *credit* for it to C. Do not tune a timeout in this phase.
- **The question ledger** (nothing asked twice, tracked properly). A2's unanswered state is the
  narrow fix that stops fabrication; the general ledger is D2.
- **Idle-prompt and barge-in rework.** Finding 4's interruption defect is Phase D. It is a
  conversation-quality bug, not an integrity bug — nothing false is written.
- **Encrypting `orgs.twilio_auth_token`** (audit, smaller items). Real, recorded, not a launch blocker,
  and it touches the credential path — separate change, separate review.
- **A sentiment scorer.** Refused, see `docs/plans/README.md`.
- **Blocking unsourced claims mid-utterance.** A5 logs only, deliberately.
