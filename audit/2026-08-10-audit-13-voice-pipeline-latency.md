# Audit 13 — Where the milliseconds actually go

**Date:** 2026-08-10
**Scope:** the voice turn, end to end. `packages/api/src/voice/{stream.ts,agent.ts,gateway.ts,stt/*,tts/*,turn-detection/*,tts-cache.ts}` plus every latency row in production.
**Type:** research / analysis. No code changed. Nothing here is implemented.
**Status of the numbers:** every millisecond in §1–§3 is read out of the production database. Every millisecond in §4 that is *not* ours is cited from vendor docs or third-party benchmarks and labelled as such — there are no LLM/TTS/STT API keys in this environment, so nothing external was benchmarked here.

---

## 0. The headline, stated honestly

The dashboard number is **~1.67 s voice-to-voice median**. That number is not what the caller experiences, and it is flattering us at both ends.

`voiceToVoiceMs` (`stream.ts:1569`) is measured as:

```
voiceToVoiceMs = ttsRequestedAt + turnTtsFirstByteMs - turnStartedAt
```

- `turnStartedAt` (`stream.ts:1820`) is stamped when **our server receives Deepgram's `speech_final`** — deliberately before any awaits, which is correct discipline, but it is not when the caller stopped talking. Deepgram is configured `endpointing: "300"` (`stt/deepgram.ts:98`) with `utterance_end_ms: "1000"` as the VAD fallback (`:108`). So **at minimum 300 ms of the caller's real wait is upstream of our clock**, and on any turn where `speech_final` never fires and the synthetic `UtteranceEnd` path (`stt/deepgram.ts:148-152`) carries the turn instead, it is ~1000 ms.
- The interval **ends when the first TTS byte reaches our process**, not the caller's ear. Twilio media-stream egress + PSTN + the carrier jitter buffer are all after our stopwatch.

Reconstructed mouth-to-ear for a median turn:

| Segment | ms | Source |
|---|---|---|
| Deepgram endpointing silence wait | ~300 (up to ~1000 on the VAD path) | config, `stt/deepgram.ts:98,108` — **not measured** |
| Our pre-LLM overhead | **122** | measured, `voice_to_voice − tts_first_byte`, n=13, range 118–130 |
| LLM time-to-first-token | **~1288** | measured, reply turns, median of 14 |
| TTS time-to-first-byte | **~355** | measured, Cartesia, calls 22–23 |
| Twilio egress + PSTN + jitter | ~100–200 | industry typical — **not measured** |
| **Mouth-to-ear** | **~2.17–2.27 s** | |

