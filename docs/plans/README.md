# The road to pilot — phases A → E

**Written:** 2026-08-21
**Evidence base:** `docs/audits/2026-08-21-first-two-production-calls.md`
**Governing ADRs:** ADR-119 (market asked at onboarding), ADR-120 (captured-field provenance),
ADR-118 (doc dating and retirement), ADR-107 (latency telemetry cutover), ADR-110 (market inference
refused)

This directory holds the execution plan for getting Weeber from "two production calls that both
misbehaved" to "a pilot we can put in front of a paying insurance org". It is five phases, and the
order is not a suggestion.

## The linear rule

**A phase may not be started until the phase before it has met its exit gate.** The gate is written at
the bottom of each phase file, as commands and checks, not as a feeling. If a gate cannot be met, the
phase is not finished — either the work is incomplete or the gate is wrong, and the way to change a
gate is to write down why in the phase file and say so in the commit.

There is no partial-credit ordering, no "start C while A finishes", and no phase-jumping for a small
item that looks cheap. The reason is specific to this project, not process for its own sake:

- **B measures what A fixes.** Building the aggregation layer before the integrity fixes means the
  first numbers we trust are numbers computed over fabricated fields. Measurement inherits the
  credibility of the data underneath it.
- **C optimizes what B measures.** Every latency claim in the deep-research report that was checkable
  against production turned out to be wrong in some direction (audit findings 5–7). Optimizing before
  the aggregation exists is how that happened. C's own targets are only checkable with B's query.
- **D changes conversation behaviour, which changes A's and C's numbers.** Reworking the idle prompt
  and the question ledger moves turn counts, tool-call placement and the p95 tail. Doing it before C
  means C measures a moving target.
- **E splits the product by market.** Doing it before D means shipping two copies of unfinished
  conversation behaviour.

| Phase | File | What it is | Exit, in one line |
| --- | --- | --- | --- |
| **A** | [`phase-a-integrity.md`](phase-a-integrity.md) | Stop fabricating facts, stop losing leads | Both production calls replay with zero fabricated fields and zero silently-undelivered outcomes |
| **B** | [`phase-b-measurement.md`](phase-b-measurement.md) | Make the numbers real and readable | One command prints p50/p95 per stage; A's defect classes have counters |
| **C** | [`phase-c-latency.md`](phase-c-latency.md) | Latency, in the order production says | p50 voice-to-voice < 1.1 s, pickup-to-first-audio < 1.2 s, measured by B |
| **D** | [`phase-d-conversation.md`](phase-d-conversation.md) | Conversation intelligence | No interruption of a speaking caller, no question asked twice, escalation is deterministic |
| **E** | [`phase-e-market-split.md`](phase-e-market-split.md) | Market split and scale | `orgs.market` is asked, never inferred; US replica serving US orgs |

## Why this order and not the obvious one

The obvious order is latency-first: it is the thing the deep-research report was about, it is what the
demo feels like, and it is what a prospect notices in the first ten seconds. It is second here anyway,
because of what the audit found:

Call 2 fabricated a tobacco-use answer the caller never gave, wrote it to `calls.capturedState`, and
addressed it to a licensed insurance advisor (audit finding 1). The same call promised a callback,
recorded the disposition `callback-requested`, and created no `scheduled_calls` row — that callback
does not exist (finding 2). Both calls' `crmSync` returned `{"synced":false}` and the code treated it
as success.

A 1.75 s median response is a product that feels slow. A fabricated underwriting field is a product
that cannot be sold into insurance at all, and an undelivered lead is a pilot that silently produces
nothing. Those are different categories of problem and only one of them is a launch blocker.

The second reason is narrower and more practical: **latency work done on top of fabricated data is
work we cannot trust.** Phase C's biggest single win is removing a ~250 ms TTS socket open from every
turn (audit finding 6). To know it worked we compare turn latencies before and after — over calls
whose turn counts are inflated by re-asks (finding 4) and whose slowest turns are an artifact of the
end-of-call tool batch (finding 3). Fix the artifacts first and the measurement means something.

## What each phase file contains

Every phase file has the same five sections, and they are written to be executed by someone who has
not read this conversation:

1. **Why this phase exists** — the audit findings it closes, cited by number.
2. **Preconditions** — the previous phase's gate, plus anything external.
3. **The work** — numbered tasks. Each names the **files and line-level sites** to change, **how** to
   change them, and the **test** that proves it. Not a to-do list.
4. **Exit gate** — the commands to run and the conditions that must hold. Copy-pasteable.
5. **Explicitly out of scope** — what belongs to a later phase, and what is refused outright with the
   evidence for refusing it.

That last section matters as much as the work. Three items are refused across this plan on the
strength of production evidence, and they are the kind of thing that gets re-suggested every few
weeks:

- **Lowering `utterance_end_ms`** (`stt/deepgram.ts:108`) — worth 0 ms. All 26 turns that recorded an
  endpoint signal recorded `speech_final`; `utterance_end` never fired once (audit finding 5).
- **Wiring a semantic-turn-detection refiner** — ADR-063's gate (a) asked for evidence of cut-offs
  before building it. Production shows none. The gate closes as *not needed*, not as *still open*.
- **A model-scored sentiment metric** — `voice/call-quality.ts` argues against it, and production
  proves the argument: call 2's `sentiment` was set to `neutral` by the same model turn that
  fabricated the tobacco field.

## Status

**The plan was approved on 2026-08-21.** Phase A's A1–A5 and Phase B's B1–B5 all shipped 2026-08-24;
Phase C is unblocked and is the only phase that may be worked on until its own exit gate is met.

| Phase | Status | Gate met |
| --- | --- | --- |
| A | **A1–A5 shipped 2026-08-24** — all 6 numbered exit-gate conditions closed (condition 4 verified live against production after this table's first pass). Only `persona:gate` is red, and it's pre-existing/unrelated (8 personas over budget from commits before this phase). | Yes, except the one named ratchet |
| B | **B1–B5 shipped 2026-08-24** — see phase-b-measurement.md's Exit gate section for how each of the 6 conditions was verified, most against real production data via Railway + Supabase MCP access granted mid-phase | Yes, except the same pre-existing `persona:gate` |
| C | **Unblocked — ready to start** | — |
| D | Blocked on C | — |
| E | Blocked on D | — |

Update this table in the commit that closes a phase, and say in the commit message which gate
commands were run. Per ADR-118 this file is a living plan, not a dated artifact: it is edited in
place, and the point-in-time evidence it rests on lives in `docs/audits/`, which is append-only.
