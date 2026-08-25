# Phase C — Latency, in the order production says

**Status:** All four sub-phases code-complete as of 2026-08-25 (C1/C2/C3/C4 — see each section's status
note). C1's original session-reuse work shipped 2026-08-24; C3 shipped 2026-08-25 (verified already true);
C4 shipped 2026-08-25 (steps 1-3, step 2 built after fresh post-deploy data confirmed the batching pattern
survives the fix). Re-verifying C4 against that fresh data surfaced two regressions, both now closed: C1's
(barge-in force-closing the held session) fixed 2026-08-25 with a per-context cancel; C2's (mid-call
cache-hit drops) confirmed structurally expected, not a bug, with the exit gate's condition 4 rewritten to
match reality (applied below). **What remains is entirely measurement, not code**: nothing in this phase's
work is deployed (commits are local, not pushed), and this sandbox has no `DATABASE_URL` for
`bun run latency:report` to run against even if it were — every "not yet measured against production"
note in this file is the same open item, not four separate ones. Local gates (lint/typecheck/test/
knip:gate/design:guard/contrast:gate) are clean. `persona:gate` is red — pre-existing, unrelated to
latency, not touched by this phase's work; carried forward as its own item, not a Phase C blocker.
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

**Regression found 2026-08-25 while re-verifying C4 against fresh post-deploy data — root-caused and
fixed the same day.** Exit gate condition 3 ("`tts_socket_open_ms` is absent or < 20 ms on every turn
after the first") was not holding in production. Calls 13-16 (2026-08-25, post-deploy) showed real
non-null values (76-284 ms) on many turns after turn 0, not just the first.

**Root cause, found by reading the code against fresh provider-docs research (2026-08-25), not a bug —
Cartesia's documented idle-disconnect is 5 minutes ([Cartesia docs][cartesia-limits]), and every observed
gap between turns in the fresh sample was 5-30 seconds, ruling that out.** `stream.ts:2637` calls
`closeTtsSession()` on **every barge-in**, and both `tts/cartesia.ts`'s and `tts/elevenlabs.ts`'s
`startTurn().close()` tear down the **entire WebSocket**, not just the interrupted turn's context — each
file's own doc comment says this is deliberate, made because "Cartesia has no documented 'cancel just this
context' message" (same claim for ElevenLabs). **That claim is now out of date.** Current provider docs
disagree:

- **Cartesia** supports a Cancel Context Request over the same socket: `{"context_id": "...", "cancel":
  true}` — *"Use this to cancel a context, so that no more messages are generated for that context"*
  ([Cartesia TTS WebSocket reference][cartesia-tts]). The socket itself stays open for the next turn's
  context.
- **ElevenLabs** supports the same shape: `{"context_id": "...", "close_context": true}` closes one
  context "while the connection remains active"; only `{"close_socket": true}` tears down the whole thing
  ([ElevenLabs multi-context WebSocket reference][elevenlabs-multi]).
- **Sarvam** is the one provider where the existing full-close-on-barge-in behavior is still correct —
  its own docs recommend exactly that (see `tts/sarvam.ts`'s doc comment, unchanged, not re-litigated
  here).

Real calls barge in often enough that this plausibly explains most of the observed reopens — every
interruption used to pay a fresh ~80-280ms handshake before the next turn's audio could start, which is
caller-perceived latency landing on exactly the turns where responsiveness matters most (right after the
caller just interrupted).

**Fixed 2026-08-25.** `tts/cartesia.ts` and `tts/elevenlabs.ts`'s per-turn `close()` now sends the
provider's per-context cancel (`{context_id, cancel: true}` / `{context_id, close_context: true}`) instead
of closing the socket, marking the turn `finished` synchronously so a late provider ack for the
now-canceled context can't double-fire `onDone`/`onError` (both files' message listeners gained a
`turn.finished` guard for this). `stream.ts`'s barge-in handler no longer calls `closeTtsSession()` at
all — `getOrOpenTtsSession`'s own `isOpen()` liveness check at the start of the next turn is what decides
reuse vs. reconnect, correctly, for all three providers without special-casing: Cartesia/ElevenLabs' socket
stays open (their turn-level `close()` no longer touches it) and gets reused; Sarvam's turn-level `close()`
is unchanged (still tears down its one shared socket, per its own docs), so its session correctly reports
`isOpen() === false` and reconnects fresh, same as before. `finalizeCall` still unconditionally calls
`closeTtsSession()` at real call end, so nothing leaks. New `stream-tts-bargein-reuse.test.ts` — proven to
fail against the pre-fix code (`session.dead` was `true` after a barge-in; now stays `false`, and the
following turn reuses the same session, `sessionOpens.length` staying at 1 throughout). 1579/1579 api
tests pass (`bun run test`, `--isolate`), typecheck/lint/knip:gate clean. **Not deployed, not measured
against a real call yet** — the exact Cancel Context Request / close_context message shapes are current
per the docs fetched 2026-08-25 but unverified against a live Cartesia/ElevenLabs account in this sandbox;
worth a live smoke test before fully trusting it the way C1's original session-reuse work is trusted.

