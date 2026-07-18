---
adr: 5
title: "Groq added as a swappable LLM provider behind the same pattern as TTS"
date: 2026-07-04
status: Accepted
---

## ADR-005 — Groq added as a swappable LLM provider behind the same pattern as TTS
**Date:** 2026-07-04

**Context:** The user asked specifically about using Groq for lower latency/cost. Research confirmed LLM
inference is typically the single largest latency contributor in a voice pipeline (larger than STT or
TTS), and Groq's LPU-based inference is a commonly cited fix for exactly this bottleneck in real-time voice
agents.

**Decision:** Add Groq via the official `@ai-sdk/groq` package as a second LLM provider
(`voice/llm/`), selected via `LLM_PROVIDER=groq`, mirroring the TTS provider-abstraction pattern from
ADR-002 rather than hardcoding a second code path. Added time-to-first-token telemetry per turn so the
latency claim can be measured on real calls instead of assumed.

**Consequences:** The AI Gateway path remains the default (`LLM_PROVIDER=gateway`) since it's what the
platform provisions out of the box; Groq requires the user to supply their own `GROQ_API_KEY`. No
production call has yet been run with Groq active — this decision is recorded, but the latency claim is
not yet empirically verified in this deployment (tracked as an open item).
