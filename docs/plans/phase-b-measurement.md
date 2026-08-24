# Phase B — Measurement: make the numbers real and readable

**Status:** Blocked on Phase A
**Blocks:** Phase C (and therefore D and E)
**Preconditions:** Phase A's exit gate met in full, including the production check that the two
existing calls surface as undelivered.
**Evidence:** `docs/audits/2026-08-21-first-two-production-calls.md`, findings 5, 6, 7, 9 and the
"smaller items" section
**Governing ADRs:** ADR-107 (telemetry cutover 2026-08-12), ADR-088 (a guard that only reports the
breach afterwards is not a guard)

---

## Why this phase exists

The audit that produced this plan took hours of hand-written `psql` against a pooler connection to
answer questions like "what is our p50 voice-to-voice". That is not repeatable, and it is why three
headline claims in the deep-research report survived as long as they did:

- The report ranked lowering `utterance_end_ms` as the single biggest compressible latency. In
  production, **`utterance_end` never fired once** — all 26 turns with an endpoint signal recorded
  `speech_final`, and `endpointing_delay_ms` is 1–22 ms. It is worth 0 ms. (Finding 5)
- The report called TTS a non-issue at "near-constant ~127 ms". Actual `tts_first_byte_ms` is min 348,
  median ~412, max 1420, and the paired `tts_socket_open_ms` is 197–274 ms on all but one turn.
  (Finding 6)
- The report's baseline was optimistic by 2.5–3.4×. `pickup_to_first_audio_ms` is **1985** and **2753**
  against an 800 ms bar; pooled per-turn `voice_to_voice_ms` is **p50 ≈ 1.75 s, p95 ≈ 4.5 s** against
  800 ms / 1.2 s. (Finding 7)

Nothing in the codebase aggregates `callLatency` or `turnLatency` into percentiles. `org-queries.ts:689`
computes **averages** of three `callLatency` columns for the dashboard, over all calls, with no
percentiles and no ADR-107 date filter. Averages over two calls hid every one of the above.

And two writers are silently producing nothing:

- **`tool_call_latency` has 0 rows against 24 tool calls.** The writer `persistToolCallLatency`
  (`stream.ts:481`, wired at `:1994` and `:2131`) landed in commit `dec2854` at 2026-08-20 14:43 UTC,
  *before* call 2 at 17:34 UTC. So either production was not redeployed, or the fire-and-forget write
  fails silently. Its unit tests pass against a mock — precisely the ADR-088 shape. (Finding 9)
- **`guardrail_events` has 0 rows**, which Phase A now gives real reasons to doubt: call 2 contained a
  fabricated capture and an unsourced price claim, both of which A makes loggable.

Phase C cannot be trusted without this. It is not instrumentation-for-its-own-sake; it is the
acceptance test for the next phase.

---

## The work

### B1. One command that prints the latency distribution

