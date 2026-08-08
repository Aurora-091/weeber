# State engine

Most voice-agent stacks treat the transcript itself as memory — which means once something a caller said
scrolls outside whatever the model actually attends to, the agent re-asks for it or contradicts an earlier
answer. This isn't a model-quality problem; it happens even with strong models, because the only "memory"
most stacks have is the raw transcript (or a lossy summary/RAG layer over it), with no deterministic,
structured source of truth the agent is required to read from.

Weeber keeps a separate, deterministic state layer instead:

- The agent calls `captureField` the moment a caller states something durable — an email, an order ID, a
  name — recording it as a `{ field, value }` pair, not free text.
- That state (`calls.capturedState`) is persisted immediately (not just at call end) and re-injected into
  the system prompt every turn as an explicit "Known facts — do not ask for these again" block
  (`agent.ts`'s `buildKnownFactsBlock`).
- The result: the model reads ground truth instead of re-deriving it from scrollback, and every fact is
  inspectable afterward — on the [dashboard](./dashboard.md) or via `GET /api/voice/calls/:id/status`.

See [`DECISIONS.md`](../DECISIONS.md) ADR-012 for the full reasoning, including what's deliberately not
built yet (no per-persona required-slot schema — the model decides what's worth capturing based on the
tool description alone, not a strict checklist).

## Cross-call memory

`capturedState` above is scoped to a single call — on its own, a returning caller starts from zero every
time. `callerMemory` is a separate table, one row per phone number, that persists across calls:

- On `finalizeCall`, that call's `capturedState` is merged into the existing `callerMemory` row for the
  same number (`{ ...existing, ...newFacts }`) — later calls overwrite matching keys, new keys accumulate.
  It's a flat key/value overlay, not a call-by-call transcript log and not an LLM-generated summary, so
  there's no extra inference cost and no unbounded growth.
- Which number counts as "the human" depends on call direction: `fromNumber` on an inbound call, but
  `toNumber` on an outbound call (the operator's own Twilio number is `fromNumber` there).
- It's injected into the system prompt via a separate "from a previous call... may be outdated" block,
  distinct from this-call's known-facts block, since the model should treat the two with different
  confidence.

See [`DECISIONS.md`](../DECISIONS.md) ADR-023 for the full reasoning and what's explicitly out of scope
(no unit tests against a real DB for the read/write helpers — consistent with the rest of this layer,
verified integration-style instead).