The bar the market has settled on for 2026 is **p50 < 500–800 ms** end-of-speech to first audio (Vapi publishes p50 <500 / p95 <800 as its own standard; Hamming's guidance is "under 800 ms"; Retell markets ~600 ms). We are running roughly **3× the ceiling**, not 2× the target.

**Prerequisite before any optimisation claim:** instrument the two blind spots. Without them, every "we cut 200 ms" statement is unfalsifiable, because the metric that would show it cannot see a third of the latency.

---

## 1. What production actually contains

Small n. Say so out loud: **9 calls, 35 turns, 13 turns with a complete voice-to-voice measurement.** Spanning 2026-07-18 → 2026-08-10. This is enough to locate the bottleneck; it is nowhere near enough for percentiles. Any p95 quoted off this data would be fiction.

`call_latency` — one row per call, the call-setup path:

| call | date | STT connect | LLM TTFT | TTS 1st byte | **pickup → first audio** |
|---|---|---|---|---|---|
| 15 | 07-18 | 785 | 1594 | 1826 | 2094 |
| 16 | 08-06 | 552 | 1380 | 1602 | 1866 |
| 17 | 08-06 | 566 | 1391 | 1662 | 1925 |
| 18 | 08-08 | 563 | 1299 | 1512 | 1770 |
| 19 | 08-08 | 739 | 1468 | 1750 | 2006 |
| 20 | 08-09 | 583 | 1572 | 1773 | 2037 |
| 21 | 08-09 | 639 | 1671 | 1853 | 2100 |
| 22 | 08-10 | 615 | 1568 | 1988 | 2248 |
| 23 | 08-10 | 579 | 1485 | 1861 | 2101 |

`pickup_to_first_audio_ms` is the one number in the schema that is genuinely caller-perceived (schema.ts:260 says as much). **Median 2037 ms of dead air after the callee picks up.** On an outbound cold call that is the single most expensive metric in the product — it is measured, it is bad, and it is 9/9 consistent.

Provider attribution, from `calls`: **`llm_provider_used = "gateway"` on 8/8 calls that recorded it.** `stt_provider_used = "deepgram"` on all 8. `tts_provider_used = "cartesia"` on 7, `elevenlabs` on 1 (call 21, which also logged `provider_failover_count = 2`).

---

## 2. Finding 1 (P0) — the greeting fast path has never once fired in production

`runGreeting` (`stream.ts:1714`) has a fast path added 2026-07-16 explicitly as a latency fix: if `literalGreetingText` is set, speak it through `speakCannedLine` and skip the LLM entirely. It is guarded (`stream.ts:2150-2153`) by:

```ts
const rendered = renderTemplate(agentConfig.literalGreetingTemplate, greetingContext);
if (!/\{\{\w+\}\}/.test(rendered)) literalGreetingText = rendered;
```

Any single unresolved merge tag silently rejects the whole line and falls back to the LLM.

**Every one of the 9 production calls has a non-null `llm_ttft_ms` on `turn_index = 0`.** The fast path cannot have fired on any of them. Turn-0 TTFT median is **1485 ms** — that is the cost.

Why it fails is in the data. The templates in production:

| template | literal greeting requires |
|---|---|
| `insurance-lead-followup` | `agent_name`, `company_name`, **`interest_area`** |
| `insurance-final-expense-qualifier` | **`lead_name`**, `agent_name`, `company_name`, **`interest_area`** |
| `insurance-appointment-setter` | **`lead_name`**, `agent_name`, `company_name`, **`interest_area`** |
| `insurance-post-sale-welcome` | **`policyholder_name`**, `agent_name`, `company_name` |
| `insurance-feedback-nps` | `agent_name`, `company_name`, **`interaction_type`** |
| `insurance-policy-renewal` | `agent_name`, `company_name` — **nothing lead-derived** |

And the leads table:

```
 id | org_id      | name           | fields
  1 | org_58c7…   |                | {}          ← the org that placed 6 of 8 calls
  2 | org_68497…  | Krishna Sarone | {city, budget_band, existing_policy, product_interest, best_callback_time, preferred_language}
  3 | org_a4ddb…  |                | {}
```

`getLeadGreetingContext` (`leads/leads.ts:219-230`) can only bind `interest_area` from a lead field, and `lead_name`/`policyholder_name` from a real name. Lead 1 has neither. Lead 2 has fields but **no `interest_area` key** — `product_interest: "health"` is a different key (`intake-schema.ts:105-118` documents the distinction deliberately: `interest_area` is the *spoken* phrase). So the guard rejects, on every call, for every template except `insurance-policy-renewal`.

The code comment at `leads/leads.ts:183` predicted this exactly — "the guard then rejects the line, which is the right call". It is the right *correctness* call. But the net effect is that a latency fix shipped 25 days ago, plus the ADR-085 lead-context work shipped yesterday to feed it, are both dark in production and nobody knew, because nothing alerts on "fast path missed".

This is the ADR-091 shape again, third audit running: enforced on one path, silently inert on the path that matters.

**Worth ~1485 ms off `pickup_to_first_audio` — a ~73% cut on the metric the callee actually feels.** It is the largest single win available and it needs no new vendor, no new model, and no latency/quality trade-off.

---

## 3. Finding 2 (P1) — TTS first-byte roughly doubled the day after ADR-083, and lazy connect is the prime suspect

Residual TTS cost per turn (`tts_first_byte_ms − llm_ttft_ms` — TTS cannot start before the first token, so this is close to its true TTFB):

| call | date/time (UTC) | TTS provider | residual ms |
|---|---|---|---|
| 16 | 08-06 10:46 | cartesia | 223 |
| 17 | 08-06 10:48 | cartesia | 272, 344 |
| 18 | 08-08 16:24 | cartesia | 214 |
| 19 | 08-08 17:30 | cartesia | 283 |
| 20 | 08-09 13:41 | cartesia | 202 |
| 21 | 08-09 17:06 | elevenlabs | 183, 191, 152 |
| **22** | **08-10 10:40** | cartesia | **421, 350, 350, 360, 413** |
| **23** | **08-10 10:42** | cartesia | **377, 341, 349, 403, 362, 375, 345** |

Cartesia pre-08-09-19:00 sits at **202–344 ms**. Cartesia on 08-10 sits at **341–421 ms**, twelve turns, no overlap with the earlier band.

`656708c` — ADR-083, "stop burning the TTS failover chain on a socket nobody spoke on" — landed **2026-08-09 18:55 UTC**, between call 21 and call 22. Part of that change made the TTS connect **lazy**: `stream.ts:1359` — *"`realTts` is undefined until the turn actually has a character to synthesize."*

The mechanism is straightforward. The TTS connection is **per-turn, not per-call** — the code says so explicitly at `stream.ts:1338`: *"the TTS connection is per-turn (unlike STT's persistent per-call connection)"*. So a fresh TLS + WebSocket handshake to `wss://api.cartesia.ai` (`tts/cartesia.ts:27`) is inside every turn's TTS budget. Before ADR-083 that handshake was opened at the top of the turn and overlapped the LLM's prefill for free. After ADR-083 it is deferred until the first token arrives — which **serialises the handshake behind the LLM instead of hiding underneath it**.

Corroborating evidence from the same dataset: turns with `llm_ttft_ms IS NULL` are canned/cached audio with no LLM at all (silence re-prompts, closings). Their `tts_first_byte_ms` clusters tightly at **343, 405, 408, 414, 418, 418, 419, 423, 425, 425 ms** — call it ~415 ms for "our server → Cartesia → first mu-law byte back" with the handshake included. Cartesia publishes Sonic-3 TTFB in the 40–190 ms range and third-party benchmarks put its P50 near 188 ms. **We are paying roughly 200+ ms above the model's own synthesis time**, which is about what a cold TLS+WS handshake from our region to theirs costs.

Two caveats I am not going to paper over:
1. **n = 2 calls after the change.** The correlation is clean and the mechanism is plausible from the code, but this is a hypothesis, not a proven regression.
2. Deploy time is unverified — I can only see commit time. `api.weeber.ai/api/health` returns Vercel `DEPLOYMENT_NOT_FOUND` and there is no health/version route in `packages/api/src`, so **the running binary cannot be fingerprinted from outside.** Everything here is inferred from `main`.

The counter-evidence that makes this worth taking seriously anyway: **ElevenLabs measured 152–191 ms on call 21, roughly half of Cartesia's post-change 341–421 ms** — the opposite of the vendor narrative, and consistent with a per-connection cost dominating over model speed.

**Cheap decisive test:** log the TTS socket-open duration separately from first-byte. One number settles it.

---

## 4. Ranked levers

Expected savings are per-turn on the reply path unless noted. "Measured" means from §1–§3; "cited" means vendor docs or third-party benchmark, unverified here.

| # | Lever | Expected saving | Cost / risk | Confidence |
|---|---|---|---|---|
| 1 | **Make the greeting fast path actually fire** — either seed `interest_area`/`lead_name` on lead intake, or add a tag-less fallback greeting per template so a missing lead field degrades to a shorter literal line instead of an LLM call | **~1485 ms** off pickup-to-first-audio | none — it is already the intended behaviour | **measured** |
| 2 | **Hold the TTS socket for the call, not the turn** (or pre-warm it during the turn's LLM prefill, restoring pre-ADR-083 overlap without re-breaking the failover-chain fix) | **~150–200 ms** every turn | must preserve ADR-083's "idle socket ≠ broken provider" invariant; a held socket needs an idle keepalive | **measured drift, inferred cause** |
| 3 | **Set an explicit low/minimal reasoning effort on the model.** `agent.ts:1151-1165` passes `providerOptions` carrying only gateway fallback models — there is **no `reasoning_effort`, no `textVerbosity`, no `temperature`, no `maxOutputTokens` anywhere** in the file. On a GPT-5-class model that means we are paying default reasoning on every conversational turn | **300–700 ms**, cited. Artificial Analysis puts gpt-5-mini *minimal* at 0.91 s TTFT vs ~1.38–1.65 s for the default configuration — which brackets our measured 1288 ms almost exactly | some quality loss on multi-step tool turns; OpenAI's own voice guidance is start at `low`, not `minimal` | **cited, but our measured TTFT sits right where "reasoning on" predicts** |
| 4 | **Prompt-prefix caching.** `agent_templates.default_persona_prompt` is **19,480 chars** for `insurance-final-expense-qualifier`, 10,337 for `insurance-lead-followup`, and `agent.ts:1142` concatenates workflow-context + caller-memory + known-facts on top. Nothing pins a stable prefix | 13–31% TTFT (arXiv 2601.06007 across providers); up to 70–90% on a well-ordered stable prefix | requires the volatile per-call blocks to move *after* the static persona; gateway must pass caching through | **cited** |
| 5 | **Prune the tool schemas.** All **13** tools in `AVAILABLE_TOOL_NAMES` (`agent-frame.ts:16`) ship on every request, and every production config row has the identical 13-entry `tools_enabled` — including `confirmCodOrder` and `offerCartRecoveryDiscount` on **insurance** agents. Those two are Shopify-only and are pure prefill tax on every insurance turn | 50–150 ms est.; compounds with #4 since schemas are prefix-cacheable | needs per-vertical tool sets — which the vertical architecture already implies | **inferred; the cross-vertical tools are confirmed in prod** |
| 6 | **Get off the endpointing floor.** `endpointing: 300` + `utterance_end_ms: 1000`. Deepgram Flux (2026) is purpose-built for this and posts the lowest end-of-speech detection latency of the current field; the `SEMANTIC_TURN_DETECTION_FLAG` seam already exists (`turn-detection/index.ts`) with a 300 ms budget and `refiner: null` | 150–300 ms, cited | tail-latency risk: Twilio's own guidance is that smart endpointing cuts the median but introduces a stutter effect in the tail. Also a migration, not a config flip | **cited** |
| 7 | **Move the transcript write off the critical path.** `await logTranscript("caller", text)` at `stream.ts:1861` is a DB round-trip sitting between `speech_final` and `runTurn` | part of the measured **122 ms**; likely most of it | fire-and-forget loses ordering guarantees on the transcript | **measured aggregate, unattributed** |
| 8 | **Reconsider the provider default.** `gateway.ts` sets `VOICE_AGENT_MODEL = AI_GATEWAY_MODEL \|\| "openai/gpt-5.4-mini"` and `resolveLlmProvider` defaults to **`"gateway"`** — while `llm/index.ts`'s own comments call Groq "the highest-leverage latency lever available." Groq is configured on exactly one production row, `shopify-feedback`, which is **disabled**. Groq/LPU is cited at 50–250 ms TTFT for Llama-3.3-70B | potentially 500 ms+ | large quality/tool-use change on a 70B open model vs gpt-5-mini; loses the gateway's failover. **Not** a free win | **cited, high variance** |

Gateway overhead itself is **not** a lever — Vercel publishes sub-20 ms P95 routing overhead, ~1% of our LLM budget. Rule it out and stop wondering.

Region colocation could not be assessed: `railway.json` sets no region and the deployed region is not discoverable from the repo. If the API runs in India and Cartesia/Deepgram/the gateway terminate in the US, a chunk of #2's 200 ms and some of #6 is pure RTT and no amount of application tuning will touch it. **This is worth checking before doing any of #2–#8.**

---

## 5. What the measurement cannot see, and should

1. **Endpointing delay.** Stamp the last caller-audio frame timestamp and diff against `speech_final`. Also record *which* signal ended the turn — `speech_final` (~300 ms) or the synthetic `UtteranceEnd` (~1000 ms). Today those two are indistinguishable in the data and they differ by 700 ms.
2. **Outbound transport.** Twilio `mark` events give a playback acknowledgement; diffing first-media-sent against the mark bounds the egress leg.
3. **TTS socket-open time**, separately from first byte (settles §3 outright).
4. **The greeting fast-path decision** — a one-line log of hit/miss with the unresolved tag name. This finding took a database join to discover and should have been a log line.
5. **A `/api/health` version route.** Three audits have now had to reason about production from `main` because the deployed commit is unknowable. It is a five-line route.

---

## 6. Recommended sequence

Nothing here is implemented. If it gets picked up, the order that maximises evidence per unit of risk:

1. **Instrument first** (§5.1, §5.3, §5.4). Two of the three biggest levers are currently unmeasurable, and #1 is invisible.
2. **Fix the greeting fast path** (#1). Largest win, zero trade-off, already-intended behaviour.
3. **Confirm or kill the ADR-083 hypothesis** (#2) with the socket-open metric before touching the connect lifecycle.
4. **Check the deployment region** against every vendor endpoint. Cheap, and it re-prices #2, #6 and #8.
5. Only then the model-side levers (#3, #4, #5) — each one trades quality for milliseconds and needs an eval, not a stopwatch.
6. **Re-measure with real volume.** 13 complete turns cannot support a percentile. Every number in this document is a median over single digits and should be treated as a direction, not a target.

---

## Appendix — provenance

- Production reads: `turn_latency` (35 rows), `call_latency` (9), `calls` (9), `org_agent_configs` (16), `agent_templates` (9), `leads` (3).
- Code read at `main` = `8498e58`. Not verified against the deployed binary (§3 caveat 2).
- No external API was called. Every non-`openvent` number is cited from vendor documentation or a published third-party benchmark and is labelled "cited" in §4.
