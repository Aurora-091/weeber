---
adr: 23
title: "Cross-call memory: flat key/value overlay, merged not replaced"
date: 2026-07-08
status: Accepted
---

## ADR-023 — Cross-call memory: flat key/value overlay, merged not replaced
**Date:** 2026-07-08

**Context:** `capturedState` (ADR-012) is scoped to a single call — a returning caller starts from zero
every time, which the ROADMAP had already flagged ("OpenVent doesn't have this at all today"). Needed a
mechanism that survives across calls without turning into a second, competing source of truth against
`capturedState`, and without an unbounded per-caller history that would grow the prompt injection cost
forever.

**Decision:** New table `callerMemory`, one row per phone number, a flat JSON key/value `facts` column —
deliberately the same shape as `capturedState`, not a free-text summary and not a call-by-call log. On
each call's `finalizeCall`, `upsertCallerMemory` merges that call's `capturedState` into the existing
row (`{ ...existing, ...newFacts }` — later calls overwrite matching keys, new keys accumulate), a no-op
if nothing was captured. No LLM summarization call involved — this stays free to compute. Which number
is "the human" depends on call direction (`resolveHumanNumber`): `fromNumber` on an inbound call, but
`toNumber` on an outbound call, since `fromNumber` there is the operator's own Twilio number, not a real
person — worth a dedicated pure function since getting this backwards would silently key memory off the
operator's own number. Injected into the system prompt via `buildCallerMemoryBlock`, clearly labeled
"from a previous call... may be outdated" — distinct wording from `buildKnownFactsBlock`'s this-call
facts, which the model treats as settled ground truth. `runVoiceAgentGreeting` previously didn't forward
`onLatency` *or* accept `callerMemory` at all — both gaps fixed together since they're the same call site.

**Consequences:** New `caller-memory.ts` module, `resolveHumanNumber` unit-tested directly (pure
function); `getCallerMemory`/`upsertCallerMemory` aren't unit-tested against a real DB (consistent with
how the rest of this file's DB-touching code is verified — integration-level via the live pipeline, not
mocked). No changes to `capturedState`'s own behavior or table. Additive migration only.
