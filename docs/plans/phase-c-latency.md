# Phase C — Latency, in the order production says

**Status:** In progress — C1 shipped 2026-08-24, C2 shipped 2026-08-24; C3/C4 remaining
**Blocks:** Phase D, Phase E
**Preconditions:** Phase B's exit gate met — in particular `bun run latency:report` reproducing the
audit's headline numbers. Without that command this phase has no acceptance test and must not start.
**Evidence:** `docs/audits/2026-08-21-first-two-production-calls.md`, findings 3, 5, 6, 7
**Governing ADRs:** ADR-107 (telemetry cutover), ADR-001 (cascade architecture — not reopened),
ADR-063 (semantic turn detection — gate closes here)

---

## Why this phase exists

Production is 2.5–3.4× off target on the number a prospect notices first:

| Metric | Target | Call 1 | Call 2 |
| --- | --- | --- | --- |
| `pickup_to_first_audio_ms` | 800 | **1985** | **2753** |
| `stt_connect_ms` | — (on the critical path) | **608** | **753** |
| per-turn `voice_to_voice_ms` p50 | 800 | pooled **≈ 1750** | |
| per-turn `voice_to_voice_ms` p95 | 1200 | pooled **≈ 4500** | |

Both calls are **post** the ADR-107 cutover, so `llm_ttft_ms` and `tts_first_byte_ms` do not overlap and
can be added: `v2v ≈ llm_ttft + tts_first_byte + ~130 ms`. That decomposes to **LLM ≈ 70%, TTS ≈ 23%,
other ≈ 7%** — which independently confirms
`docs/voice-quality/llm-provider-latency-case-study-2026-07-17.md` (~1000–1600 ms out of a 1.7–2.1 s
turn), almost exactly.

The work below is ordered by **verified ms per unit of risk**, and it is deliberately not the order the
deep-research report proposed. Two of that report's three headline recommendations are refused at the
bottom of this file, with the rows that refute them.

---

## The work

### C1. Stop opening a TTS socket on every turn — the largest verified win

**Status: shipped 2026-08-24.** `TtsSession`/`ConnectTtsSession` (`tts/types.ts`); `stream.ts` holds one
session per call (`getOrOpenTtsSession`/`closeTtsSession`), reused turn to turn, pre-warmed at pickup in
parallel with STT connect, torn down on barge-in/call-end. Cartesia and ElevenLabs multiplex per-turn
`context_id`s over one socket (ElevenLabs moved `/stream-input` -> `/multi-stream-input`); Sarvam sends
`config` once then a text/flush cycle per turn. Not pooled across calls. `onSocketOpen` only fires on a
genuine new connect, so `turnTtsSocketOpenMs` stays absent (not 0) on a reused turn, matching the exit
gate's condition 3. `stream-tts-lazy-connect.test.ts`/`stream-tts-voice-identity.test.ts` rewritten for
the session model. 1542/1542 api tests passing at ship time. **Not yet measured against production** —
the ~250ms/turn expected win below is unverified by `bun run latency:report` over real calls.

**~250 ms per turn, on nearly every turn.** `tts_socket_open_ms` is 197–274 ms on all but one turn of
both calls, and it is a component of `tts_first_byte_ms` (median ≈ 412 ms). A quarter of every
response is a TCP+TLS+WebSocket handshake to a provider we are about to talk to again in two seconds.

**Where:**

- `packages/api/src/voice/tts/index.ts` — `connectTts` (:44) and the provider map (:13–:15).
- `packages/api/src/voice/tts/elevenlabs.ts`, `cartesia.ts`, `sarvam.ts` — the per-provider connect
  functions. Each opens its own socket; the reuse must be implemented once at the `index.ts` layer, not
  three times.
- `packages/api/src/voice/stream.ts:1546` (the comment already pointing at
  `turnLatency.ttsSocketOpenMs`), `:1885` where the per-turn value is recorded, and the lazy-connect
  behaviour covered by `stream-tts-lazy-connect.test.ts`.

**How:** hold the TTS socket open across turns for the life of the call, and pre-warm it during setup
so the greeting does not pay for it either.