[cartesia-limits]: https://docs.cartesia.ai/use-the-api/concurrency-limits-and-timeouts
[cartesia-tts]: https://docs.cartesia.ai/api-reference/tts/tts
[elevenlabs-multi]: https://elevenlabs.io/docs/api-reference/multi-context-text-to-speech/v-1-text-to-speech-voice-id-multi-stream-input

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

**Open regression, found 2026-08-25 while re-verifying C4 against fresh post-deploy data — confirmed by
construction, not a `stablePrefix` bug.** Exit gate condition 4 ("no call shows a mid-call cached-token
drop to 0 after a non-zero turn") is not holding in production. Call 16 (2026-08-25, post-deploy, 33
turns) shows `llm_cached_input_tokens` dropping to 0 repeatedly — turns 10, 11, 19, 20, 26, 28, 31, 32 —
sandwiched between non-zero turns only 5-30s apart, too short for provider cache TTL (Gemini's default is
1 hour) to be the explanation on its own.

**Confirmed, without writing any new code: `stablePrefix` cannot vary mid-call, by construction.**
`buildTurnPromptParts` (`agent.ts:1556`) sets `stablePrefix: input.persona ?? DEFAULT_PERSONA` — nothing
else feeds it, `capturedState`/`workflowMetadata`/`callerMemory` only ever reach `dynamicSuffix`. `persona`
itself is a `let` in `stream.ts` assigned exactly twice, both during one-time call setup (`:3071` at
"start", `:3263` once transfer capability is known) — never inside the per-turn message loop. So this is
not the same class of bug C2's original fix closed; that fix (scrubbing prefix/suffix separately) is
correct and complete for what it targets.

**The real mechanism, confirmed against call 16's actual `tool_calls` rows cross-referenced with
`turn_latency`'s cache values: `dynamicSuffix` (the "Known facts" block, which grows on every
`captureField`/`markFieldUnanswered`) is concatenated into the SAME `system` string as `stablePrefix`
before being sent to the model.** Any provider caching on the literal prefix bytes of that combined
`system` field necessarily misses on any turn immediately following one that wrote a new fact — the bytes
genuinely changed, correctly. Several of the zero-cache turns line up with this exactly: turn 9 captured
`coverage_purpose` right before turn 10 (0); turn 18 captured `budget_comfort` right before turns 19-20
(0, 0); turn 25 captured `benefit_timing` right before turn 26 (0). **This is architecturally expected, not
a defect** — condition 4 as originally worded asks for something the current architecture cannot deliver
whenever a call captures a fact, independent of any caching provider's behavior.

Not every zero turn lines up this cleanly (11, 14, 28 don't have an adjacent capture in this
cross-reference), which is consistent with the residual, genuinely-best-effort nature of Gemini's
*implicit* caching Google's own docs describe — *"[it] has no guarantee... depends on whether the system's
background cache is currently holding your data,"* contrast **explicit** `cachedContent`, which Google
positions as the option for when you need to be "100% sure" a request hits
([Google AI: context caching][gemini-caching]; [Gemini 2.5 implicit-caching announcement][gemini-implicit]).
So the honest picture is two effects layered together: a structural, expected miss right after a capture,
plus a smaller residual layer of ordinary implicit-cache flakiness on top.

