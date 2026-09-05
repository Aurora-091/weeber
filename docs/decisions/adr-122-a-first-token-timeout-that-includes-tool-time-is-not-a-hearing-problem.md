---
adr: 122
title: "A first-token timeout that includes tool time is not a hearing problem"
date: 2026-09-05
status: Accepted
---

## ADR-122 — A first-token timeout that includes tool time is not a hearing problem
**Date:** 2026-09-05
**Status:** Accepted

**Context:** Railway logs from a live India PSTN call (2026-09-05 ~12:28Z) showed Deepgram STT and
Cartesia TTS working: greeting TTFT ~800–900ms, pickup-to-first-audio ~2s. After the caller spoke, every
turn logged two lines in the same millisecond:

1. `[voice] tool call "crmSync" still running past the filler threshold`
2. `[voice-agent] LLM produced no output within 2500ms — using fallback reply`

The spoken line is `FALLBACK_REPLY` ("Sorry, I didn't quite catch that — could you say that again?").
The caller repeated themselves. The loop continued.

STT had caught them. The model had not stalled: insurance personas instruct `crmSync` every turn, the
tool was registered whenever org + E.164 + `callId` existed (ADR-069), and `execute` still called
`getOrgCrmCredentials` — three sequential integration reads — then returned `synced: false` / "not
configured". That work is billed against `textStream`'s first chunk. `FIRST_TOKEN_TIMEOUT_MS` is 2500;
`TOOL_CALL_TIMEOUT_MS` is 4000; the filler fires at 400. Aborting the model at 2.5s while a legal tool
is still running is a race the tool can never win.

A secondary, quality-only issue on the same calls: insurance runtime personas still contained
unrendered `{{merge_tags}}`. `scrubSystemPrompt` strips them (ADR-065), leaving "You are , a friendly…"
holes. That is not what produced the fallback loop.

**Decision:**

1. **Do not abort the first-token bound if a tool started this turn.** Count `execute()` via
   `wrapToolsWithInFlightCounter`. At 2.5s with `toolsStartedThisTurn === 0`, keep today's fallback
   (a genuinely stalled generation). If a tool ran, wait for the first spoken chunk or the existing
   12s `TURN_TIMEOUT_MS` ceiling. Do not `firstTokenAbort.abort()` in the deferred path.
2. **Withhold `crmSync` when no CRM is connected.** `resolveLiveCrmSyncContext` keeps ADR-069's
   org/number/`callId` gate and adds `getOrgCrmCredentials`. No credentials → the tool is not in the
   request (ADR-064 non-registration), folded into the start-handler `Promise.all` so it is not a
   sequential pickup delay. Connecting a CRM later in the same call is not supported; the decision is
   fixed at `"start"` like `crmSyncContext` already was.
3. **Insurance runtime regions go tag-free** on the ADR-065 cart-recovery pattern. Values arrive in
   identity/facts blocks. Greetings in `seed.ts` still use `{{agent_name}}`/`{{merchant_name}}`
   because those *are* rendered. Re-seed `agentTemplates` for the new persona bytes to reach new
   configs; an org that pasted an old persona into the editor still has that paste.

**Rejected:** raising `FIRST_TOKEN_TIMEOUT_MS` globally (every tool-less stall would wait longer);
speaking a different fallback while tools run (the filler lines already cover that); leaving
`crmSync` registered so the model can "learn" from `synced: false` (that learning costs a turn of
dead air and a lying "didn't catch that").

**Consequences:** demo orgs with no HubSpot/GHL/Salesforce stop burning 2.5s+ per turn on a no-op
sync. A connected CRM still pays tool latency, but the caller hears filler then a real reply instead
of a hearing apology. The 2.5s bound still protects a hung gateway that never calls a tool.
