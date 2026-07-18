---
adr: 9
title: "Evaluated and rejected LiveKit Agents as an orchestration layer"
date: 2026-07-04
status: Accepted
---

## ADR-009 — Evaluated and rejected LiveKit Agents as an orchestration layer
**Date:** 2026-07-04

**Context:** After market research showed Vent's STT→LLM→TTS orchestration isn't novel (Pipecat, LiveKit
Agents, TEN Framework, and Vocode all solve this with bigger plugin ecosystems and more production
mileage), the idea of adopting one of these frameworks instead of maintaining Vent's own hand-rolled
pipeline was raised and investigated. LiveKit Agents was the strongest candidate — it ships an official
TypeScript SDK (matching Vent's Bun/TypeScript stack, unlike Pipecat which is Python-only server-side) and
has documented Twilio integration patterns.

Deeper investigation surfaced two disqualifying problems:
1. **Both LiveKit deployment options reintroduce the exact dependency Vent exists to remove.** LiveKit
   Cloud puts a third-party vendor between the operator and their own calls — the black-box-platform
   pattern Vent's positioning argues against, plus another account/API-key set every adopter would need.
   Self-hosted LiveKit requires running a media server (SFU) + Redis for room-state coordination, meets
   LiveKit's own recommended baseline of 4 CPU cores / 8GB RAM per agent server, and needs a domain + SSL
   certificate + Docker/Kubernetes — a large new operational burden for every person who adopts Vent, the
   opposite of the "less hustle for our users" goal.
2. **Architectural mismatch with Twilio.** Vent's current pipeline uses Twilio Media Streams, a
   WebSocket-based audio bridge. LiveKit's telephony model is WebRTC + SIP trunking — a different
   transport entirely. Twilio's own support docs confirm they do not offer a SIP-over-WebSocket endpoint,
   so bridging the two requires an extra translation layer (Twilio → SIP trunk → LiveKit dispatch rules →
   LiveKit room); public GitHub issues describe this specific bridge behaving unreliably in production.

**Decision:** Reject adopting LiveKit Agents (or any hosted/self-hosted orchestration framework) for
Vent's core pipeline. Keep and continue hardening the existing direct Twilio Media Streams + Deepgram +
swappable-LLM + swappable-TTS pipeline, which is already built, already proven on a real call, and
requires no infrastructure beyond the API providers a user already needs.

**Consequences:** Vent will not benefit from Pipecat's/LiveKit's larger plugin ecosystems or their ongoing
engineering investment in raw pipeline features (turn-detection tuning, WebRTC transport optimizations,
etc) — that tradeoff is accepted deliberately. The "leverage" identified in earlier research (that no
competitor, hosted or open-source, ships automatic compliance/workflows/control) remains the correct place
to invest instead, since it doesn't require adopting anyone else's infrastructure to build. This decision
supersedes the direction implied by the (unexecuted) LiveKit migration plan from earlier the same day — no
code was migrated before this reversal, so no rollback was needed.