1. Give the session a single TTS connection, opened once, with an explicit keepalive appropriate to the
   provider and a reconnect path if it drops mid-call. Measure and record the reconnect as a socket
   open so the metric stays honest — the goal is `ttsSocketOpenMs` being **absent or ~0 on turns after
   the first**, not the column quietly going null.
2. Pre-warm during call setup, in parallel with STT connect (see C3), so the greeting's TTS byte does
   not wait on a handshake.
3. Voice identity must survive reuse. `stream-tts-voice-identity.test.ts` exists because voice
   selection is per-call config; a pooled or reused socket must not carry the previous call's voice.
   **Do not pool across calls** in this phase — reuse within a call is the whole win, and cross-call
   pooling is where the voice-identity bug would come from.
4. Sarvam is the Indic branch (`resolveTtsProvider`). Under ADR-119 / Phase E, US orgs will not reach
   it at all; do not special-case it here beyond making sure reuse is implemented at the `index.ts`
   layer so all three providers inherit it.

**Test:** extend `packages/api/src/voice/tts/index.test.ts` and
`stream-tts-lazy-connect.test.ts` — a multi-turn session opens exactly one socket; a dropped socket
reconnects and the reconnect is recorded; voice identity is correct on turn 2.

**Expected:** `tts_first_byte_ms` median from ≈ 412 ms toward ≈ 160 ms; ≈ 250 ms off v2v on every turn
after the first.

---

### C2. Stabilize the prompt prefix so the cache stops missing

**Status: shipped 2026-08-24.** Found by construction, matching this section's own step 1: the culprit
was suspect 4, `scrubSystemPrompt` behaving differently once certain content appears — not the captured-
state/workflow-metadata/caller-memory leak the other suspects predicted. `scrubSystemPrompt`/
`stripUnresolvedMergeTags` (`merge-tags.ts`) only early-returns the input byte-identical when the string
has zero unresolved `{{tag}}`s; the moment it finds even one, it runs three whitespace-collapse regexes
across the WHOLE string it was given, not just near the tag. The old call site scrubbed
`stablePrefix + dynamicSuffix` as one concatenated string, so on any turn where `dynamicSuffix` (which
renders live captured-field/caller-memory/workflow-metadata VALUES — not guaranteed tag-free, since a
value is whatever a prior tool call wrote) happened to contain a stray `{{word}}`-shaped value, the
PREFIX's own double-spaces/bullets/punctuation got silently rewritten too, even though `stablePrefix`
itself never changed. New `composeTurnSystemPrompt` (agent.ts) scrubs `stablePrefix`/`dynamicSuffix`
SEPARATELY so this is now structurally impossible. Also shipped: `hashStablePrefix` + a per-call
`onStablePrefixHash` callback (stream.ts logs a warning if the hash ever changes mid-call — the live
version of this section's step 1 instrumentation), the step-2 test (`agent.test.ts`, prefix hash constant
across a simulated multi-turn call including a turn with a stray merge-tag-shaped captured value), and
step 3 (`summarizeCacheStability` in `voice/latency-report.ts`, wired into `bun run latency:report`'s
output, flagging any call whose per-turn cache-hit% drops back to 0 after a non-zero turn). 1550/1550 api
tests passing at ship time. **Not yet measured against production** — no post-fix production calls exist
yet to run `latency:report` against and confirm the mid-call-drop shape is actually gone live, not just
in the simulated test.

**Where:**

- `packages/api/src/voice/agent.ts` — `buildTurnPromptParts` (:1367 type, :1379 default), the
  `stablePrefix` / `dynamicSuffix` split, and `:1624`–`:1625` where they are composed and scrubbed.
- `calculateCacheHitPercent` (`agent.ts:1444`) already exists and computes the number nothing reads.

**How:** call 2's cached-token share goes 0 on turns 0–2, then 67% / 33% on turns 3–4, **back to 0 on
turns 6, 8 and 11**, then ~93% on 12, 13, 15, 17. A prefix that is stable does not do that. Something
inside `stablePrefix` is changing mid-call.