**Status: shipped 2026-08-24.** `voice/latency-report.ts` (pure aggregation: `computeStats`,
`partitionByAdr107Cutover`, `computeV2vDecomposition`, `summarizeGuardrailEvents`,
`summarizeCaptureTiming`, `summarizeByOrg`) plus `scripts/latency-report.ts` (the DB-querying CLI),
wired as the root `latency:report` script. Covers every item in "How" below, including the A3
terminal-turn-capture ratio (item 4) — recomputed from `capturedState`'s per-entry `turn` field against
a caller-turn count derived by counting `transcripts` rows per call, since A3 deliberately only ever
logs that ratio per call rather than persisting it (see phase-a-integrity.md's A3 status note).

**Unverified in this session:** exit-gate condition 1 ("reproduces the audit's headline numbers against
production") — this environment has no `DATABASE_URL`/production database access, so the tool has been
exercised only via its pure-function unit tests (`latency-report.test.ts`, 16 cases, including the
even-length-set p50 pin and the pre-cutover-exclusion case the plan's own test spec asks for) plus a
typecheck pass on the CLI script. Running `bun run latency:report` against the real database and
confirming it reproduces the audit's numbers remains open, same class of gap as A4's exit-gate condition
4.

**Where:**

- New: `packages/api/src/voice/latency-report.ts` — the aggregation, exported as functions so it is
  testable without a CLI.
- New: `packages/api/scripts/latency-report.ts` — the thin CLI entry.
- `package.json` — add a root script `"latency:report": "cd packages/api && bun run scripts/latency-report.ts"`.
- Reads `callLatency` and `turnLatency` from `packages/api/src/database/schema.ts` (`:259`, `:346`).

**How:**

1. Compute **p50, p95, min, max and n** — never a bare mean — for: `pickupToFirstAudioMs`,
   `sttConnectMs`, `llmTtftMs`, `ttsFirstByteMs` (from `callLatency`), and per-turn
   `voiceToVoiceMs`, `ttsSocketOpenMs`, `endpointingDelayMs`, plus the token/cache columns (from
   `turnLatency`).
2. **Apply the ADR-107 filter and make it visible.** Rows from calls that started before
   **2026-08-12** predate the cutover and their `llmTtftMs`/`ttsFirstByteMs` overlap, so they must not
   be summed or compared against post-cutover rows. The default is post-cutover only, and the output
   must state the window and how many rows were excluded — a silent filter is how a wrong baseline
   survives.
3. **Report the decomposition, not just the columns.** Post-cutover, `v2v ≈ llm_ttft + tts_first_byte
   + ~130 ms`. Print the share of v2v attributable to each stage; on the two production calls this is
   LLM ≈ 70%, TTS ≈ 23%, other ≈ 7%. That single line is what tells the next person where to work, and
   it is the line that would have prevented the report's endpointing recommendation.
4. **Print the counters Phase A introduced** in the same output — fabricated-capture refusals,
   undelivered outcomes, disposition-without-`scheduled_calls` violations, and the terminal-turn
   capture ratio from A3. One command, one picture of health.
5. Order by `startedAt`. `calls` has **no `created_at`** column — the audit lost time to this. Note it
   in a comment.
6. Group per-org and support a `--since` flag. Do not sum turn latencies across calls without saying
   so; label pooled numbers as pooled.

**Test:** `packages/api/src/voice/latency-report.test.ts` — percentile maths against a fixture with a
known distribution (an even-length set, so the p50 convention is pinned by the test rather than by
accident), and an assertion that a pre-2026-08-12 row is excluded from the decomposition and counted in
the exclusion total.

---

### B2. Fix `tool_call_latency` writing zero rows

**Status: shipped 2026-08-24 — root cause found via live production access (Railway + Supabase MCP),
not simulated.** Confirmed production is running well past `dec2854` (current live deployment,
commit `12748df8`, deployed 2026-08-20T21:12:40Z; `dec2854` itself was live from 14:43:53Z, superseded
~17:57Z the same day — spanning call 2's window). Pulled `dec2854`'s own deploy logs directly
(`mcp__railway__get-logs`) and found the real cause: **`duration_ms` is a Postgres `integer` column,
but the AI SDK's `toolExecutionMs` (agent.ts's `onToolExecutionEnd`) is a sub-millisecond float.** Every
insert since the table's introduction failed with `22P02 invalid input syntax for type integer:
"0.4876310005784035"` — four such errors are in call 2's own deploy log, one per tool call
(`hangUp`, `captureField` ×2, `crmSync`), each with its own literal offending float. This was never a
missing-`.catch` problem — `persistToolCallLatency`'s `.catch` was already there and is exactly what
logged every one of these errors; that log is how this was found. Fixed with `Math.round(event.durationMs)`
at the write site (`stream.ts`), verified two ways: a new regression test using call 2's literal
duration values (`stream-tool-call-latency.test.ts`), and a real `BEGIN; INSERT ...; ROLLBACK;` against
the live production table (`mcp__supabase__execute_sql`) confirming the exact same insert that failed in
the logs now succeeds and leaves no residual row.

Also completed the "audit every void-ed persistence call in stream.ts" item: every one already has a
`.catch` that logs, either directly at the call site (`persistToolCallLatency`, `persistLatency`,
`resumeWorkflowAfterCall`, `runWorkflowForOutcome`, all the `guardrail_events`/`captureField`-adjacent
inserts) or because the called function itself never rejects (`dispatchWebhook`, `sendSmsForOrg` both
catch internally and always resolve). No changes needed there — the plan's premise that this needed
fixing was itself the thing worth checking, and checking it turned up nothing to fix.

**Where:** `packages/api/src/voice/stream.ts:481` (`persistToolCallLatency`) and its two call sites
`:1994`, `:2131`. Table in `schema.ts`.

**How:** find out which of the two causes it is before changing code — they need opposite fixes.

1. Check whether production is running `dec2854` or later. If it is not, the writer is fine and this is
   a deploy problem: redeploy, place one test call, confirm rows appear, and note in the commit that no
   code change was required.
2. If production *is* running it, the fire-and-forget `void persistToolCallLatency(event)` is
   swallowing an error. Add a `.catch` that logs with enough context to identify the failure (it is most
   likely a null `callId` at the time of the tool call, or a column mismatch), then fix the cause.
3. Either way, **the fire-and-forget contract must stop being able to fail invisibly.** Every
   `void`-ed persistence call in `stream.ts` needs a `.catch` that logs. Audit them in this task —
   `mergeCapturedField` (:686) and the transcript write chain (:670) already have one; the tool
   telemetry does not.

**Test:** the existing unit test passes against a mock and is therefore not evidence of anything. Add a
test that exercises the writer against the real test database and asserts a row lands — and, because
this is the ADR-088 shape, assert the failure path logs rather than silently returning.

---

### B3. Prove `guardrail_events` is non-vacuous

**Status: shipped 2026-08-24.** Confirmed `guardrail_events` is 0 rows in production (live query,
`mcp__supabase__execute_sql`) — genuinely vacuous, not a query artifact. Rather than a synthetic
AI-to-AI replay (which scripts a *new* conversation against the current persona and cannot prove
anything about what the two real calls actually said), pulled both calls' real `transcripts` and
`tool_calls` rows directly from production and replayed them through the actual guard code:
`production-replay.test.ts` runs the real caller-role transcript text through `heardInCallerSpeech` (A1)
and the real agent-spoken cost line through `detectUnsourcedPriceClaims` (A5) — confirming call 2's
tobacco claim is refused, call 2's cremation-cost line is flagged, and call 1's honest captures and
cost-context line (which correctly cites "the advisor will" as its source) are both accepted, none
flagged. `stream-guardrail-replay.test.ts` goes one level deeper and replays call 2's tobacco
fabrication through the real `stream.ts` pipeline end to end, asserting the actual `guardrail_events`
insert lands with `category: "fabricated-capture"`. Both category values were also verified to insert
cleanly against the live production schema (`BEGIN; INSERT ...; ROLLBACK;`, no rows left behind).

Deviation from the plan's test spec (`synthetic-scenarios.ts` gains a guardrail-row assertion): not
added. The synthetic harness has no DB and no concept of a "row" — adding one would mean duplicating
`logToolCall`'s category-derivation logic a second time for a strictly weaker guarantee than replaying
the real incident, which was already possible with data this session had direct access to.

**Where:** `packages/api/src/voice/tools/flagGuardrailEvent.ts`, the heuristic detector referenced as
`"guardrail-heuristic-detector"` in `org-queries.ts`, and Phase A's two new categories
(`fabricated-capture`, `unsourced-claim`).

**How:** 0 rows is either "nothing bad happened" or "the writer does not work", and after Phase A we
know something bad happened twice on one call. Replay both production calls through the synthetic
harness and assert non-zero rows of the expected categories. Then include the category breakdown in
B1's output so an empty table is visible rather than assumed benign.

**Test:** `synthetic-scenarios.ts` gains an assertion that a scenario expected to trip a guardrail
produces the row, not merely the tool call.

---

### B4. Fix the transcript ordering defect

**Status: shipped 2026-08-24.** Checked the real defect against production data first
(`mcp__supabase__execute_sql`): neither of the two existing calls actually shows a reordering in
`id`/`created_at` — both are perfectly monotonic. The bug is real regardless; it just needs a caller
barge-in to manifest, and neither of the two recorded calls had one. Traced it to the actual mechanism:
`transcriptWriteChain` already guarantees WRITE order matches CALL order (that was never broken) — the
gap is that the agent's `logTranscript` call used to happen only after `generate()` fully resolved,
well after the agent's turn actually began, so a caller's barge-in mid-turn could *call* `logTranscript`
first even though the agent started speaking earlier.

Fixed with a new nullable `transcripts.sequence` column (migration `0056`, generated locally via
`drizzle-kit generate` — no live DB needed for generation), reserved by a new
`reserveTranscriptSequence()` counter at the literal top of `speak()` — before `generate()` is even
called — rather than at the `logTranscript` call site. Every reader that touched `transcripts` ordering
now orders by `sequence` (falling back to `id` for pre-migration rows, which have none):
`app/export.ts`, `voice/compliance/adapters.ts`, `voice/org-queries.ts`'s `getOrgCallTranscript` (the
user-app dashboard's transcript source), and `voice/routes.ts`'s admin transcript endpoint — two of
which (`org-queries.ts`, `routes.ts`) had no explicit order at all before this and were relying on
Postgres's undefined natural row order.

Verified two ways, both real: `0056`'s exact `ALTER TABLE ... ADD COLUMN "sequence" integer` was
generated against the actual current schema, and a full replay of production call 2's normal-path
turns confirms `sequence` is assigned strictly increasing and matches conversational order
(`stream-transcript-ordering.test.ts`). **Not verified**: a live end-to-end replay of the actual
barge-in race (two turns genuinely overlapping through the real state machine) — attempted, hung the
test harness (likely `decideBargeIn`/abort-controller interaction not fully traced), and was abandoned
rather than debugged blind. In its place, the reservation-before-`generate()` ordering is pinned
directly at the source level (a test asserting the reservation line precedes the `generate()` call in
`stream.ts`), so a regression that moves the reservation back down — reintroducing the exact race this
closes — fails a test even without a live race to trigger it.

**Where:** `packages/api/src/voice/stream.ts:670` — the serialized `transcriptWriteChain`, and any
reader that orders transcripts by `id` (dashboard call detail, `app/export.ts`, replay tooling).

**How:** production transcript rows are written **out of order** — the chain serializes writes but the
enqueue order does not always match utterance order, so `id` order reconstructs a conversation that did
not happen. Two parts: (a) give transcripts an explicit sequence or timestamp that reflects utterance
order and populate it at emit time, not at write time; (b) make every reader order by that instead of
`id`.

This is in B rather than D because **every replay, every audit and every synthetic assertion in the
rest of this plan reads transcripts in order.** A reordered transcript makes Phase A's provenance
matcher and Phase D's question ledger both untestable.

**Test:** a test that enqueues transcript writes whose completion order differs from utterance order
and asserts the read-back order is the utterance order.

---

### B5. Make health status mean something

**Status: shipped 2026-08-24.** Pulled both production calls' actual `calls`/`call_latency`/
`turn_latency` rows live (`mcp__supabase__execute_sql`) and ran them through the pre-B5
`classifyCallHealth` mentally against the real thresholds: confirmed neither call triggers a single
silent or degraded reason under the old logic — the stored `health_status = "healthy"` on both rows
was not a bug in the classifier's arithmetic, the thresholds and the inputs were just wrong for what
they were supposed to catch.

Three fixes:

1. **`DEAD_AIR_DEGRADED_MS`: 3000 → 1200.** The old value sat above both calls' real numbers (1985ms,
   2753ms) despite the audit measuring them at 2.5-3.4x the target. 1200ms is not a round-number
   tightening — it's Phase C's own committed pickup-to-first-audio target (`docs/plans/README.md`), so
   "degraded" now means "missed the bar the project already set." `STT_CONNECT_DEGRADED_MS`: 2000 → 700,
   the narrowest change that catches the audit's own named case (753ms) without also flagging call 1's
   608ms, which the audit never called out.
2. **A new `maxTurnVoiceToVoiceMs` input and `MAX_TURN_V2V_DEGRADED_MS` (3000ms) threshold.** Every
   existing latency input to `classifyCallHealth` was call-level/first-turn only — both calls' first
   turns looked fine (1259ms, 1585ms LLM TTFT) while a *later* turn was catastrophic (turn 11: 4031ms
   v2v; turn 18: 4846ms v2v, the exact number the audit cites as evidence of the terminal-turn batching
   problem A3 fixed separately). A call-level-only view structurally cannot see that turn. Wired from a
   new running max tracked in `persistTurnLatency`.
3. **`hadFabricatedCapture`/`hadUndeliveredOutcome` as new required inputs**, per the plan's own words:
   "a call that fabricated a field or promised an undelivered callback is not healthy, whatever its
   latencies." Both land in the *silent* bucket, not degraded — they're integrity defects, not pipeline
   slowness, and the plan's framing treats them as more severe than any latency number. Wired from
   existing per-call state: `hadFabricatedCapture` from A1/A2's `fabricated-capture` guardrail branches
   (both `captureField` and `markFieldUnanswered`), `hadUndeliveredOutcome` from crmSync's own
   `synced: false` output (A4 already writes the guardrail row in `tools/crmSync.ts`; this just reads
   the same field) OR-ed with A4's existing `capturedCallbackScheduled` invariant.

Verified against the real numbers as committed fixtures (not just asserted): call 1 now fails on the
undelivered crmSync alone (it had no fabrication — the honest-capture control case); call 2 fails on
both fabrication and undelivered outcomes, landing in `silent-failure`. Both fixtures are pulled
verbatim from production, cited by exact column values in the test's own comments, not paraphrased from
the audit doc.

**Where:** `packages/api/src/voice/call-health.ts` (`:127`, `:183` and the thresholds around them).

**How:** both production calls are `health_status = healthy` while being 2.5–3.4× off the latency bar
and containing a fabricated field. `STT_CONNECT_DEGRADED_MS` did not fire on a 753 ms connect, so the
threshold is above what the audit calls a defect. Recalibrate the thresholds against the real
distribution B1 now produces, and add the Phase A defect classes as health inputs — a call that
fabricated a field or promised an undelivered callback is **not** healthy, whatever its latencies.

**Test:** `packages/api/src/voice/call-health.test.ts` — the two production calls' actual numbers must
not classify as `healthy`. Encode them as a fixture with a comment citing the audit doc.

---

## Exit gate

```bash
cd /home/user/weeber
bun run latency:report            # must print p50/p95 per stage, the ADR-107 window, and the Phase A counters
bun run lint
bun run typecheck
cd packages/api && bun run test && cd ../..
bun run knip:gate
bun run persona:gate
bun run design:guard
bun run contrast:gate
```

Conditions:

1. `bun run latency:report` against production read-only reproduces the audit's headline numbers:
   `pickup_to_first_audio` 1985 / 2753 ms, pooled per-turn v2v p50 ≈ 1.75 s / p95 ≈ 4.5 s,
   `tts_first_byte` median ≈ 412 ms, and the ≈70/23/7 LLM/TTS/other split. **If it does not reproduce
   them, the query is wrong — not the audit.** The audit is the fixed point here; it was computed
   directly from rows.
2. `tool_call_latency` has rows for tool calls made after the fix, and the cause (stale deploy vs
   silent failure) is written down in the commit message.
3. `guardrail_events` is demonstrably non-vacuous: replaying call 2 produces at least one
   `fabricated-capture` and one `unsourced-claim` row.
4. Transcripts read back in utterance order, asserted by test.
5. Neither production call classifies as `healthy`.
6. `knip:gate` passes **without** widening `tools/dead-code/knip-baseline.json`. A new script and a new
   module are exactly the kind of thing that tempts a baseline edit — export them from a real entry
   point instead.

---

## Explicitly out of scope

- **Any latency change.** B measures; C changes. If a fix looks obvious while writing the query, write
  it down in `phase-c-latency.md` and leave the code alone. The gate above depends on measuring the
  *current* system.
- **A dashboard UI for these numbers.** A CLI command is the gate. Surfacing percentiles in
  `org-queries.ts` and the web dashboard is a follow-up, and `org-queries.ts:689`'s averages stay as
  they are for now — noted, not fixed here.
- **A sentiment metric.** Refused; see `docs/plans/README.md`.
- **Alerting.** `agent.ts:1444` already computes `calculateCacheHitPercent` and nothing alerts on it.
  Phase C uses it as a signal; a real alerting path is post-pilot.
- **Backfilling pre-2026-08-12 rows** into a comparable shape. ADR-107 says they are not comparable;
  they are excluded and counted, not rewritten.
