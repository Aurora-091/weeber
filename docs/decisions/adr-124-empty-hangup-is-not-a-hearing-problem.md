---
adr: 124
title: "An empty hangUp turn is not a hearing problem"
date: 2026-09-05
status: Accepted
---

## ADR-124 — An empty hangUp turn is not a hearing problem
**Date:** 2026-09-05
**Status:** Accepted

**Context:** After ADR-122 and ADR-123, two founder test calls on 2026-09-05 (~13:19–13:23Z) both
conversed. They failed in **different** ways. Judging the product from one agent is wrong.

1. **`insurance-post-sale-welcome`.** Greeting TTFT 823ms. Real turns. `crmSync` withheld. Then
   `setDisposition` past the filler threshold, then
   `[voice-agent] turn produced no spoken text — falling back` with
   `toolCallsThisTurn: ["setDisposition", "hangUp"]`, `finishReason: "stop"`, 101 output tokens
   (tool JSON, not speech). Then `[voice] hangUp requested: caller informed documents had not
   arrived; closing with human follow-up needed`. The caller heard `FALLBACK_REPLY` ("Sorry, I
   didn't quite catch that") and the line dropped. The persona *is supposed to* log and hang up
   when documents never arrived. The hearing apology is a lie on a successful close.
2. **`insurance-appointment-setter`.** Many real turns (TTFT 531–1639ms; one deferred first-token
   bound after tools, then 2797ms of actual speech). Hangup reason: `caller said they can
   disconnect`. Separate defect: `DEAD AIR on turn 5` — 59 LLM chars, zero TTS bytes (ADR-101
   class; not this ADR). Mid-call `PUT` of that agent's config. `setDisposition` still slow enough
   to play filler.

ADR-122 already refused to speak `FALLBACK_REPLY` while a tool is *still running* at 2.5s. It did
not cover a turn that *finished* with tools and no text. The empty-turn path always spoke the
hearing line "rather than leaving the caller in silence." After `hangUp`, silence *is* the end;
the stream hangs up from the tool latch either way.

**Decision:**

If the model produced no spoken text this turn **and** `hangUp` or `transferToHuman` already
executed (`wrapToolsWithInFlightCounter.names` unioned with `steps[].toolCalls`), do **not**
speak `FALLBACK_REPLY`. Return `""`. `stream.ts` still waits (briefly) for TTS then
`performHangUp` / `performTransfer`. Log
`hangUp/transfer already ran; skipping hearing fallback` so it is not confused with the 2.5s
abort.

Empty turns that only called `setDisposition` / `crmSync` / lookup still get `FALLBACK_REPLY`.
Those are unfinished conversations, not endings.

**Rejected:** inventing a canned goodbye ("Thanks, I'll have someone follow up") — that line is
often wrong for the persona (post-sale vs appointment vs COD) and we have no honest close the
model declined to write; speaking nothing and hanging up matches the tool the model did call.
Raising this into a prompt change only on post-sale — the empty+hangUp shape is the same on any
agent.

**Consequences:** a post-sale close with no closing line drops silently instead of apologizing for
not hearing. Operators should still teach personas to speak a one-sentence close *before*
`hangUp`; this ADR stops punishing the caller when they don't. Appointment-setter dead air is
unfixed. `transferToHuman` withheld for no number is ops, not this path. Do not treat one
persona's call as the product.