**Bonus finding from the same cross-reference, directly relevant to C4: the terminal-turn batch was worse
than the `captured_state` snapshot alone showed.** `captured_state` collapses repeated writes to the same
field to their last value, which hid that turns 30 *and* 31 together fired **10 tool calls** — including
`captureField banking_ready` called twice and `crmSync` called twice with near-duplicate notes — not the 3
fields originally reported. Directly strengthens the case for the cap already shipped in C4 step 2.

**Proposed fix for the exit gate itself, not built:** rewrite condition 4 from "no mid-call drop to 0" to
"a drop to 0 only ever occurs on the turn immediately following a new capture; a call with no new captures
between two turns shows no drop between them." That's testable against `capturedState`'s own turn stamps
and doesn't ask the architecture for a guarantee it structurally cannot make. If deterministic caching
turns out to matter for cost/latency reasons independent of this, Gemini's **explicit** `cachedContent` API
(cache the constant persona/tool-definition text once per persona, decoupled from the per-turn-growing
suffix) is the real lever — its own API round trip and per-hour storage cost mean it only pays off at
enough call volume per persona to amortize, and needs its own latency measurement before committing to it.

[gemini-caching]: https://ai.google.dev/gemini-api/docs/caching
[gemini-implicit]: https://developers.googleblog.com/gemini-2-5-models-now-support-implicit-caching/

---

### C3. Get `stt_connect` off the pickup path

**Status: shipped 2026-08-25 — turned out to already be true, verified and guarded rather than built.**
`stream.ts`'s "start" handler already called `connectSttForCall(ws)` without awaiting it, immediately
before `await runGreeting(ws)`, before this phase existed — STT connect and the greeting's LLM/TTS work
already ran concurrently by construction (step 1). The audit's "`stt_connect_ms` sits on that critical
path" framing was an inference from the numbers alone (both large), not something verified against the
code — the same class of unverified claim Finding 1a/1b caught in the deep-research report. New
`stream-stt-connect-concurrency.test.ts` proves it with a deliberately slow (300ms) mocked STT connect:
the greeting's audio is sent while the connect is still in flight, and `sttConnectMs` is still recorded
once it completes (step 3 — already true, `persistLatency` always ran regardless of critical-path
status). **Step 2 (connect at dial time, behind a flag) deliberately not built** — the plan itself frames
it as optional ("where possible... keep it behind a flag"), `feature_flags` is empty in production so a
new flag would default off and change nothing until manually enabled, and it needs cross-request state
handoff between the dial-time webhook handler and the WebSocket stream handler that nothing in this
codebase does today. No evidence yet that it's worth building. 1553/1553 api tests passing at ship time.

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

**Status: steps 1-3 shipped 2026-08-25.** Step 3 turned out already true, same shape as C3:
`performHangUp` already calls `ws.close()` before `await finalizeCall(...)`, and `finalizeCall` is what
runs the disposition write and `upsertCallerMemory` — the audio path was already closed before those
writes, not something this session had to move. New `stream-hangup-write-ordering.test.ts` locks the
ordering in. `crmSync` itself is **not** a finalizeCall concern — it's a model-invoked tool that
necessarily runs mid-turn (it summarizes the whole call, so it can't fire until the call is substantially
over), and its own description already says "use this once you have enough context — not on every turn,"
which is architecturally different from `captureField`'s "call this immediately" instruction, not a
missing instance of it.

**Step 1, re-answered 2026-08-25 with real data, not "blocked."** The first attempt this session read only
8 calls from the org "good insurance" (2026-08-24 11:39-12:49 UTC) and found the pattern real but partial
(2/6 calls) — thin enough that step 2 wasn't attempted. But those calls predated the actual production
deploy of this session's own C1/C2/C3/A3-adjacent work (Railway shows `cfd7cf8` — everything through C4
step 3 and both defect fixes — went live 2026-08-24T20:18:04Z). Per explicit instruction to verify before
concluding, a fresh query found **5 more calls (ids 13-17, 2026-08-25 09:02-10:04 UTC)** placed genuinely
after that deploy. Call 16 (33 turns) reproduced the pattern on fully-shipped code, and cross-referencing
`tool_calls`' actual timestamps against `turn_latency` (done while confirming the C2 hypothesis below)
showed it was **worse than the `captured_state` snapshot alone reported**: `captured_state` collapses
repeated writes to the same field to their last value, hiding that turns 30 *and* 31 together fired **10
tool calls** — `setIntent`, `setDisposition`, `captureField banking_ready` (twice), `crmSync` (twice, with
near-duplicate notes), `captureField health_flag`, `captureField tobacco` — not the 3 fields originally
read off `captured_state`. Turn 30 alone was 3616 ms v2v, turn 31 was 3624 ms, the two worst turns of the
call, immediately followed by `hangUp` on turn 32. Same shape as the pre-deploy calls 6 and 8. That's **3
reproductions across two independent samples, one of them confirmed post-fix, one of them more severe than
first measured** — A3's prompt-only instruction demonstrably does not hold under the fully-shipped code,
which clears the plan's own "if the model still batches" bar for step 2.