1. Find it by construction, not inspection: hash `stablePrefix` every turn and log the hash. Any change
   after turn 0 is a bug. Likely suspects, in order — the captured-state or known-facts block leaking
   into the prefix instead of the suffix (Phase A's A3 explicitly puts its new instruction in the
   prefix, so verify that instruction is constant and not templated with per-turn data), workflow
   metadata, caller memory, and `scrubSystemPrompt` behaving differently once certain content appears.
2. Assert it: the prefix hash must be identical for every turn of a call. This is the fix — a test that
   fails when someone puts a timestamp, a turn counter or a fact into the prefix.
3. Surface `calculateCacheHitPercent` in Phase B's report output (it will already be there if B1 was
   done) and treat a mid-call drop as a defect rather than provider variance.

**Note what this is *not* worth.** The tail is **not** cache-driven: call 2's turn 18 had an 85% cache
hit and the worst TTFT of the call (4436 ms), while turn 13 had 93% and 916 ms. Cache stabilization
buys consistency in the middle of the distribution, not the p95. Do not attribute the tail fix to it —
that is C4.

**Test:** `packages/api/src/voice/agent.test.ts` — prefix hash constant across a simulated multi-turn
call including turns that add captured facts, workflow metadata and caller memory.

---

### C3. Get `stt_connect` off the pickup path

**600–753 ms, once per call**, sitting inside a `pickup_to_first_audio_ms` of 1985–2753 ms against an
800 ms bar. This is the single biggest component of the first impression.

**Where:**

- `packages/api/src/voice/stt/deepgram.ts`, `stt/index.ts`.
- `packages/api/src/voice/stream.ts:2393` (where `sttConnectMs` is assigned), `:358`, `:378`–`:390`
  (the `callLatency` upsert), `:937`.
- `packages/api/src/voice/call-health.ts:183` — `STT_CONNECT_DEGRADED_MS`, which did not fire on 753 ms
  and is recalibrated in Phase B.

**How:** the connect must not be serialized ahead of the greeting.

1. Start the STT connect **concurrently** with the TTS pre-warm and the greeting synthesis. The greeting
   is agent audio; it does not need STT to be ready. The only hard requirement is that STT is ready
   before the caller's first words arrive, which is at least a greeting's length away.
2. Where possible begin the connect at dial time rather than at pickup — an outbound call knows it is
   about to need STT before the callee answers. Weigh this against paying for a connection on unanswered
   calls; both production calls answered, and there is no data on the ratio yet, so keep it behind a
   flag and note that **`feature_flags` is empty in production, so every flag resolves to its code
   default** (audit, finding on flags). Choose the default deliberately.
3. Keep `sttConnectMs` recorded as wall-clock connect duration even when it is off the critical path —
   the metric must not become "0 because we hid it". If it is no longer on the path, that is what
   `pickupToFirstAudioMs` is for.

**Test:** a test asserting the greeting's first audio byte does not await STT readiness, and that
`sttConnectMs` is still populated.

---

### C4. Kill the terminal tool batch — this is the p95

Phase A3 already moves the captures off the last turn for integrity reasons. This task **collects the
latency benefit and verifies it**, and it is the only place the p95 target is achievable.

The tail is entirely terminal turns: call 1 turn 11 (TTFT 3582 ms, v2v 4031 ms) and call 2 turn 18
(TTFT 4436 ms, v2v 4846 ms, **319 output tokens** against a typical 40–77). A turn emitting seven tool
calls and 319 tokens is slow because of what it is doing, not because of the stack.

**Where:** `packages/api/src/voice/stream.ts` finalize path (`:978`–`:1007`), the tool telemetry hooks
(`:1994`, `:2131`), and the persona instruction added in A3's `stablePrefix`.

**How:**

1. Confirm with `bun run latency:report` that post-A3 calls no longer show a terminal-turn spike, using
   the terminal-turn capture ratio counter A3 added.
2. If the model still batches, the instruction is not enough and the fix is structural: do not let a
   single turn carry an unbounded tool list. Cap tool calls per turn and let the remainder land on the
   next turn.
