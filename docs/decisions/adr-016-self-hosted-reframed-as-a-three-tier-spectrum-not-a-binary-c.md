---
adr: 16
title: "'Self-hosted' reframed as a three-tier spectrum, not a binary claim"
date: 2026-07-05
status: Accepted
---

## ADR-016 — "Self-hosted" reframed as a three-tier spectrum, not a binary claim
**Date:** 2026-07-05

**Context:** Early Reddit feedback (r/AI_Agents, r/VoiceAutomationAI — see `reddit-feedback.md`, not
committed) pushed back, correctly, on calling Vent "self-hosted" without qualification: "self-hosted is a
bit of a stretch if you're still routing through Twilio and Deepgram, the data still goes through their
servers," and a sub-reply: "true self-hosted voice AI is nearly impossible end to end because PSTN is
always a third party." Both are right. Vent has never run its own telephony network or its own LLM
inference, and saying "self-hosted" without qualification invited the reasonable assumption that it might.

Talking this through surfaced a clearer model: voice-agent architectures sit on a spectrum, not a binary.
One end is fully local (Ollama/local-LLM + local STT/TTS, zero cloud dependency, real but requires owning
GPU hardware and accepting a quality/latency tradeoff against frontier cloud models — this is what
r/LocalLLaMA is actually about). The other end is fully managed (Vapi, Retell, LiveKit Cloud — zero infra
to run, but zero control, no data ownership, no provider choice). Vent sits in the middle: the
*orchestration layer* is self-hosted (code, database, call logic, compliance rules, dashboard — all
inspectable and owned by the operator) while the *AI layer* (LLM inference, STT, TTS) and the *telephony
layer* (PSTN via Twilio) remain cloud APIs by necessity — no one can self-host a phone network, and
running frontier-quality LLM inference locally is a different, harder product with its own real tradeoffs.

**Decision:** Stop using "self-hosted" as an unqualified, standalone claim. Adopt "self-hosted
orchestration, bring-your-own AI providers" as the precise, headline description everywhere it matters
(README, docs, landing page, the agent's own description of itself). Do not chase the fully-local end of
the spectrum as a roadmap item — that's a different product with different tradeoffs (GPU cost, latency,
model-quality ceiling), and it's not what the compliance/state-engine/no-lock-in bets already made are
built around. Own the middle of the spectrum deliberately, and be explicit about exactly which layer is
owned vs. which layer is still a cloud API — precision reads as more trustworthy to this exact developer
audience than a vaguer, more sweeping claim, especially once someone opens the code and finds Twilio and an
AI Gateway client in there.

**Consequences:** Copy updated in this round: README hero/feature copy, `docs/architecture.md`, the
landing page hero/problem sections, and the voice agent's own persona description (`agent.ts`'s
`DEFAULT_PERSONA`, which explains what Vent is if a caller asks) — all now describe the three-tier
spectrum and Vent's specific position on it, rather than a bare "self-hosted" claim. This is a
documentation/positioning change only, no functional code changes. Drafted (not yet posted) Reddit replies
acknowledging the original feedback directly and pointing to this clarification are in
`reddit-feedback.md`.
