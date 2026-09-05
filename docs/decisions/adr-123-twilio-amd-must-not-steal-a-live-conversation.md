---
adr: 123
title: "Twilio AMD must not steal a live conversation"
date: 2026-09-05
status: Accepted
---

## ADR-123 — Twilio AMD must not steal a live conversation
**Date:** 2026-09-05
**Status:** Accepted

**Context:** After ADR-122, a founder test call to `+917499291834` (insurance post-sale welcome)
conversed for two turns (TTFT 1611ms / 1427ms, `crmSync` withheld, Cartesia voice). Then
`POST /api/voice/amd-status-callback` returned 200 and the caller heard a **different voice** say
they were sorry to have missed them, and the call ended.

Cause: `placeOutboundCall` defaulted `amd: true` for every Twilio dial. Async AMD
(`machineDetection: DetectMessageEnd`) posts `AnsweredBy` ~30s later. The callback treated every
`machine_*` value as a voicemail: Twilio `<Say>` (default TTS, not Cartesia) + hangup, tearing down
the live Media Stream. Twilio's AMD model is US voicemail cadence; India PSTN and a live two-way
call are outside that. `DetectMessageEnd` waiting on silence between turns is a known false-positive
shape.

The voicemail line is an honest campaign behaviour. Hijacking a human who already spoke is not.

**Decision:**

1. **Default AMD on NANP only** (`shouldRequestTwilioAmd`: `+1` + 10 digits). India and other
   destinations do not request it.
2. **Dashboard `test-call-phone` (merchant and admin) passes `amd: false`** even on a US number —
   a test call is a known human.
3. **Callback latch:** if any caller-role transcript line exists for the CallSid, ignore a later
   `machine_*` label. Log it. Do not `<Say>`. Do not hang up. Greeting-only (agent spoke, caller
   has not) still takes the voicemail path, which is the US campaign case AMD exists for.

**Rejected:** deleting AMD entirely (US campaigns still want it); leaving the voicemail `<Say>` on
Cartesia (would still hang up a live human); waiting for Twilio to "get better at India".

**Consequences:** India test and campaign Twilio dials no longer run AMD. A US campaign still can.
A false `machine_end_silence` mid-call no longer sounds like a second person apologizing.