3. Whatever must still happen at hangup (final disposition, `crmSync`, `caller_memory` upsert) happens
   **after** the audio path is closed, never in the turn the caller is waiting on.

**Test:** a synthetic multi-fact call asserts no single turn carries more than the cap, and that
`capturedState` is complete before the final turn.

---

## Exit gate

```bash
cd /home/user/weeber
bun run latency:report
bun run lint
bun run typecheck
cd packages/api && bun run test && cd ../..
bun run knip:gate
bun run persona:gate
bun run design:guard
bun run contrast:gate
```

Conditions, all measured by `latency:report` over calls placed **after** this phase, post-ADR-107
window:

1. **per-turn `voice_to_voice_ms` p50 < 1100 ms** (from ≈ 1750).
2. **`pickup_to_first_audio_ms` < 1200 ms** (from 1985 / 2753).
3. **`tts_socket_open_ms` is absent or < 20 ms on every turn after the first** of a call.
4. **`stablePrefix` hash is constant within a call**, asserted by test, and no call shows a mid-call
   cached-token drop to 0 after a non-zero turn.
5. **No terminal-turn latency spike**: the slowest turn of a call is not systematically its last.
6. n ≥ 10 calls behind these numbers. Two calls is what produced a wrong baseline in the first place;
   do not close this gate on a sample of two. Place them via the synthetic/test-call path if real
   traffic is not available, and say which in the commit.
7. p95 < 1200 ms is the **stated target but not the gate**, because it depends on Phase D's turn-taking
   work. Record the achieved p95 in the commit message so D can be judged against it.

---

## Explicitly refused

These are refused on production evidence, not on preference. Each has been proposed before and will be
proposed again.

**Lowering `utterance_end_ms` (`packages/api/src/voice/stt/deepgram.ts:108`, currently `"1000"`).**
Worth **exactly 0 ms**. All **26** turns that recorded an `endpoint_signal` recorded `speech_final`;
`utterance_end` **never fired once**, and `endpointing_delay_ms` is 1–22 ms. The 1000 ms value is
sitting on a path nothing takes. The deep-research report ranked this as the headline compressible
millisecond and it is nothing. Changing it is not harmful — it is simply not work, and doing it creates
the false impression that endpointing was addressed.

**Wiring a semantic-turn-detection refiner.** ADR-063 made this conditional on gate (a): evidence of
callers being cut off. Production shows **no cut-offs** — the endpointing data above, and the one
interruption that did occur (finding 4) came from the *idle prompt*, not from endpointing, and is fixed
in Phase D. Gate (a) is now answerable and the answer is **no**. Gate (b) — staging and production not
sharing a database — is also still unmet. This closes as **not needed**; do not reopen it without new
rows showing cut-offs.

**Revisiting the cascade architecture (ADR-001) or moving to speech-to-speech.** Production says the
cost is LLM TTFT (≈ 70% of v2v), which is addressable inside the cascade — provider, prompt size,
cache, and the tool-batch tail. A rewrite is not justified by this evidence and is out of bounds for
this plan.

**Enabling `semantic-turn-detection` or backchannel flags to "see if they help".** `feature_flags` is
**empty in production**, so every flag resolves to its code default: semantic turn detection is off,
backchannels are off. Nothing measured in the audit reflects a flag-gated feature, which means flipping
one changes the system out from under every number in this file. Flags get flipped in D, deliberately,
with the measurement in place.

---

## Explicitly out of scope

- **Turn-taking, barge-in, idle prompts** — Phase D. They move latency numbers, which is exactly why C
  measures first and D changes them second.
- **Model or provider swaps.** The 70% LLM share makes this tempting. It is a bigger decision than a
  latency task, it interacts with the case study in `docs/voice-quality/`, and it needs its own ADR.
- **Region/replica moves.** Both calls dialled `+91` mobiles from a **US** Twilio number
  (`+16893584869`), so some of the baseline is transit that no code change fixes. That is Phase E, and
  it is why C's targets are set against a US-origin baseline rather than an idealized one.
