---
adr: 51
title: "Agent Preview drawer — live voice test call is a parallel sandbox handler, not a 4th telephony provider (2026-07-12)"
date: 2026-07-12
status: Accepted
---

## ADR-051: Agent Preview drawer — live voice test call is a parallel sandbox handler, not a 4th telephony provider (2026-07-12)

**Context:** `AGENT-CONSOLE-UI-PLAN.md` scoped a two-phase Preview drawer (top-right on both
`/app/agents` and `/dashboard/agents`): Phase 1 a backend-wired Text tab + TTS-reactive orb testing
the *current unsaved form state*; Phase 2 a real full-duplex in-browser voice test call. Both phases
shipped this session (commits `03b3d40`, `8001d9d`) but were never written up here or in
`changelog.md` until now — backfilling so a fresh session has the full picture.

**Phase 1 decision:** rather than duplicating agent-config resolution, `buildPreviewAgentConfig`
builds a full config from an in-memory `AgentFrame` override (validated by the existing
`AgentFrameSchema`) with the same fallback-to-template-default behavior a saved config would have.
Both test-chat routes accept this override optionally — omit it and you get the existing
saved-row behavior (`resolveAgentConfig`) unchanged. No new endpoints; existing ones extended.

**Phase 2 decision (the one worth defending):** the live voice test call is **not** a 4th provider
inside `createVoiceStreamHandlers`/`stream.ts` alongside twilio/plivo/exotel. That engine's job is
running *real* calls — it persists DB call rows, fires workflows/webhooks, and enforces
DNC/compliance/caller-memory. None of that belongs in a config-testing sandbox, and bolting a
"don't persist/don't enforce DNC" escape hatch onto the real-call engine is worse than a small
amount of duplication. Instead `voice/test-call-stream.ts` is a standalone handler that reuses only
the shared pipeline primitives (`connectStt`, `connectTts`, `runVoiceAgentTurn`,
`runVoiceAgentGreeting`) — genuinely the real STT→LLM→TTS pipeline, just without a phone number,
DB row, or compliance gate, and hard-capped at 5 minutes.

**Auth decision:** browser `WebSocket` clients can't set custom headers, so neither a raw session
cookie nor an API key can ride safely in the WS URL. Solved with a two-step token handshake: an HTTP
POST (normal session/admin-key auth, rate-limited) issues a short-lived (2 min), single-use,
in-memory token; the WS upgrade at `/api/voice/test-call?token=...` consumes it once. Mirrors the
`previewRateLimited`/`testChatRateLimited` "meter at the HTTP entry point, not per WS message"
pattern already established for the other test surfaces.

**Wire format decision:** 8kHz mu-law, matching what `connectStt`/`connectTts` already expect from
real Twilio/Plivo/Exotel streams — this made the browser the one side that needed new codec work
(`lib/audio-codec.ts`, browser-safe port of the API's mulaw/pcm16 math), while the backend pipeline
needed zero changes.

**Known tradeoff accepted:** `ScriptProcessorNode` (deprecated but functional everywhere evergreen)
is used for mic capture instead of `AudioWorklet` — smaller/faster to ship correctly this session;
flagged as a reasonable future migration, not urgent.

**Not done / explicitly out of scope (per the plan doc):** Phase 3 (Mock-tools toggle, inline vs.
floating-widget toggle, Vars/merge-tag preview) is deferred until the workflow-canvas variable
system and/or a public embeddable widget surface actually exist — building that UI ahead of the data
it would inject would be building for nothing.
