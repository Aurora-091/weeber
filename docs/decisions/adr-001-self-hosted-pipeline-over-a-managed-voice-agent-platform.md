---
adr: 1
title: "Self-hosted pipeline over a managed voice-agent platform"
date: 2026-07-04
status: Accepted
---

## ADR-001 — Self-hosted pipeline over a managed voice-agent platform
**Date:** 2026-07-04

**Context:** Managed platforms (Vapi, Retell, ElevenLabs Agents) offer faster setup for voice agents but
put the operator's prompts, call data, and per-minute cost structure inside someone else's product, with
whatever roadmap and pricing changes that platform decides on.

**Decision:** Build Vent as infrastructure the operator owns end to end — Twilio, Deepgram, the LLM, and
the TTS engine wired directly, with our own database for calls/transcripts, not a third party's dashboard.

**Consequences:** More setup work and more moving pieces to maintain (three-plus vendor integrations
instead of one platform SDK), but full control over cost, data residency, prompt/tool logic, and the
ability to swap any single layer (see ADR-002, ADR-005) without being blocked by a platform's feature
gaps. This tradeoff is explicit in the product's own positioning ("your infrastructure, your rules").
