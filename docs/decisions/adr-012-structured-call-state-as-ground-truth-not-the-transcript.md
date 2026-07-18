---
adr: 12
title: "Structured call state as ground truth, not the transcript"
date: 2026-07-05
status: Accepted
---

## ADR-012 — Structured call state as ground truth, not the transcript
**Date:** 2026-07-05

**Context:** A recurring production failure mode in voice agents (surfaced via a Reddit thread analyzed
alongside this project's own market research) is that agents re-ask for information the caller already
gave, or contradict earlier answers, once that information scrolls outside whatever the model effectively
attends to. This isn't a model-quality problem — it happens even with strong models — because the only
"memory" most voice-agent stacks have is the raw transcript (or a lossy summary/RAG layer over it), with no
deterministic, structured source of truth the agent is required to read from. Vent had this same gap:
`history: ModelMessage[]` was the only state a call carried.

**Decision:** Add a structured `CallState` layer that sits alongside, not instead of, the transcript:
- A new `captureField` tool (`voice/tools/captureField.ts`) lets the agent explicitly record a durable fact
  (email, order ID, name, callback time, etc.) as a `{ field, value }` pair the moment the caller states it,
  rather than leaving extraction implicit in free text.
- `calls.capturedState` (new JSON column) and `CallSession.capturedState` (session-store) hold this as a
  plain `Record<string, string>` — deterministic, inspectable, and persisted continuously (on every
  `captureField` call, not just at call end) so it survives a mid-call crash and shows up on the dashboard
  immediately.
- `agent.ts`'s `buildKnownFactsBlock()` renders the current state as an explicit "Known facts — already
  confirmed, do not ask for these again" block appended to the system prompt every turn. The model is told
  what's known instead of being expected to re-derive it from scrollback.
- This was deliberately scoped as a feature *within* Vent's existing compliance/self-hosted positioning,
  not a repositioning of the project. Compliance, audit logging, and debugging all benefit from the same
  structured state (a captured `disposition` or DNC-triggering fact is exactly this kind of data already);
  this generalizes that pattern instead of introducing a separate identity for it.

**Consequences:** Two new test files (`agent.test.ts`, `tools/captureField.test.ts`, 6 tests) exercise
`buildKnownFactsBlock`'s empty/populated/multi-field/non-mutating behavior and the tool's shape; full suite
(48 tests across both packages) still green, typecheck and build clean, `db:push` applied the new column
with no manual migration needed (SQLite JSON text column). A companion dashboard (`/dashboard`) was built in
the same round specifically to make captured state visible and auditable per call, not just log lines — see
the dashboard section of README.md. Not done in this round: no automatic slot *schema* per persona (i.e. no
way to declare "this persona must capture email + order_id before ending the call") — the model decides
what's worth capturing based on the tool description alone. That's a reasonable next step if this needs to
become stricter (e.g. compliance-required fields) rather than best-effort.
