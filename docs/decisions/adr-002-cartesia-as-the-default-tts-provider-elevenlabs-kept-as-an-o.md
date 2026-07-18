---
adr: 2
title: "Cartesia as the default TTS provider, ElevenLabs kept as an option"
date: 2026-07-04
status: Accepted
---

## ADR-002 — Cartesia as the default TTS provider, ElevenLabs kept as an option
**Date:** 2026-07-04

**Context:** A real outbound test call went completely silent after connecting. Investigation found
ElevenLabs' free tier returns `402 payment_required` ("Free users cannot use library voices via the API")
for every voice in the account, regardless of which voice ID is configured — this isn't a bug in our code,
it's an ElevenLabs account-tier restriction that can't be worked around without upgrading to a paid plan.

**Decision:** Add Cartesia as a second TTS provider behind a shared `ConnectTts` interface
(`voice/tts/types.ts`), and make it the default (`TTS_PROVIDER=cartesia`) since it works on a free/Starter
plan with no equivalent restriction, and it natively outputs `pcm_mulaw` at 8000Hz — the exact format
Twilio's Media Streams need, with zero re-encoding, matching the same zero-conversion path ElevenLabs
already had.

**Consequences:** ElevenLabs remains fully supported for anyone with a paid plan (`TTS_PROVIDER=elevenlabs`)
— this wasn't a replacement, it was adding optionality the user explicitly asked for ("we will add more
providers"). The provider abstraction this required (rather than a hardcoded ElevenLabs call) is now the
template every future TTS/LLM provider follows.
