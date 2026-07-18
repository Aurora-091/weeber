---
adr: 22
title: "Per-call latency breakdown: first-value-only, persisted once at call end"
date: 2026-07-08
status: Accepted
---

## ADR-022 — Per-call latency breakdown: first-value-only, persisted once at call end
**Date:** 2026-07-08

**Context:** LLM time-to-first-token was already computed (`agent.ts`'s `onLatency` callback) but only
`console.log`'d in `stream.ts`, never surfaced. STT connect time and TTS first-audio-byte time weren't
tracked at all. Flagged repeatedly as the top remaining ask from the community feedback rounds
(`docs/strategy-2026-07.md`).

**Decision:** New table `callLatency` (one row per call, additive migration, `callId` as primary key),
three nullable columns: `sttConnectMs`, `llmTtftMs`, `ttsFirstByteMs`. Each is captured **once per call,
first value wins** — not per-turn, not continuously updated. STT connect is captured in `deepgram.ts` on
the first successful `open` event (guarded so reconnects don't overwrite it — that's already covered by
the separate `sttReconnectCount`/`totalGapMs` stats). LLM TTFT is captured from whichever turn produces
a value first — usually the greeting, since `runVoiceAgentGreeting` didn't previously forward
`onLatency` at all and now does. TTS first-byte is captured by wrapping the existing `onAudioChunk`
forwarding callback in `stream.ts`'s `speak()` with a `Date.now()` delta on the first chunk of the
first turn, rather than modifying `elevenlabs.ts`/`cartesia.ts` — keeps the TTS provider files untouched
and provider-agnostic, matching the existing abstraction (see ADR referenced in `docs/architecture.md`).
Unlike `capturedState`, latency isn't persisted continuously mid-call (no crash-recovery need for it) —
one row is written in `finalizeCall()`, and only if at least one metric was actually captured (a call
that failed before Deepgram ever connected doesn't get a pointless all-null row).

**Consequences:** New `GET /calls/:id/latency` endpoint, new "Latency breakdown" panel on the call-detail
dashboard page — renders "not recorded" per-field rather than `0ms` or crashing for calls with no data
(historical calls before this shipped, or calls that failed early). No changes to the TTS/STT provider
files' own interfaces — the timing wrap lives entirely in `stream.ts`, the one place that already
orchestrates all three stages. Not unit-tested in the traditional sense (the capture points are wired
into `stream.ts`'s WebSocket state machine and the real STT/TTS network connections, which the existing
test suite doesn't mock — consistent with how `stream.ts` itself has no direct unit tests today);
verified via `tsc`/`vite build`/existing 49-test suite passing unchanged, plus a manual dashboard render
check for both the populated and null-field cases.

---
