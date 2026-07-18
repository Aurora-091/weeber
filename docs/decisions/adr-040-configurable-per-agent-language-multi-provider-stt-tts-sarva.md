---
adr: 40
title: "Configurable per-agent language + multi-provider STT/TTS (Sarvam added)"
date: 2026-07-10
status: Accepted
---

## ADR-040 — Configurable per-agent language + multi-provider STT/TTS (Sarvam added)

**Date:** 2026-07-10

**Context:** India has far more languages than any single voice-AI vendor covers well. The voice
pipeline had two hardcoded providers with no language knob at all: Deepgram STT connected with no
`language` param (silently English-only — root cause of a live test call where the agent couldn't
understand Hindi speech at all, not a persona/prompt issue), and TTS already had a clean
`elevenlabs`/`cartesia` provider abstraction (`tts/`) but no third, Indian-language-native option.

**Decision:** Added Sarvam (Saaras v3 STT, Bulbul v3 TTS) as a third provider on both sides, and made
`sttProvider` + `language` first-class fields on the agent frame (`agent-frame.ts`), independent knobs —
STT and TTS providers don't have to be the same vendor (e.g. Deepgram STT + Sarvam TTS for a
Hindi-first agent is a valid combination). Deepgram stays the STT default, Cartesia stays the TTS
default — zero behavior change for every existing deployment that hasn't set a language.

Mirrored the existing TTS provider-registry pattern (`tts/index.ts`) for STT: new `stt/` directory
(`types.ts`, `index.ts`, `deepgram.ts` moved from the old top-level `voice/deepgram.ts`, `sarvam.ts`
new). `language` is stored as plain ISO 639-1 (no region suffix, e.g. `"hi"` not `"hi-IN"`) at the
frame level — each provider adapter normalizes into whatever format it actually needs
(`toSarvamLanguageCode` in both `stt/sarvam.ts` and `tts/sarvam.ts`; Deepgram takes the bare code or
omits the param for English/unset). `"multi"` is Deepgram's own English+auto-detected-other
code-switching mode — STT-only, no Sarvam equivalent.

Sarvam's STT input only accepts wav/PCM, never mu-law (checked against docs.sarvam.ai directly) —
added `voice/audio-codec.ts` (dependency-free G.711 mu-law decode + WAV framing) purely for that one
path. Sarvam's TTS output, by contrast, supports `output_audio_codec: "mulaw"` directly, so that side
needs zero conversion — same zero-re-encoding path as ElevenLabs/Cartesia.

**Architecture correction made alongside this:** STT connection used to happen eagerly in
`stream.ts`'s `onOpen` (fires immediately on WebSocket open), before the Twilio "start" event's async
agent-config lookup resolves `language`/`sttProvider` — so per-call language could never have actually
been threaded through even with the field added. Moved the STT connect call into the "start" handler,
after `resolveAgentConfig` resolves overrides, with a small bounded buffer (`pendingAudioChunks`) so
audio arriving in the (typically tens-of-ms) window before that connects isn't dropped.

Added `sttProvider` (text, nullable, additive) to `org_agent_configs` — migration
`0007_far_arclight.sql`. Dashboard (`/dashboard/agents`) and merchant (`/app/agents`) forms both
updated: voice-provider select gained a `sarvam` option, new STT-provider select, language input
gained a `<datalist>` of curated Indian-language suggestions while staying free text.

**Consequences:** Every existing call is unaffected (no language set -> Deepgram default English,
Cartesia default voice, unchanged). Sarvam requires `SARVAM_API_KEY` (shared across both STT and TTS
uses) — not yet set in any environment; `config-check.ts` only warns at boot if the *global default*
provider is Sarvam and the key is missing, same as the existing ElevenLabs/Cartesia pattern, so this
doesn't block deploys where Sarvam is only used as a per-org override. GTM/marketing-analytics reuse
from Vocalist and the rest of the admin-panel rebuild (ADR-036 onward) are unrelated, separate work —
not touched here.
