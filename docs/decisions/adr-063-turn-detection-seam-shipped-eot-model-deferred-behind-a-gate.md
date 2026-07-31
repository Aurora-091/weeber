---
adr: 63
title: "Turn-detection seam shipped; the EOT model is deferred behind a gate"
date: 2026-07-31
status: Accepted
---

## ADR-063 — Turn-detection seam shipped; the EOT model is deferred behind a gate
**Date:** 2026-07-31

**Context:** The **Five Bets build plan** (`docs/product-strategy/five-bets-build-plan-2026-07-31.md`)
lists "semantic turn-detection" as Bet 1. Today the live call decides end-of-turn (EOT) — *did the caller
finish talking?* — from Deepgram `speech_final` (a fixed silence timeout) refined by an inline
`endsMidThought` regex in `voice/stream.ts`. Silence alone either cuts callers off mid-thought or waits
too long; a *learned* EOT model (Smart Turn / OpenAI Realtime / LiveKit) would decide from semantics.

Two things argued against wiring a model now, and one argued for building the abstraction now:

- **No evidence yet.** There is zero Phase II production call-health data proving calls are actually
  getting cut off — the product is pre-pilot. Wiring a model before the P2 signal exists is optimizing a
  problem we can't yet measure.
- **No safe rollout path.** Staging and prod still share one `DATABASE_URL` (see `progress.md` known
  issues), so there is no isolation to roll a model behind and compare against.
- **But the hot path shouldn't be rewritten twice.** EOT sits on the hottest line in the product (every
  caller utterance). Retrofitting a model into an inline regex later means touching `stream.ts` under
  time pressure. Building the seam now — while it's cheap and behavior-neutral — de-risks that.

**Decision:** Ship the **seam and fallback discipline only, not a vendor.** New module
`packages/api/src/voice/turn-detection/`:

- `types.ts` — `TurnEndDetector` interface (`decide({ text }) → { done, by, reason? }`); any adapter
  implements this one method.
- `heuristic.ts` — `endsMidThought` + `TRAILING_FILLER_PATTERN` **moved here unchanged** from `stream.ts`
  (which re-exports `endsMidThought` for back-compat), wrapped as `HeuristicTurnDetector`. Zero I/O; it is
  both the default detector and the always-available fallback.
- `budgeted.ts` — `withLatencyBudget(primary, fallback, budgetMs)`: a slow/model-backed detector that
  can't answer within the budget (default 300ms) or throws degrades to the heuristic. A model can **never**
  add unbounded latency to the hot path. Post-timeout rejections are swallowed.
- `composite.ts` — heuristic first; if it wants to *hold* (mid-thought) it short-circuits and skips the
  model call (a model can't legitimately make us hold *more*); a model is consulted **only** when the turn
  looks complete — the one place semantics can prevent a wrong cut-off.
- `index.ts` — `createTurnDetector(config)` factory + `SEMANTIC_TURN_DETECTION_FLAG`
  (`"semantic-turn-detection"`) + `DEFAULT_REFINER_BUDGET_MS` (300).

**Flag-gated, default OFF, behavior-identical.** Same org-flag pattern as `expressive-delivery` /
backchannels — a co-located constant resolved once per call from `effectiveFlagsResult`, **no DB column,
no migration**. With the flag off OR no refiner wired (the shipped default, `refiner: null`), the factory
returns a bare `HeuristicTurnDetector` — byte-identical to the old inline `endsMidThought` check.

**The model stays deferred behind an explicit gate.** No vendor is imported or called. The refiner stays
`null` until **both** (a) Phase II health data shows real cut-offs to justify it, and (b) staging is
isolated from prod so a model can be rolled out safely. Wiring a real model later is then a one-line
config change: pass a `refiner`, flip the flag.

**Consequences:**

- Live EOT behavior is unchanged today — this is a pure refactor plus a dormant extension point.
- `stream.ts`'s inline `endsMidThought`/`TRAILING_FILLER_PATTERN` are removed and re-exported from the new
  module; `stream.test.ts` keeps importing `endsMidThought` from `./stream` unchanged.
- 24 unit tests (`turn-detection/turn-detection.test.ts`) cover the heuristic adapter, the budget guard
  (fast-path / slow→fallback / throw→fallback), the composite policy, and the factory default, using a
  `StubModelTurnDetector` mock — no live vendor, no audio path touched.
- The "should we wire a model?" question is now a documented gate, not an open-ended temptation. When P2
  data and staging isolation both exist, this ADR gets a follow-up recording the vendor choice.
- Verified: api+web tsc 3/3 · web build ✓ · root oxlint 0/0 ·
  `bun test --isolate src/voice/turn-detection/turn-detection.test.ts src/voice/stream.test.ts` 24/0.