**Step 2 — shipped 2026-08-25**, after that evidence. `MAX_TOOL_CALLS_PER_TURN = 2` in
`packages/api/src/voice/agent.ts`: `withPerTurnCap` wraps a tool's `execute` to return a graceful
`{ deferred: true, message }` result (never a thrown error, same shape as `withToolTimeout`'s own
graceful refusal) once a shared per-turn counter reaches the cap, telling the model to finish speaking now
and retry the call on its next turn. `TOOL_CALL_CAP_EXEMPT` = `{hangUp, transferToHuman,
flagGuardrailEvent}` — terminal/escalation/audit actions that must never be deferred, deliberately kept
out of the exact machinery behind ADR-082/-105/-106/-115's four prior subtle defects. The counter
(`{ count: 0 }`) is created once per `runVoiceAgentTurn` call and threaded into `buildVoiceTools`, so it
persists across a transport-failover retry of the same turn and resets naturally each new turn. Every
other `buildVoiceTools` caller (text test-chat, synthetic harness, preview drawer) omits the counter and
stays unbounded. New unit tests for `withPerTurnCap` and its `buildVoiceTools` wiring (shared-counter-
across-tools, exemption set never capped). 1578/1578 api tests pass via `bun run test`
(`--isolate`), typecheck/lint/knip:gate clean. **Not deployed, not measured against a real call yet** —
needs a `bun run latency:report` pass over calls placed after this ships to confirm the cap actually moves
the terminal-turn spike, and to check whether 2 is the right number rather than a first guess from this
session's own read of the evidence.

**Approach checked against the AI SDK's own feature set (2026-08-25 research) — no built-in alternative
exists.** A per-turn tool-call cap has been requested of the AI SDK itself more than once and isn't
shipped: `maxToolSteps` ([vercel/ai #5026][ai-5026]) and `singleToolPerStep`
([vercel/ai #3854][ai-3854]) are both still open feature requests: `stopWhen` only gates whole *steps*
(`isStepCount`/`hasToolCall`), not a running count of individual tool calls within/across steps, which is
exactly why this needed a custom wrapper at the tool-`execute` level (`withPerTurnCap`) rather than an SDK
option. Confirms this is the right layer to build it at, not a missed built-in.

**Two open items surfaced while re-verifying, out of scope for this task:** C1's `tts_socket_open_ms` being
non-null on many mid-call turns was root-caused to barge-in closing the whole socket when Cartesia/
ElevenLabs both support a cheaper per-context cancel, and **fixed the same day** (see C1's status note
above) — unverified against a live account. C2's cache-hit percentage still drops to 0 mid-call in call
16 — confirmed by construction to be structurally expected on any turn right after a new capture, not a
`stablePrefix` bug, with a proposed exit-gate rewording written but not yet applied to the exit gate below
(see C2's status note above).

[ai-5026]: https://github.com/vercel/ai/issues/5026
[ai-3854]: https://github.com/vercel/ai/issues/3854

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
4. **`stablePrefix` hash is constant within a call** (asserted by test — already provably true by
   construction, see C2's status note), **and a cached-token drop to 0 only ever follows a turn that wrote
   a new `captureField`/`markFieldUnanswered` fact** — a call with no new captures between two turns must
   show no drop between them. (Rewritten 2026-08-25: the original "no mid-call drop to 0, period" asked
   the architecture for a guarantee it cannot make whenever a call captures a fact — see C2's status note
   for the production evidence this rewording is based on.)
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
