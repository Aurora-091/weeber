---
doc: active-context
status: LIVE — update every session you do meaningful work
updated: 2026-08-25
---

# Active context — what's happening right now

> **The most important file for an agent picking up cold.** It answers "what were we doing, where did
> we stop, what's next." Keep it short and *current* — a stale entry here is worse than none. When you
> finish meaningful work, update the three sections below and move anything shipped into `progress.md`.

## Current focus

- **Phase C pushed, deploys still pending manual approval; Phase D in progress, D1-D7 shipped, only D8
  left (2026-08-25).** Phase C's 3 commits are on `origin/main`; Railway auto-triggered `production`/
  `staging` deploys, both still sit in `NEEDS_APPROVAL` — confirmed no API/MCP path exists to approve one,
  only the dashboard's Approve button, so this is a standing external blocker, not something to keep
  re-checking. Phase D's own precondition (a recorded Phase C baseline) is satisfied provisionally by the
  pre-deploy numbers recorded in `phase-c-latency.md` (v2v p50 1481ms, p95 3463ms), flagged for
  reconciliation once someone approves the deploys and real post-fix calls land. D1 through D7 are each
  shipped, committed, and detailed under `## Done` in `progress.md` (D1 idle-prompt thresholds, D2 question
  ledger/askCount, D3 escalation-trigger audit guardrail, D4 filler-line rewrite + hybrid-audio-cache
  opt-out, D5 unsourced-claim decision — no code, D6 dictation-sequence endpointing, D7 non-interruptible
  tool calls/disclosure) — none deployed yet, same standing blocker as above. **Only D8 (critical-field
  spell-back confirmation) remains before Phase D's own exit gate can be evaluated.**

- **Phase C (latency) is code-complete as of 2026-08-25 — all four sub-phases shipped, at the user's
  direction to research, fix, and close the phase in one session (`docs/plans/phase-c-latency.md`).** C1
  (TTS session reuse, 2026-08-24) + its barge-in follow-up (2026-08-25, see bullet above); C2 (prompt-cache
  scrubbing, 2026-08-24) + its exit-gate condition 4 rewritten to match what the architecture can actually
  guarantee (2026-08-25, applied to the exit gate below the status line); C3 (STT-off-pickup-path,
  2026-08-25, verified already true); C4 (terminal-tool-batch cap, 2026-08-25, all 3 steps). Local exit-gate
  checks run and clean: lint, typecheck (`bun run typecheck`, not a bare root `tsc` — that command picks up
  unrelated pre-existing errors in `packages/web`/`supabase/functions`/`tools/*` and is not this repo's real
  gate), 1579/1579 api tests (`bun run test`, `--isolate`), `knip:gate`, `design:guard`, `contrast:gate`
  (42/42). `persona:gate` is red but pre-existing and untouched by this phase — a separate content-budget
  item, not a latency defect. `bun run latency:report` cannot run in this sandbox (no `DATABASE_URL`), and
  nothing this phase shipped is deployed (commits are local only, not pushed) — so every condition that
  needs real post-fix production calls is the same single open item, not evidence anything is wrong. Three
  commits this session: C4 step 2 (`abef5ee`), C1 barge-in follow-up (`1cc5b51`), plus this doc-only
  closing pass.

- **C1's barge-in regression fixed — a caller interruption no longer force-closes the held TTS session
  (2026-08-25, `packages/api/src/voice/tts/{cartesia,elevenlabs}.ts`, `stream.ts`,
  `docs/plans/phase-c-latency.md`).** Follow-up to the research bullet below: `tts/cartesia.ts`'s and
  `tts/elevenlabs.ts`'s per-turn `close()` now send the provider's own per-context cancel
  (`{context_id, cancel: true}` / `{context_id, close_context: true}`) instead of closing the whole
  socket, each marking the turn `finished` synchronously so a late provider ack for the now-canceled
  context can't double-fire `onDone`/`onError` (both files' message listeners gained a `turn.finished`
  guard). `stream.ts`'s barge-in handler no longer calls `closeTtsSession()` at all — `getOrOpenTtsSession`'s
  own `isOpen()` check at the next turn now correctly decides reuse (Cartesia/ElevenLabs, socket untouched)
  vs. reconnect (Sarvam, whose turn-level `close()` is unchanged, still correct per its own docs) without
  any special-casing in `stream.ts` itself. `finalizeCall` still unconditionally tears the session down at
  real call end. New `stream-tts-bargein-reuse.test.ts`, proven to fail against the pre-fix code (session
  was force-closed on barge-in; now survives, and the following turn reuses it). 1579/1579 api tests pass
  (`bun run test`, `--isolate`), typecheck/lint/knip:gate clean. **Not deployed, not measured against a
  real call** — the exact Cartesia/ElevenLabs message shapes are current per docs fetched 2026-08-25 but
  unverified against a live account.

- **Phase C's two open regressions researched and, for C2, confirmed by construction — no code changed
  this pass, doc-only (2026-08-25, `docs/plans/phase-c-latency.md`).** User asked to review the whole C
  phase with internet/GitHub research before committing anything. Findings, both written into the plan
  doc with sources:
  **C1** — the "socket keeps reopening mid-call" regression (see the bullet below) is root-caused, not
  diagnosed further this pass: `stream.ts:2637` closes the entire TTS socket on every barge-in, and current
  Cartesia/ElevenLabs docs both support canceling just the interrupted context instead
  (`{context_id, cancel: true}` / `{context_id, close_context: true}`) — the existing code comments
  claiming no such feature exists are out of date. Sarvam's own docs still say full-close is correct there.
  Not implemented — **held, per explicit instruction to review the whole phase as one batch before more
  code changes.**
  **C2** — chased to a real, confirmed answer instead of left as a guess. `stablePrefix` is proven
  incapable of varying mid-call by construction (`buildTurnPromptParts` only ever feeds it `persona`, and
  `stream.ts`'s `persona` variable is assigned exactly twice, both during one-time call setup, never per
  turn) — so C2's original fix is correct and complete, and the mid-call cache-hit-to-0 drops are NOT that
  bug recurring. Cross-referencing call 16's actual `tool_calls` rows (fetched fresh — the `captured_state`
  summary alone wasn't enough) against `turn_latency` confirmed the real mechanism: `dynamicSuffix` (the
  "Known facts" block, which grows on every capture) is concatenated into the same `system` string as
  `stablePrefix`, so a provider caching on literal prefix bytes necessarily misses on any turn right after
  a new capture — several zero-cache turns line up with a capture on the immediately preceding turn exactly
  (turns 10, 19-20, 26 following captures on turns 9, 18, 25). Not every zero turn lines up this cleanly,
  consistent with Gemini implicit caching's own documented best-effort nature on top. **Net conclusion:
  exit-gate condition 4 as originally worded asks for something the current architecture cannot deliver
  whenever a call captures a fact — proposed a rewritten condition** ("a drop only ever follows a new
  capture; a call with no captures between two turns shows no drop between them") **in the plan doc,
  not applied to the file yet.**
  **Bonus, found via the same `tool_calls` cross-reference:** call 16's C4 batching defect was worse than
  first reported — `captured_state`'s snapshot collapses repeated field writes, hiding that turns 30 AND
  31 together fired 10 tool calls (including two duplicate `captureField banking_ready` calls and two
  near-duplicate `crmSync` calls), not the 3 fields originally read. Strengthens, doesn't change, the
  already-shipped C4 step 2 cap. Plan doc updated in place with all of this; nothing else changed.

- **C4 step 2 shipped — a per-turn tool-call cap, built only after re-verifying against fresh post-deploy
  production data (2026-08-25, `packages/api/src/voice/agent.ts`, `docs/plans/phase-c-latency.md`).** The
  2026-08-25 ten-call review's C4 finding was itself stale by the time this session picked it back up — it
  read the org "good insurance"'s first 8 calls (2026-08-24 11:39-12:49 UTC), but Railway's deploy log
  showed `cfd7cf8` (everything through C1/C2/C3/C4-step3 and both defect fixes) went live at
  **2026-08-24T20:18:04Z**, after those calls. User's instruction was explicit: verify the calls before
  concluding anything. Querying Supabase fresh found **5 more calls (ids 13-17, 2026-08-25 09:02-10:04
  UTC)** — genuinely placed after the full deploy, never read by any prior audit. Findings: (1) **C4's
  batching pattern reproduced again, on fully-deployed code** — call 16 (33 turns) captured 3 fields
  (`tobacco`, `health_flag`, `banking_ready`) in turn 30 alone, 3616-3624ms v2v, the worst of the call,
  the same shape as the pre-deploy calls 6 and 8 the original audit found. That's 3 reproductions across
  two independent samples, one of them post-fix — stronger evidence than the original "thin, n=2/6"
  finding, since A3's prompt-only instruction demonstrably still doesn't hold under the fully-shipped code.
  (2) **Two adjacent, NOT-yet-fixed regressions surfaced along the way, out of scope for this change**:
  `tts_socket_open_ms` (C1) is non-null on many turns after the first across calls 13-16 (76-284ms), not
  just turn 0 — the session reuse isn't holding for a full call in production; and `llm_cached_input_tokens`
  (C2) drops to 0 mid-call repeatedly in call 16 (turns 10, 11, 19, 20, 26, 28, 31, 32) with only 5-30s
  gaps between turns — too short for provider cache TTL to explain it, and the input-token count itself
  swings inconsistently (20315 -> 6719 -> 13550 -> 6808), which doesn't match the pure-whitespace-scrub
  mechanism C2's fix targeted. Neither chased down this session — flagged here for whoever picks up Phase
  C's exit gate next. **User explicitly chose "build the cap now"** given the strengthened evidence, over
  filing findings and holding, or chasing C1/C2 first.
  Implementation: `MAX_TOOL_CALLS_PER_TURN = 2` (chosen from the evidence — permits the common two-facts-
  in-one-utterance case, forces anything beyond that to spill to the next turn); `withPerTurnCap` wraps a
  tool's `execute` to return a graceful `{ deferred: true, message }` result (never a thrown error) once a
  shared per-turn counter hits the cap, mirroring `withToolTimeout`'s existing graceful-refusal shape;
  `TOOL_CALL_CAP_EXEMPT` = `{hangUp, transferToHuman, flagGuardrailEvent}` — terminal/escalation/audit
  actions that must never be deferred, the exact class of risk ADR-082/-105/-106/-115 already produced
  from this same tool-calling machinery. The counter (`{ count: 0 }`) is created once per
  `runVoiceAgentTurn` call and threaded into `buildVoiceTools`, so it survives a transport-failover retry
  of the same turn (each retry re-calls `buildVoiceTools` but closes over the same counter reference) and
  resets naturally on the next turn. Applied as the outermost tool wrap — a capped call returns instantly,
  before the filler timer or timeout race would start. Every other `buildVoiceTools` caller (text
  test-chat, synthetic harness, preview drawer) omits the counter and stays unbounded, unchanged from
  before. New tests: `withPerTurnCap` unit tests plus `buildVoiceTools` wiring tests (shared-counter-
  across-tools, exemption set never capped even when maxed out) in `agent.test.ts`. 1578/1578 api tests
  pass via `bun run test` (the package's documented gate, already `--isolate`'d); a bare `bun test` with
  no isolation shows ~151 unrelated failures across the full suite — confirmed pre-existing on unmodified
  HEAD via `git stash` before assuming this change caused them, a cross-file `mock.module` pollution
  artifact of running without isolation, not something this change caused or fixed. typecheck/lint/
  knip:gate clean. **Not deployed, not measured against a real call yet** — same caveat as every other Phase C item: the actual
  effect on the terminal-turn spike needs a `bun run latency:report` pass over calls placed after this
  ships.

- **Design audit Phase 1 shipped — the "looks poorly worked" complaint traced to broken tokens, not the
  shadcn conversion itself; monochrome direction confirmed, not revisited (2026-08-25, `.theme-weeber` in
  `packages/web/src/web/styles.css`).** User's own framing was exactly right: converting `<select>`/
  `<button>` to shadcn fixed component correctness but never touched the underlying design tokens those
  components render with. Found via `contrast:gate` (already run earlier this session) that
  `tools/ui-guard/tokens.json`'s 9 declared-known contrast failures were real, systemic, and its own "why"
  notes already diagnosed the root cause: `--input` was aliased straight to the same soft `--weeber-border`
  used for decorative card/section edges (1.24-1.57:1 measured, need 3:1 — "affects every field on ~40
  pages" per the tool's own note). Fixed by **splitting** a new `--weeber-input-border` token from
  `--weeber-border` rather than darkening the shared one — WCAG 1.4.11 non-text-contrast applies to a form
  control's boundary, not to a decorative card edge, so darkening the shared token would have fixed
  accessibility at the cost of darkening every card border in the product for a requirement that doesn't
  apply to them. Also retuned `--weeber-warning` (light), `--weeber-error` (dark), and `--ring` (dark) —
  all now measured, not guessed (`bun run contrast:gate --strict` iterated to exact passing values, not
  hand-computed). **42/42 pairs now pass; `knownFailures` pruned 9→0 via `--update`.** Second half of
  Phase 1: finished the Agent-page portion of the `<Card>`/`transition-all` migration `design:guard` was
  already tracking as incomplete — `inlineCardClone` 40→38, `transitionAll` 20→16, `rawButton` 87→84 (3
  raw `<button>`s converted to the real `Button` component, which also cleared their inlineCardClone
  false-matches — the metric is a text-pattern match, not JSX-aware, so this only works when the override
  className drops the now-redundant `rounded-*` token the primitive already supplies). Budget ratcheted
  down via `design:guard --update` to lock in the gains. **User explicitly confirmed keeping the
  monochrome design direction** (ADR-039) — the zero-accent-color question from the audit is closed, not
  revisited. Typecheck/lint/build/knip:gate/contrast:gate/design:guard/111 web tests all clean.
  `docs/decisions/adr-032-...md`/ADR-039/ADR-044 describe the system this extends, not supersedes.

- **Fish Audio added as a fifth TTS provider, on request — unverified against a live account
  (2026-08-25, `voice/tts/fish.ts`,
  `docs/audits/2026-08-25-provider-model-currency-research.md`'s "Update" section).** New adapter +
  `@msgpack/msgpack` dependency (Fish's WebSocket protocol is binary, the only non-JSON provider here) +
  a new stateful PCM resampler (`audio-codec.ts`'s `createPcmResampler`) since Fish's documented PCM
  output defaults to 44100Hz with no confirmed 8kHz option — the first provider in this codebase that
  needs real sample-rate conversion, not just the existing mu-law/PCM16 codec. `TtsProvider` widened
  everywhere it's exhaustively matched (5 files: `tts/index.ts`, `default-voices.ts`, `agent-frame.ts`'s
  zod schema, `cost-estimate.ts`, `failover.ts`). Reachable only via an explicit `voiceProvider: "fish"`
  override or `TTS_PROVIDER=fish` — never a smart default, not in the default TTS failover chain, so
  nothing changes for any existing org. **No live credentials in this sandbox and no way to place a test
  call this session** — every protocol detail (exact msgpack field names, whether `sample_rate` is
  honored, whether `stop` closes the whole socket or just one reusable context) is best-effort from
  published docs, not confirmed live; `tts/fish.ts`'s own doc comment says so up front. 10 new protocol
  tests (`tts/fish.test.ts`) + 4 resampler tests (`audio-codec.test.ts`) prove internal consistency with
  the documented protocol, not real-server correctness — **a live smoke test with a real `FISH_API_KEY`
  is the next step before this is trusted the way the other three providers are.** 1569/1569 api tests
  pass, typecheck clean (api + web), lint clean, knip:gate clean.

- **Phase D backlog expanded (D6/D7/D8) with the edge-case research; provider/model currency filed
  separately (2026-08-25, `docs/plans/phase-d-conversation.md`,
  `docs/audits/2026-08-25-provider-model-currency-research.md`).** The 2026-08-25 edge-case research's
  four real gaps are now in Phase D proper, not just a standalone reference: D6 (new) — dictation-sequence
  endpointing (a caller pausing mid-phone-number/email/spelled-name isn't recognized as incomplete, only
  trailing filler words are). D7 (new) — no tool call or the recording-consent disclosure has any
  "non-interruptible" concept, so a barge-in can orphan `bookAppointment`/`crmSync`/`sendSms` mid-flight
  or leave the disclosure partially delivered. D8 (new) — critical-field spell-back confirmation
  (names, PAN/SSN/vehicle-number-shaped fields, general-purpose not insurance-only), justified by a
  sourced number worth remembering: a head-to-head study found **25.5% missed named-entity/alphanumeric
  rates for Deepgram specifically**, the STT provider this codebase actually runs. D1's silence-timeout
  item gained a citation for why it should become **per-persona configurable**, not just a bigger global
  constant. D4 (filler lines) gained three additions: enable the already-built-but-inert
  `hybrid-audio-cache` flag before writing more filler code; broaden beyond tool-call coverage to natural
  discourse markers ("noting that down," "let me check") right after `captureField` calls; localize both
  filler sets (English-only today). Exit gate extended with 3 new numbered conditions (8-10).
  **Deliberately kept separate:** provider/model version currency (Deepgram shipped **Flux** — a
  conversation-native model with turn-detection/interruption/code-switching built in natively, not a
  version bump on `nova-3`; Cartesia shipped **Sonic-3.6** 8 days before this research with native filler
  words + better Hinglish; Sarvam shipped **Saaras v4**; a tool-use-tuned Groq Llama variant exists for
  ADR-109's dark path) — filed as its own doc, not folded into Phase D, since it's opportunistic infra
  currency with no named production defect behind it, not audit-driven work. Three prerequisite
  measurements named (does Flux already solve D6 natively before building a heuristic; Sonic-3.6-vs-cached
  -clips comparison before extending D4 further; benchmark the Groq tool-use variant before ADR-109 is
  ever turned on). Nothing implemented in either doc — both are backlog/reference.

- **Pipeline edge-case research filed against outside literature, cross-referenced to actual code
  (2026-08-25, `docs/audits/2026-08-25-pipeline-edge-cases-research.md`).** No code changed. Four real
  gaps found with a direct line to this product's own vertical: (1) `SILENCE_WARNING_MS`/`SILENCE_HANGUP_MS`
  are global hardcoded constants despite the flagship `insurance-final-expense-qualifier` persona being
  explicitly elderly-skewing — academic/industry research names adaptive-per-persona timeout as the
  standard fix, not a tuning number; (2) `endsMidThought` (`turn-detection/heuristic.ts`) only catches
  trailing filler words, not an incomplete dictated sequence (phone number, email, spelled name) — a
  caller pausing mid-dictation gets cut off; (3) no tool call anywhere reads `abortSignal` or has any
  "non-interruptible" concept, so a barge-in can orphan `bookAppointment`/`crmSync`/`sendSms` mid-flight —
  independently confirms a gap this session already found from reading the code directly, this time named
  by outside literature too; (4) the mandatory recording-consent disclosure is fully interruptible
  (`agentIsSpeaking = true` set unconditionally at the top of every `speak()` call) despite being the most
  compliance-load-bearing line in the call. Two things checked and found ALREADY handled, not gaps:
  backchannel/barge-in are already structurally separate gates, and Hinglish code-switching already
  routes to Deepgram's real `multi` mode (`toDeepgramNova3Language`), not a naive language-detect-then-
  switch shim. Ranked priority list and lower-confidence items (STT-level PII redaction, inbound DTMF, ASR
  hallucination — unverified for Deepgram specifically, the one study found is Whisper-specific) are in
  the doc. Nothing implemented — reference for whoever picks up Phase D or a future PII pass.

- **8 new production calls found (2026-08-24, org "good insurance") and read in full — two real defects
  root-caused and fixed, C4's latency question answered for real (2026-08-25,
  `docs/audits/2026-08-25-ten-calls-full-pipeline-review.md`).** `calls` went from 2 rows (2026-08-21
  audit) to 10 — this session's earlier "no post-A3 data exists" claim was wrong; the data existed and
  hadn't been queried. Full pipeline re-read: latency pooled stats roughly match the 2026-08-21 baseline
  (expected — none of this session's C1/C2 work is deployed, `origin/main` is still 6 commits behind);
  VAD/endpointing's "utterance_end never fires" conclusion is corrected — it fired on 26% of turns in
  this larger sample, reopening (not resolving) ADR-063's gate; C4's terminal-turn spike is confirmed
  real but partial (2 of 6 calls), directly traced to `captureField` batching still happening in one
  turn despite A3's prompt fix; a new, previously-unmeasured latency sink surfaced (8.5s of one call's
  10.5s pickup-to-first-audio has no component metric — likely the "start" handler's own setup sequence).
  **Two defects fixed, both with regression tests proven to fail pre-fix:** (1) a caller self-correction
  split across two `speech_final` events, with the first turn barge-in-aborted before speaking, left two
  adjacent `{role: "user"}` history entries with no boundary — the model glued them with no space when
  quoting `heard` for `captureField`, and ADR-120's guard correctly refused the malformed quote, losing a
  real answered fact 3 times in one call. `stream.ts` now merges consecutive caller turns instead of
  leaving them separate. (2) `routes.ts`'s fire-and-forget `/incoming` calls-row insert can race
  `stream.ts`'s own fallback insert; when the fallback loses the `onConflictDoNothing` conflict,
  `returning()` comes back empty and the old code never re-checked for the row that won — `dbCallId`
  stayed `null` for the rest of two real calls, silently discarding every transcript/tool_call/
  turn_latency/guardrail_event write while the final status update (keyed by `callSid`, not `dbCallId`)
  looked fine. Now re-selects on a lost conflict. 1555/1555 api tests pass (3 new), typecheck clean.
  **Neither fix is deployed** — same caveat as everything else this session.

- **Phase C3 shipped, C4 partial — both turned out to already be true in the code, verified and
  guarded rather than built (2026-08-25, `docs/plans/phase-c-latency.md`).** C3 (get `stt_connect` off
  the pickup path): `stream.ts`'s "start" handler already called `connectSttForCall(ws)` without
  awaiting it, immediately before `await runGreeting(ws)` — STT connect and the greeting's LLM/TTS work
  already ran concurrently before this phase existed. The 2026-08-21 audit's "`stt_connect_ms` sits on
  that critical path" claim was an inference from the numbers alone, never verified against the code —
  the same shape as Finding 1a/1b's debunking of the deep-research report. New
  `stream-stt-connect-concurrency.test.ts` proves it (a deliberately slow mocked STT connect, greeting
  audio still sends before it resolves) and guards it against regressing. Dial-time pre-connect (the
  plan's optional step 2) deliberately not built — no evidence it's worth the cross-request state
  handoff it would need, and a new flag would default off in production anyway (`feature_flags` is
  empty). C4 step 3 (finalize writes happen after the audio path closes): `performHangUp` already calls
  `ws.close()` before `await finalizeCall(...)`, which is what runs `upsertCallerMemory` and the
  disposition write — already true, now guarded by `stream-hangup-write-ordering.test.ts`. **C4 steps
  1-2 are genuinely blocked, not skipped** — step 1 needs `bun run latency:report` run against real
  post-A3 production calls to confirm the terminal-turn spike is actually gone, and production still
  holds only the same 2 pre-A3 calls the 2026-08-21 audit read. Step 2 (cap tool calls per turn) is
  conditional on step 1's finding and is the single highest-risk change available in this phase — it
  touches the exact tool-call-batching machinery behind four prior subtle production defects (ADR-082,
  -105, -106, -115) — so building it against zero evidence was deliberately not attempted. 1553/1553 api
  tests pass (3 new), typecheck clean.

- **Phase C2 shipped — found and fixed why the prompt-cache was dropping to 0% mid-call
  (2026-08-24, `docs/plans/phase-c-latency.md`).** Root cause, found by hashing/inspection exactly as the
  plan's own methodology prescribed: `scrubSystemPrompt`/`stripUnresolvedMergeTags` (`merge-tags.ts`)
  only leaves its input byte-identical when the string has zero unresolved `{{tag}}`s — the instant it
  finds even one, it runs three whitespace-collapse regexes across the WHOLE string it was given, not
  just near the tag. `runVoiceAgentTurn` used to scrub `stablePrefix + dynamicSuffix` as one concatenated
  string, so on any turn where `dynamicSuffix` (which renders live captured-field/caller-memory/workflow-
  metadata **values** — never guaranteed tag-free, since a value is whatever a prior tool call wrote)
  happened to contain a stray `{{word}}`-shaped value, the stable persona's own whitespace got silently
  rewritten too, even though the persona itself never changed — exactly matching the 2026-08-21 audit's
  Finding 7 (cache hit% dropping to 0 on turns 6, 8, 11 after warming on turns 3-4). Fix: new
  `composeTurnSystemPrompt` (agent.ts) scrubs `stablePrefix`/`dynamicSuffix` **separately**, making this
  structurally impossible rather than merely untriggered. Also shipped: `hashStablePrefix` +
  `onStablePrefixHash` (stream.ts logs a warning if the hash ever changes mid-call — live version of the
  plan's step-1 instrumentation ask), the plan's step-2 regression test (`agent.test.ts`), and step 3 —
  `summarizeCacheStability` in `voice/latency-report.ts`, now printed by `bun run latency:report` and
  flagging any call whose per-turn cache-hit% drops back to 0 after a non-zero turn. 1550/1550 api tests
  pass (8 new), typecheck clean. **Not yet measured against production** — no post-fix production calls
  exist yet to confirm the mid-call-drop shape is actually gone live, not just in the simulated test.

- **Pre-C2 review: fillers/backchannels are fully built and entirely inert in production; `tool_call_latency`
  still writes 0 rows (2026-08-24, `docs/audits/2026-08-24-latency-vad-bargein-fillers-observability-review.md`).**
  Code-grounded answer to a founder questionnaire on latency, VAD/endpointing, barge-in, fillers,
  observability, and cascade-vs-S2S, asked before starting Phase C2. Two findings worth carrying forward:
  (1) `maybePlayToolCallFiller`/`maybePlayBackchannel` are fully implemented (threshold-gated, cached-audio,
  barge-in-interruptible, one-per-turn) but gated on `feature_flags["hybrid-audio-cache"]`, and
  `feature_flags` has 0 rows in production — **never once executed in a real call**; the real remaining
  gaps are tool-specific line selection and Hindi/Hinglish localization, both unbuilt. (2) `tool_call_latency`
  (`stream.ts:483`, `persistToolCallLatency`) still writes 0 rows against real tool calls, first found in
  the 2026-08-21 audit and unresolved — breaks both per-tool latency measurement and any future per-call
  observability trace. VAD/endpointing and semantic-turn-detection are confirmed (again) as correctly out
  of scope for Phase C — 26/26 production turns resolved via `speech_final`, `utterance_end` never fired.
  No code changed by this review.

- **UI Modernization & Legacy Component Migration Complete (2026-08-24).**
  - Designed, created, and unit-tested the official shadcn `Card` primitive in `packages/web/src/web/components/ui/card.tsx` with full `.theme-weeber` token binding and 4 variants (`default`, `interactive`, `flat`, `editor`).
  - Completely eradicated all native `<select>` elements (`rawSelect` dropped from 32 to **0 — at target!**) across `/dashboard` and `/app` routes (`analytics.tsx`, `broadcasts.tsx`, `support.tsx`, `workflow-editor.tsx`, `agents.tsx`, `app/agents.tsx`, `app/numbers.tsx`, `app/settings.tsx`, `NodeConfigPanel.tsx`, `setup-modal.tsx`, `FlowPreviewPanel.tsx`, `EnterpriseDialog.tsx`).
  - Eliminated all legacy `.card-action` (dropped to **0 — at target!**) and modernised all product `.card-lift` instances into `<Card>` primitives.
  - Reduced `rawButton` from 110 down to **87** across dashboard and customer views.
  - Ratcheted down design budgets in `tools/ui-guard/design-budget.json` via `bun run design:guard --update`.
  - All automated quality gates passed: `tsc --noEmit` clean, 111/111 unit tests green, `oxlint` 0 warnings/errors, `knip:gate` clean, `contrast:gate` passed, and `bun run audit:daily` fully verified.

- **Login-time network failures now leave a trace, and get retried instead of misreported
  (2026-08-24).** Supabase auth calls go straight from the browser to Supabase, never through this API,
  so a network failure during sign-in (offline, DNS, a blocked/filtered connection) previously showed
  the caller a generic auth error and left zero trace anywhere on our side — "nothing in Railway logs"
  was structural, not a logging gap. `login.tsx`'s `withAuthRetry` wraps every `supabase.auth.*` call
  site (signup, OTP verify/resend, sign-in, password reset/update): on `AuthRetryableFetchError`
  (supabase-js's own class for a request that never got a response) it retries up to twice with a 1s
  delay before giving up, same class of transient failure `user-shell.tsx`'s post-login `me` query
  already retries; a real auth error (bad password, expired code) still returns immediately, never
  retried. `describeAuthError` shows "Can't reach Weeber" for the network case instead of the wrong
  "invalid email or password"-shaped message. New `POST /api/public/client-error` beacon
  (`public-routes.ts`) is what the browser calls to actually leave a trace — best-effort, fire-and-forget,
  never fails or blocks the flow it's reporting on, console-logged only (grep `[client-error]` in Railway
  logs, no DB write — this is a debugging aid, not a queryable metric yet), rate-limited 30/min per IP
  since it's an unauthenticated public endpoint. 3 new api tests, typecheck clean.

- **Phase C1 shipped — the TTS socket is held across turns instead of reopening on every one
  (2026-08-24, `docs/plans/phase-c-latency.md`).** Audit measured `tts_socket_open_ms` at 197–274 ms on
  nearly every turn of both production calls, a straight TCP+TLS+WebSocket handshake tax on a provider
  the call was about to talk to again in ~2 seconds. New `TtsSession`/`ConnectTtsSession` shape
  (`tts/types.ts`) separates "open the socket" from "run one turn on it": `tts/index.ts`'s
  `connectTtsSession` opens once per (provider, voice, language); `stream.ts` holds the result in
  `ttsSession` for the life of the call via `getOrOpenTtsSession`/`closeTtsSession`, reusing it turn to
  turn and reopening only on a dead socket or a provider failover. Pre-warmed at pickup, fire-and-forget,
  in parallel with STT connect, so the greeting doesn't pay for the handshake either. Every provider's
  own reuse mechanic lives in its own file, per the plan's instruction not to implement this three times:
  Cartesia and ElevenLabs both multiplex independent per-turn `context_id`s over one socket (ElevenLabs
  switched from `/stream-input` to `/multi-stream-input` for this — its own documented multi-context
  endpoint); Sarvam sends its `config` message once and then a plain text/flush cycle per turn, per its
  own docs. All three close-and-let-the-next-turn-reconnect on a caller barge-in rather than trying to
  cancel a single in-flight turn (Sarvam's docs say to; the other two have no documented per-context
  cancel). Deliberately **not** pooled across calls — voice identity is per-call config and
  `stream-tts-voice-identity.test.ts` exists specifically to catch a reused socket carrying the wrong
  voice. `onSocketOpen` only fires on a genuine new connect, never on a reuse, so `turnTtsSocketOpenMs`
  stays absent (not 0) on a reused turn — the exact shape the exit gate's condition 3 asks for.
  `stream-tts-lazy-connect.test.ts` and `stream-tts-voice-identity.test.ts` rewritten for the session
  model; 10 other `stream-*.test.ts` files needed a `connectTtsSession` export added to their `./tts`
  mock (Bun throws at import time when a mocked module is missing an export another file statically
  imports — same discovery method ADR-116's addendum used). Also fixed in the same pass:
  `default-voices.test.ts` and `language-passthrough.test.ts` still asserted the old single-context
  `/stream-input` URL and an immediate-on-`open` handshake — both genuinely stale against the new
  `/multi-stream-input` endpoint and its per-context, lazy-on-first-`sendText` handshake, not a test that
  should have stayed green. 1542/1542 api tests pass, typecheck clean. **Not yet measured against
  production** — the plan's ~250 ms/turn win and the exit gate's `tts_socket_open_ms` condition are the
  plan's claim, unverified by `bun run latency:report` against real calls. C2 (prompt-prefix cache
  stability), C3 (STT connect off the pickup path) and C4 (terminal tool-batch tail) are untouched.

- **Doc-retirement rule written down as ADR-118; four finished trackers archived (2026-08-21).**
  The audit below made real archive-vs-delete-vs-rewrite choices and recorded none as a decision.
  ADR-118 is that record: retire a doc by its **class**, not its age or filename — evergreen
  `docs/reference/` is rewritten in place, a dated artifact is filed with its own class (why
  `ui-audit.md` went to `audit/`, not `docs/archive/`), a finished tracker is `git mv`'d to
  `docs/archive/` **with a reason row**, and a doc with no attributable reason is deleted rather than
  given invented provenance. Code citations move in the same commit; append-only folders are moved,
  never edited. Applied to `insurance-language-variants-task.md` (its one flagged gap — no `hinglish`
  disclosure key — is now closed in `weeber-compliance/src/consent.ts`; four live code comments
  repointed), `leads-layer-build-task.md`, `leads-phase2-3-build-task.md`, `PHASE23-PROGRESS.md`.
  `workflow-canvas/v3-user-builder-plan.md` says "not started" but **stays** — v4 supersedes only its
  frontend section and cites the rest as live, the worked example of why banners aren't evidence.
  Still unaudited for accuracy: `architecture/*`, several `docs/reference/*`, the package READMEs,
  `docs/brain/*`. Nothing enforces the rule in CI, and the audit scripts live in `/tmp`, not the repo.
- **Docs audited against the code; four rewritten, five moved out of the root (2026-08-20).**
  `docs/reference/api-reference.md` documented 19 endpoints of ~180 and has been rebuilt from the real
  route tree; `dashboard.md` listed 7 of 23 admin pages; `security.md` pointed at a tunnel script that
  does not exist in this repo; `.env.example` — the env-var reference `AGENTS.md` sends you to — was
  missing 37 vars the code reads and still advertised two dead `*_VOICE_ID` overrides. CI's job count
  (twelve + `ci-success`, `persona-size` was the uncounted one) was wrong in four files. `ui-audit.md`
  moved to `audit/2026-08-03-audit-ui-ux-full-surface.md` (its three code-side citations updated with
  it); `ui-implementation-plan.md`, `ui-phase0-notes.md`, `UI-FIX-TASK.md` and `ci-triage-notes.md`
  moved to `docs/archive/`; `Untitled.md` deleted; `README.md` now indexes every root file. Immutable
  history (`docs/changelog/`, `docs/decisions/`, `docs/archive/`, `audit/`, `docs/audits/`,
  `docs/product-strategy/`) was not rewritten, and `docs/agent-prompts/` was not touched. Full detail in
  `docs/changelog/2026-08.md`.

- **CI was red for four reasons; three fixed, one needs a human (2026-08-20, `403c0ab`, `e2aecc8`,
  `ece0bdd`).** GitHub Actions has refused to start *any* job since 2026-08-19 12:44Z — "recent account
  payments have failed or your spending limit needs to be increased". Nothing in the repo can fix that;
  `main` and both open PRs stay red until it is cleared in Settings → Billing & plans. The three code
  causes are fixed and verified locally: the silence-timeout race test disarmed by `a6d2b87`, the
  signed-out `/app` redirect that `6c0d978` made async (killing `app-login @ {390,768,1440}` mid-settle
  and mis-sending `?cleanup=1` on plain unauthenticated visits), and 18 stale visual baselines traced to
  `f5431e1`/`ac83ea9` and regenerated after review. Full battery green locally. Still open and untouched:
  the `Supabase Preview` check ("Remote migration versions not found in local migrations directory").

- **"Sign in again" was wrong advice for a network failure (2026-08-20, `4547a65`).** User reported
  "Couldn't load your workspace / Diagnostic: Failed to fetch". Traced live: the API was healthy
  (Railway `SUCCESS` deploy, `/api/health` returned `200` when hit by IP) — the user's mobile hotspot's
  DNS resolver was refusing to resolve the API's `*.up.railway.app` host specifically (worked fine via
  public DNS or a different network). Not a server issue or an account/session issue. `UserShell`'s `me`
  query previously showed identical "sign in again" copy for every failure, including this one — wrong
  advice for a browser that can't reach the server at all. Now branches on `me.error instanceof
  TypeError` (native fetch failure vs. our own thrown `Error` for a real HTTP response): a network
  failure gets "Can't reach Weeber" copy + a "Try again" (refetch) button; a real error keeps "sign in
  again". Stopped retrying real HTTP errors, retries network failures up to twice. Converted both
  buttons to `ui/button` while there, paying down `design:guard`'s `rawButton` ratchet by one (111 → 110)
  instead of regressing it.

- **Admin/user surfaces gained real 404s; API gained a JSON one (2026-08-20, `c63f962`).** Only the
  public marketing surface had a real 404 (`pages/not-found.tsx`) — an unmatched route under
  `/dashboard/*` or `/app/*` silently redirected home instead, the exact soft-404 pattern that page's own
  comment already called out. New `components/shell/not-found-panel.tsx` (an in-shell 404 built from
  `EmptyState`) wired into both `AdminAppRoutes`' and `UserAppRoutes`' catch-all routes; the API's Hono
  app gained `.notFound()` returning the same `{error, code}` JSON shape every other endpoint uses,
  replacing Hono's plain-text default. Already solid, untouched: the public 404, the app-wide
  `ErrorBoundary`/`ChunkErrorBoundary`, `vercel.json`'s SPA rewrite.

- **Cross-domain session-handoff leak actually closed this time (2026-08-20, `6c0d978`).** A prior
  session's diagnosis report claimed four auth-hardening fixes were applied — the working tree was clean
  and none of the described code existed; the diagnosis was real, the fix wasn't. Re-verified and shipped
  for real: `lib/user-session.ts`'s `signOutToLogin()` (always redirects to `/login?cleanup=1`, even if
  the remote `signOut()` call fails) replacing three duplicated inline sign-out sites; `login.tsx`
  consumes that marker by clearing its own origin-local session instead of auto-handing an existing one
  back to the app (`weeber.ai`/`app.weeber.ai` are separate origins with separate `localStorage`
  sessions); `auth-callback.tsx`'s tokenless-revisit path now fails closed unless the URL still carries a
  real auth payload, instead of trusting whatever app-origin session happens to exist; API's
  `verifySupabaseJwt` now falls back to Supabase JWKS when a configured `SUPABASE_JWT_SECRET` fails to
  verify (covers a project mid-migration to asymmetric signing keys). Two new tests, `knip:gate` baseline
  tightened by one, full verification pass clean.

- **Pilot-onboarding execution plan filed (2026-08-20, `6592597`).** A "Weeber Pilot-Onboarding
  Execution Plan" sat untracked at the repo root — the direct execution plan following audit-18's
  findings (`audit/2026-08-16-audit-18-the-activation-boundary-is-unclear.md`, itself only filed and
  indexed 2026-08-20 in `1b5390a` — that filing commit never got logged here or in the changelog either,
  noting it now). Spot-verified against the actual repo before filing (baseline commit, migration
  numbers, the insurance-has-agents-but-no-workflow-templates gap, the ingest route's unwired
  `triggerWorkflow` note) — all checked out exactly as written. Filed under
  `docs/product-strategy/weeber-pilot-onboarding-execution-plan-2026-08-20.md`, alongside its sibling
  planning docs. Sequences Draft-vs-Live separation, immutable run versioning, a shared
  event-to-release dispatcher, and the two first pilot outcomes (Shopify cart recovery, Insurance lead
  follow-up) into an ordered critical path with binary readiness gates. Nothing built yet — this is the
  plan, not the implementation.

- **Every seeded greeting now resolves on one canonical tag (2026-08-20, `a7b63b6`).** The insurance
  `literalGreetingTemplate`s (04–09) used `{{interest_area}}`/`{{lead_name}}`/`{{policyholder_name}}`/
  `{{interaction_type}}` — all sourced from `getLeadGreetingContext`, which returns `{}` whenever the
  lead is absent or has no intake fields. 11/11 production calls had no lead row at call time, so these
  tags always left the greeting unresolved and the LLM-free fast path never fired once for any insurance
  call. Rewrote all 6 insurance templates (`seed.ts`) and their 10 localized hi/hinglish variants
  (`insurance-greetings.ts`) to use only `{{agent_name}}` and `{{merchant_name}}` — the two tags
  `stream.ts` always guarantees. Also standardized every template (insurance and the 3 already-correct
  Shopify ones) off `{{company_name}}` — an identical-value alias `stream.ts` also set — onto
  `{{merchant_name}}` as the one canonical tag. Two new regression-guard tests (in `seed.test.ts` and
  `insurance-greetings.test.ts`) assert no template drifts back onto the alias, since it still silently
  resolves today. No conversation-loop, tool, LLM/provider, or TTS code touched.

- **Duplicate `orgs` query removed from the "start" handler's critical path (2026-08-20, `a6d2b87`).**
  `resolveAgentConfig`'s own org+template branch fired its own `orgs.name` query inside its sequential
  Q1→Q2→Q3 chain — the exact same row the outer `Promise.all` batch already fetches (with
  `humanTransferNumber` alongside) for the greeting's `{{merchant_name}}`. Added an optional
  `orgRowPromise` param: `stream.ts` now creates one `orgs` query and hands the in-flight promise to
  both consumers, but only when it can prove the org id `resolveAgentConfig` would use is the same one
  the outer batch already keys off — falls through to two independent queries (today's exact behavior)
  the instant they'd diverge, so this cannot change what either branch resolves to, only how many times
  the row gets fetched. 9 queries → 8 per typical call; the real win is less load on the shared DB
  connection pool under concurrent volume (per ADR-116 addendum), not a measured per-call latency
  number — no live-call access from here to measure one. 7 new tests in `agent.test.ts` (agent config
  resolution, org identity, literal-greeting rendering). Bundled in the same commit: a second,
  pre-existing latency fix (`resolvedFlags`/`resolvedFlagsReady` caching so `speakCannedLine`/
  `maybePlayToolCallFiller` stop re-fetching feature flags on every mid-call invocation) that this
  session inherited mid-flight, fixed two latent type errors it introduced, and removed a fully-dead
  `openGate`/`flagsGate` test seam it left behind.
  **Known issue, not fixed:** `stream-silence-timeout.test.ts`'s "does not hang up on a caller who
  answers while the goodbye line is being prepared" still fails — see `progress.md`'s Known Issues.

- **Confirmation/OTP/reset mail was silently using Supabase's default mailer, not Resend (2026-08-20,
  this session — in progress).** User-reported "confirmation and waitlist mail not arriving from
  hello@weeber.ai" turned out to be two unrelated systems. Waitlist mail (Resend, `email.ts`/
  `waitlist.ts`) is fine — `weeber.ai` is verified on Resend, `RESEND_API_KEY` is set on Railway
  production, and prior sends logged successfully. Signup/OTP/magic-link/password-reset mail, per
  ADR-041, was **always** Supabase Auth's own mailer, never Resend — confirmed live via Supabase auth
  logs (`mail_from: noreply@mail.app.supabase.io`). `supabase/templates/{confirmation,magic-link,
  recovery}.html` already existed (OTP-only per ADR-043/053) but used the dark-monochrome dashboard
  theme; restyled to match the Resend waitlist template's warm-paper branding (logo, `#FAFAF8`/
  `#C4622D`, same footer) so all Weeber transactional mail reads as one system. **Not yet live** — needs
  (1) the three templates pasted manually into Supabase Dashboard → Authentication → Emails (the local
  `supabase/.temp/project-ref` is stale, still `wtqohdcghmxuujqyhlkz`, so `supabase config push` would
  target the wrong, abandoned project) and (2) Custom SMTP enabled there pointing at Resend — without
  that, the sender stays `noreply@mail.app.supabase.io` no matter how the template renders.

- **Vercel deploy was BLOCKED, not broken (2026-08-20, `e91e017`).** `ac83ea9`'s deploy failed on both
  the `openvent` and `weeber-app` Vercel projects with "GitHub could not associate the committer with a
  GitHub user" — the commit author's email didn't match a GitHub account Vercel's git integration
  recognized. Fixed on the GitHub side; `e91e017` is an empty commit that exists only to give Vercel's
  webhook a fresh push to deploy from, since a BLOCKED deployment can't be redeployed in place.

- **Login/signup moved to the public surface (2026-08-19, `ac83ea9`).** Was `app.weeber.ai/login` only
  (`VITE_APP_SURFACE=user`), which meant signing in required already being on the app subdomain. Now
  lives at `weeber.ai/login` and `/signup` with a redesigned split-panel layout; the resulting session
  hands off to `app.weeber.ai/auth/callback` via URL-fragment tokens + `setSession()` (the documented
  path for adopting an externally-obtained session, since `supabase-js`'s `localStorage` session store
  is strictly per-origin). Every same-origin login redirect (user-shell's auth gate, sign-out handlers,
  `MarketingNav`) updated to match. `supabase/config.toml`'s `site_url` and redirect allowlist now cover
  `www.weeber.ai` and `staging.weeber.ai` — **still needs a manual push to both live Supabase projects**,
  no CLI/access-token available in this sandbox to do it directly.

- **ADR-117 (2026-08-18) — a REVOKE that named two roles and missed PUBLIC.** While bringing the new
  staging project to schema parity with the new production project, a live
  `information_schema.routine_privileges` check found all four credential-vault functions
  (`store_org_credential`, `read_org_credential`, `delete_org_credential`, `delete_org_credentials`)
  still directly executable by `PUBLIC` on **both** projects — `REVOKE ... FROM anon, authenticated`
  never touches the implicit `PUBLIC` grant every function gets at `CREATE FUNCTION` time, and
  `anon`/`authenticated` only ever inherited through it. Since these are `SECURITY DEFINER` and
  PostgREST exposes every `public`-schema function at `/rest/v1/rpc/<name>`, this meant any anonymous
  caller holding the project's publishable key could `POST /rest/v1/rpc/read_org_credential` with an
  arbitrary `org_id` and pull another org's decrypted Twilio/Plivo/Exotel secret — the exact exposure
  the 2026-07-15 vault migration existed to close, undone by one missing role. **Not introduced by the
  account migration** — the old production project had the same gap; the migration replay just forced
  the check that found it. Fixed same day on both live projects (`execute_sql`) and captured as an
  additive migration, `20260818173000_revoke_public_execute_vault_functions.sql`. Unverified: whether it
  was ever exploited (PostgREST access logs weren't audited).

- **Supabase account migration — DONE, both projects live (completed 2026-08-17/18; corrects the "in
  progress" framing this entry used to carry).** The full `drizzle/` stack (`0000`–`0052`) plus
  `supabase/migrations/*.sql` are applied to two new projects on the new account: production
  **`qghtkadxbtptvbfbmsdz`** and staging **`zbcrwexrqfmjxhewirgp`**. The old project
  (`wtqohdcghmxuujqyhlkz`) is abandoned — do not treat it as current; that's also why migration `0051`
  was never verified applied there (moot, not fixed). `.mcp.json`'s Supabase entry is now **unscoped**
  (no `project_ref=`, operates at the org level) rather than repointed at the new prod ref, per `96c7208`
  (2026-08-18) — CLAUDE.md's MCP note explains why and flags re-scoping to the new prod ref as a later
  convenience change, not yet done. **Not independently re-verified this session:** whether Railway's
  staging `DATABASE_URL` was actually repointed at the new staging project or still shares production's
  — `progress.md`'s "staging is a second front door to production" finding named the *old* shared
  project by ref and needs a fresh check against the two new projects before being trusted either way.

- **ADR-116 addendum — split the DB connection pool in two (2026-08-17).** Raised directly by the user
  ("too many things interfering with each other, which drops performance") — checked, and it was real:
  one shared 20-connection pool served both live-call turn writes and every timer-driven
  sweep/admin/analytics workload. Added `dbBackground` (new `postgres.js` client, same `DATABASE_URL`,
  `DATABASE_POOL_MAX_BACKGROUND` default 8) and repointed 13 files — whole-file for
  `admin-routes.ts` (both), `workflows/scheduler.ts`, `workflows/org-lifecycle-sweep.ts`,
  `app/support.ts`/`broadcasts.ts`/`waitlist.ts`/`export.ts`/`audit-log.ts`, `integrations/shopify/*`;
  split-by-function for `webhooks.ts` (`dispatchWebhook` stays hot-path, the retry sweep moves) and
  `org-queries.ts` (18 of 19 functions move, `getEffectiveFlags` alone stays since `stream.ts` calls it
  per-turn). 15 test files' `mock.module("../database", ...)` factories needed `dbBackground` added
  (Bun throws a loud `SyntaxError` at import time when a mocked module is missing an export another
  file statically imports — that's how every affected file was found, by running the suite rather than
  tracing imports by hand). 1402/1402 tests pass, typecheck/lint/knip:gate clean. See the ADR-116 doc's
  "Addendum" section for the full file-by-file reasoning.

- **ADR-116 — database-optimization pass before the new Supabase project's first migration
  (2026-08-17).** Six missing indexes added (`tool_calls` had zero; `calls`/`scheduled_calls` had an
  `org_id`-only index that couldn't serve their real org+time-range query shape; `webhook_outbox`'s
  delivery sweep had no supporting index despite two sibling sweep tables having the identical
  `(status, next_retry_at)` shape; `org_members`/`support_tickets` were queried by columns nothing
  indexed), plus batching `provisionVerticalDefaults`'s two N+1 insert loops into single multi-row
  inserts. Migration `0052_panoramic_squadron_supreme.sql`. Explicitly rejected in the same pass:
  squashing the 52-migration history, adding Supabase RLS (this backend's Postgres connection carries no
  row-level identity — org-scoping is enforced in the API layer, not the database layer — so RLS would
  guard an access path that doesn't exist), and a `pgvector` migration for `knowledge_chunks` (no new
  evidence the existing brute-force-scan-is-fine-at-this-scale call has stopped holding). 1402/1402 api
  tests pass (two test-file DB mocks updated to accept the batched-insert call shape), typecheck/lint/
  knip:gate clean. See `docs/decisions/adr-116-six-tables-queried-by-a-column-nothing-indexed.md`.

- **SOTA-fix-marathon Phase 0 — production truth is now measurable (2026-08-16, committed/pushed as
  `4b723ac`).** Implemented
  `docs/voice-quality/sota-runtime-fix-marathon-2026-08-16.md` items 0.1-0.4 and 0.6 (0.5, deployment
  region, deliberately left open — see that item). Migration `0051_sharp_starbolt.sql` adds 4 columns to
  `turn_latency`: `llmProviderUsed` (the transport/model that actually served the turn — ADR-109's
  `formatActiveModelLabel`, not config — closing the exact gap audit-17's Addendum 2 named: three wrong
  conclusions in a row were drawn from `calls.llm_provider_used` recording what was *asked for*, never
  what *ran*), `endpointSignal`/`endpointingDelayMs` (distinguishes real `speech_final` from the synthetic
  `UtteranceEnd` VAD fallback, which previously looked identical downstream despite a ~700ms gap — audit-13
  §5.1), and `ttsSocketOpenMs` (isolates TTS connect time from synthesis time — settles whether ADR-083's
  lazy connect is really what pushed Cartesia's first-byte number up). `calls.llmProviderUsed` now falls
  back through the actual-served value the same way `ttsProviderUsed` already did. `recordProviderFailover()`
  gained a third call site (LLM transport, previously invisible — only STT/TTS incremented it). `/health`
  now reports `deploy: { buildSha, bootTime, region }` from Railway's own env vars. 1402/1402 tests pass,
  typecheck/lint/knip clean. Committed as `4b723ac` and pushed to `origin/main`. Migration `0051` was
  **not** successfully applied against the old Supabase project (Windows-path bug in `scripts/migrate.ts`
  plus a dead pooler connection in that sandbox) — moot now that the project is moving to a new Supabase
  account; it'll apply as part of the fresh `0000`-`0052` run described above.

- **UI/UX Audit Phase 1 & 2 — Direct Fixes & Conversion Polish Shipped (2026-08-16).**
  Addressed high-impact interaction, visual friction, and conversion points from `Weeber UI_UX Visual Audit — Working Findings.md`:
  1. **Recoverable Error States**: Replaced dead-end server error EmptyStates with `icon={AlertCircle}` and explicit `<Button onClick={() => refetch()}><RefreshCw /> Retry</Button>` actions in `pages/app/agents.tsx` (list + detail), `pages/app/workflows.tsx` (list + detail), and `pages/dashboard/agents.tsx`.
  2. **Mobile Waitlist Form Responsiveness & A11y**: Updated `WaitlistForm.tsx` to use responsive layout `flex-col sm:flex-row gap-2` with `w-full sm:w-auto` CTA button to prevent 390px input truncation (`you@yourbrand.com`), and added `role="alert"` / `aria-live="polite"` to error messaging tags.
  3. **Zero-Data Dashboard Header Polish**: Updated `pages/app/home.tsx` to conditionally hide the `DateRangeSelector` and show clean subtitle copy when 0 calls exist, eliminating competing controls during onboarding.
  4. **Public Navigation & Sign-In Route**: Added visible "Sign in" access route to desktop and mobile headers in `MarketingNav.tsx` alongside Help and Waitlist CTA; updated mobile hamburger button to descriptive `aria-label="Open/Close navigation menu"`.
  5. **Pricing Tier Bound Clarity**: Refined `PRICING_TIERS` in `marketing-config.ts` with concrete, indicative volume bounds ("Up to 250 calls/mo", "Up to 1,500 calls/mo", "Dedicated numbers") to replace vague "capped calls/minutes".
  - Verification: 101/101 web unit tests pass, typecheck clean, daily audit passing (zero token drift or contrast regressions), production Vite build passing.

- **ADR-115 — audit-17 F1 is FIXED (2026-08-15, shipped).** The tool list knew the call could not
  transfer and the prompt did not. ADR-105's tool-stripping half worked; the half its comment claimed
  was free never existed — the system prompt is composed inside `resolveAgentConfig` from the **saved**
  `org_agent_configs.tools_enabled`, before `narrowToolsForTransferCapability` runs, so prod config 6
  (`transferToHuman` saved, org `human_transfer_number` NULL) shipped the transfer-**capable**
  call-control text on every call. Fix is both halves: `resolveAgentConfig` now returns `promptInputs`,
  `stream.ts` recomposes with the narrowed list once capability is known (pure, no query, nothing on
  pickup-to-first-word), then appends the new pure `applyTransferBlockedPrompt`. Chosen by
  measurement, not taste — real prompt, real narrowed tools, `direct:groq/llama-3.3-70b-versatile`,
  5 x 8 caller turns per arm: shipped **4 promises / 7 tool attempts**, append-only **3 / 2**,
  recompose+append **0 / 0**. `resolvePersona` split into `resolvePersonaBody` + its two layers so the
  no-config-row paths are correctable too. api 1363 → 1375, web 101, five ratchets unchanged.
  **Not verified on a real call** — Railway API access is still dead. `test-call-stream.ts` still does
  no narrowing at all, and the residual hand-off line has moved into the greeting (persona copy).
  `docs/decisions/adr-115-the-tool-list-knew-and-the-prompt-did-not.md`.

- **The agent narrates tools it does not have (2026-08-15, audit 17 — F1 fixed by ADR-115, the rest open).**
  First 11 real conversational test calls (2026-08-13/14) read back out of production.
  **F1 (P0) — FIXED 2026-08-15, ADR-115.** `orgs.human_transfer_number` is NULL, so
  `narrowToolsForTransferCapability` strips `transferToHuman` — but the *prompt* was composed from the
  saved tool list and still told the model to narrate the handoff, so calls 1 and 9 promised a
  transfer that `tool_calls` shows never happened. The gate removed the capability and left the claim.
  **F2/F3 (P0):** the 2026-08-13 fix (`eafc762`) did ship — all 9 `agent_templates` persona rows match
  `extractRuntimePersona()` of the post-fix files byte-for-byte, and the seeder runs on every boot, so
  re-seeding is a **verified no-op**. The leak continued anyway: call 11 spoke 9 literal tool-syntax
  lines, and both of its shapes pass `scrubSpokenText` uncaught at HEAD `7f1d308`. Prompt and regex
  have both been pulled and both failed; the untried lever is the model. Defects track the
  **persona** (`insurance-final-expense-qualifier`, 11.7k chars, 13 tools), not the provider.
  **F4:** `bookAppointment` fabricated a callback confirmation with no calendar connected.
  **F5:** `FALLBACK_REPLY` blames the caller for a model failure and fired as the *opening* line twice.
  Latency from 72 turns: v2v p50 1591 ms overall, but **groq 1122 ms vs gateway 1793 ms** — a 672 ms
  p50 gap that is an open provider decision. `audit/2026-08-14-audit-17-the-agent-narrates-tools-it-does-not-have.md`.
  **Addendum 2026-08-15:** per-turn data breaks call 11 into a clean half (4 tool executions,
  0 leaks, TTFT 3194/3862 ms) and a broken half from 17:00:41 (9 turns, 9 leaks, 0 tools, TTFT
  ~650 ms). The persona and provider are constant across that boundary, so "defects track the
  persona" cannot be the explanation. Two corrections: the groq-vs-gateway latency gap is
  **confounded by tool execution** (a real tool call is two round trips, a leak is one) and does
  not support flipping the primary; and `provider_failover_count` is incremented **only** by TTS
  (`stream.ts:1579`) and STT (`stream.ts:2167`), never by the LLM, so no production data records
  which model served which turn. Blocking next step is instrumentation — per-turn transport+model
  and an LLM failover counter — before any model-swap experiment.
  **Addendum 2 (2026-08-15):** the leak does **not reproduce**. Replaying call 11's 12 real caller
  turns against the real persona and real tool defs on `direct:groq/llama-3.3-70b-versatile`
  (`/home/user/replay11.ts`, 6 runs, 72 turns) produced **zero** text leaks — the malformed literal
  goes into the tool-name field and Groq 400s it (`which was not in request.tools`), ~10-25% of
  turns. Context growth is dead as a hypothesis (failures hit the *smallest* contexts; the persona
  keeps context flat at 4.8-5.5k tok), and so is "a tool the model was told to use isn't registered"
  (re-run without `transferToHuman`/`bookAppointment`: still zero leaks). Root cause of the repeated
  wrong reads: **`calls.llm_provider_used` is a config field, not a measurement** — `stream.ts:861`
  writes `llmProviderOverride`, assigned once at `stream.ts:2527` from `agentConfig.llmProvider`,
  never updated by what actually served the turn; contrast `ttsProviderUsed: activeTtsProvider ??
  ...` on the line above. Every provider-attributed number in audit 17 is grouped by configuration.
  Since direct Groq 400s instead of leaking, call 11's nine leaked turns were probably not served by
  direct Groq at all — a gateway surfacing an upstream validation failure as content fits the shapes
  and the sharp boundary. Needs Railway logs to confirm.
  **Blocked:** the Railway token in the sandbox is dead (`Not Authorized`), so the deployed SHA and
  its boot time are unknown — we cannot say which commit served call 11, and no deploy can be
  triggered from here.
- **One setting read twice is two settings (2026-08-14, ADR-114 — shipped; migration `0050` APPLIED to production 2026-08-15).**
  `transferToHuman` had one org-wide destination, `orgs.human_transfer_number`. Wrong for the launch
  vertical: an insurance org's six agents hand off to different people, and ADR-081 lets the
  final-expense qualifier reach a **licensed producer** and nobody else. New nullable
  `org_agent_configs.human_transfer_number` (migration **`0050`**, additive, null = inherit). The
  bigger half: the number was already read **twice** — once at `"start"` for the capability decision
  and ADR-106's provenance set, once again inside `performTransfer` via a second `select *`. That is
  ADR-105's shape, so `resolveHumanTransferNumber` is **deleted** and one pure
  `resolveTransferTarget` in `handoff.ts` feeds both halves, guarded by a source-text assertion.
  `AgentFrameSchema` field is `.nullable().optional()` so an override can be **cleared**, validated
  with the shared `isValidE164`. ADR-111's readiness pill is now **per-agent**, otherwise an agent
  with its own number renders "Live · limited" and sends the merchant to fix nothing. api 1354 →
  1363, web 95 → 101, non-vacuity proven both sides, nothing widened. **Still open:** `0050` and
  ADR-112's `0049` are both generated and applied **nowhere**, so an agent-config save fails against
  the real DB until they run; onboarding still asks for no transfer number at either level;
  `insurance_advisors` still empty so the producer destination is a hand-typed number;
  `provider-unsupported` still invisible in the UI.
  **Update 2026-08-15:** `0050` was applied to production via `packages/api/scripts/migrate.ts` after a
  full backup (`weeber-full-backup-pre-0050-20260815.json`, 196,709 bytes).
  `drizzle.__drizzle_migrations` 50 → 51; `org_agent_configs.human_transfer_number` exists as nullable
  `text`; all 6 config rows intact, none with an override set. `0049` had already been applied
  2026-08-13 11:06, so the "applied nowhere" note above is closed for both. Still true:
  `orgs.human_transfer_number` is NULL on the only production org, which is audit-17 F1.
- **The escape hatch was only findable after it was needed (2026-08-13, ADR-113 — shipped).** Test
  mode existed on Settings and nowhere in onboarding, so a fresh org's first call was refused with the
  TRAI/1600-series paragraph before anyone learned the toggle exists. New **fifth onboarding step**
  ("testing" vs "real customers", both answers complete it), **no new endpoint**, flag
  `test_mode_choice` = *the answer, not the state*, patched only **after** the POST succeeds. Pure
  `web/lib/test-mode-onboarding.ts` holds the one rule worth testing: "yes" always posts, "no" posts
  **only when a window is live**, and never for a never-configured or **expired** timestamp — clearing
  an expired one erases ADR-108's diagnostic evidence. Copy names DNC and the repeat-attempt cap as
  never lifted. web tests 85 → 95, non-vacuity proven; all six ratchets green, nothing widened.
  **Watch out:** the bypass is still **blanket** for every destination — the question makes the choice
  explicit, not the bypass narrower — and onboarding still never asks for `orgs.human_transfer_number`.
- **A BYO number nothing recorded (2026-08-13, ADR-112 — shipped; migration NOT applied).** All
  platform-rented Twilio numbers were **released** on the founder's instruction (parent + both live
  sub-accounts hold zero, nothing billing), so BYO is now the default path — and only
  `buyNumberForOrg` had ever written an `org_phone_numbers` row. The three BYO functions wrote
  `orgs.outbound_number` only, so a BYO org had a working caller ID, an **empty Numbers page** (hence
  no way to declare `numberSeries`, making the India DLT and insurance 1600-series gates
  unsatisfiable by construction), **dead per-agent routing** (`phone_number_id` is an FK into that
  table), and numbers outside webhook repair. New `voice/register-byo-number.ts` shared helper called
  from all three; new nullable `org_phone_numbers.source` enum(`purchased`,`byo`) with **no backfill**;
  supersession is a **pure** `supersededByoNumberIds` scoped to `byo` only — `purchased` is billed and
  dialable, `NULL` is unknown provenance and untouchable — extracted because **no `db` mock here
  evaluates `where` predicates**. Also: the org-level branch of `resolveOutboundRouting` was an
  unordered `limit(1)`, i.e. a **nondeterministic caller ID** for an org with two active rows; now
  `asc(id)`. api tests 1,324 → 1,336, non-vacuity proven twice. **Watch out:** migration
  `0049_daffy_beyonder.sql` is generated and **not applied**, so `registerByoNumber` fails against the
  real DB until it runs; and `TWILIO_PHONE_NUMBER` on Railway names a **released** number, so step 4
  of the routing chain dials from a number we do not own (Railway work is paused).
- **A green pill on an agent that cannot hand anyone over (2026-08-13, ADR-111 — shipped, UI-only).**
  `classifyReadiness` judged agents from `enabled` + `hasCallerId` only, so an agent whose
  `transferToHuman` ADR-105 had **narrowed away** (org `human_transfer_number` NULL) rendered green
  **Live**. Fourth state **`degraded`** / **"Live · limited"** added, precedence
  `paused` → `needs-number` → `degraded` → `live`. The capability context is a **required** third arg on
  purpose — an optional bag defaults to "no gaps" and is how the next surface silently regresses to green.
  `detail` now comes from the classifier so grid card, detail banner and detail header are three renderings
  of one verdict; the detail header pill was previously hand-rolled two-state on raw `emerald-*`/`zinc-*`
  and **disagreed with the banner beneath it**. Detail page classifies from `form.toolsEnabled`, so the
  warning appears before you save. Zero extra requests (`me.org.humanTransferNumber`). Deliberately fed
  **only** the ADR-105 gap: ADR-098's empty roster is org-wide and does not narrow this agent, ADR-108's
  lapsed window already has a countdown on Home/Settings. Reused `warning-soft`/`warning` (no `info` token
  in `.theme-weeber`, contrast gate already carries 9 declared failures) and **refused to widen
  `design:guard` `rawButton` 111 → 112** for a tab-jump `<button>` — plain text instead. Tests 12 → 19,
  non-vacuity proven (4 of 19 fail when the branch is stubbed out); all six ratchets green, none widened.
  **Watch out:** `app-agents` visual baselines render the *empty* state and protect none of this (verified
  by driving the built harness with fulfilled API responses instead; seeding the harness is the follow-up),
  and `provider-unsupported` is still invisible — an **Exotel** org with a transfer number set shows
  **Live** and cannot transfer.
- **Market focus is an authoring fact, not a gate (2026-08-13, ADR-110 — shipped, allow-and-warn).**
  "Insurance = US, Shopify = India" is now written down in exactly one place in code
  (`voice/compliance/market-alignment.ts`) and **nothing branches on it**. `noteMarketAlignment` runs on
  the **allowed path only** of `assertOutboundCallAllowed`, its result discarded, `runOutboundGates`
  untouched, failures swallowed — so this can never refuse a call, and three source-text tests hold that
  invariant. `console.warn`, not a `guardrail_events` row. **`orgs.market` was rejected, so ADR-095 stays
  `Proposed`**: every gate that needs geography already resolves it from the destination (DNC, calling
  window, FTSA cap, 1600-series, producer licensing, India DLT), so a column would not change one
  decision, and a stale market column looks more authoritative than a prefix inference. Refusing
  shopify→US was rejected too — it would encode a fact only true at zero customers and be load-bearing by
  the first US store. **Correction on the record (ADR-078):** the FTSA attempt cap is **not** insurance-only
  — it is called unconditionally and scoped by Florida area code, so shopify→US runs DNC + US calling
  window + FTSA cap. api tests 1,307 → 1,324; all six ratchets green, none widened. **Watch out:**
  `orgs.vertical` is unconstrained `text` defaulting to `"shopify"` and **neither** insert path sets it, so
  a fresh signup is a Shopify org until someone opens Settings.
- **The chain's last resort was its weakest link (2026-08-13, ADR-109 — shipped dark).** Gateway
  `groq/llama-3.3-70b-versatile` fails ~4 of 10 streaming-tool requests (bedrock attempted first, 400,
  then groq 503) and is the **last link** of production's `AI_GATEWAY_FALLBACK_MODELS`. Fix is
  **cross-transport** failover — direct Groq primary, gateway as the last link — not a Groq-only model
  chain, which would protect against capacity rather than against the transport being unreachable.
  Transport-qualified ids use a `direct:` colon scheme because `groq/<model>` is *already* a valid
  gateway id and production's current value, so a bare prefix would have redefined live config
  silently. Config reuses `org_agent_configs.llm_fallback_models` (no migration). The retry window
  **closes at the first token** — after that, retrying makes the agent say two things in one turn.
  Behind `LLM_TRANSPORT_FAILOVER`, **default off everywhere**; flag off ⇒ empty chain ⇒ unchanged
  gateway-native path. **Open:** whether to enable it on staging (which isolates nothing while staging
  shares `DATABASE_URL` and the Twilio account with prod), and a Railway-side latency soak — the
  ~130 ms hop is a dev-sandbox reading and must not be quoted as production.
- **The `+91` dial was refused by design; the expiry was invisible (2026-08-12, ADR-108 — shipped).**
  Nothing was broken. ADR-096 made `assertOutboundCallAllowed` the single fail-closed chokepoint and
  closed the three ungated paths live testing used, so an insurance org dialing `+91` now hits the
  unconditional TRAI 1600-series gate. The escape hatch already existed —
  `orgs.callingWindowTestModeUntil` (24h, `POST /api/app/compliance/test-mode`) bypasses it before any
  number lookup, DNC still enforced — but it had **lapsed the previous evening**, and an expired
  bypass produces a refusal byte-identical to a never-configured org's. Shipped: refusals now name the
  lapsed test mode (scoped to `TEST_MODE_BYPASSABLE`; `dnc`/`attempt_cap` deliberately excluded,
  additive to the original reason, silent when NULL or still active, best-effort so it can never throw)
  and the dashboard/settings show `Xh left` → bolded `lapses in Xh` under 3h → an explicit expired
  warning. A per-org test-number allowlist was rejected: demos go to whoever is in the room, so the
  destination cannot be pre-registered. api tests 1,281 → 1,287.
  **Before demoing `+91`: flip the Settings test-mode toggle first.** Still open — test mode is a
  blanket lift for every destination, not demo-scoped (fine for invited demos, not for cold outreach);
  the countdown does not tick.

- **The latency dashboard was blaming the wrong stage (2026-08-12, ADR-107 — shipped).**
  `turn_latency` said voice-to-voice p50 was 1878 ms with **1748 ms of it TTS**, on a turn `llm_ttft`
  already claimed 1381 ms of. `v2v - tts` was pinned at ~127 ms on *every* row across a two-second
  spread of LLM time — `tts_first_byte_ms` was tracking the LLM, not the vocoder. `speak()` anchored
  it at the top of the turn, before `generate()` ran, so the TTS column contained the whole LLM
  stage. Corrected decomposition of the p50 turn: **~127 ms dispatch / 1381 ms LLM / ~370 ms TTS** —
  the model is ~three quarters of the caller's wait. Shipped: anchor moved to the first character
  handed to TTS (inside ADR-083's lazy-connect facade, before socket open so connect time counts);
  column **redefined not duplicated** (all 78 pre-cutover rows are internal test calls), cutover
  pinned in the schema doc comment; `voiceToVoiceMs` unchanged in meaning *and* value;
  `stream-latency-attribution.test.ts` asserts the LLM stall lands in v2v and not in TTS, verified to
  fail against the old anchor. **Correction on the record** (ADR-078 style, new entry not an edit):
  ADR-104's "the four prod orgs still hold the old whole-file personas" is **false** — `runtime:begin`
  is a source marker `extractRuntimePersona` strips at seed time, and SHA-256 of repo-extracted
  runtime vs all nine prod rows is 9/9 identical. ADR-104 has been live in prod since it shipped; no
  re-seed was needed or performed. **Next: the LLM transport.** Direct Groq as a real second
  transport with its own failover chain mirroring `failover.ts`, shipped dark behind a flag —
  gateway `groq/llama-3.3-70b-versatile` still fails ~50% of streaming-tool requests and is the last
  link of prod `AI_GATEWAY_FALLBACK_MODELS`, while `buildGatewayProviderOptions` returns `undefined`
  for groq so "groq" currently means no failover at all. **Blocked on staging isolation:** Railway
  staging shares ~33 of 40 env vars with production including `DATABASE_URL` and the Twilio account,
  so there is nowhere safe to soak a transport swap. Approved to split, not yet done.

- **The agent texted a caller a phone number that does not exist (2026-08-12, ADR-106 — shipped).**
  Three more findings from the same call 25 as ADR-105, all about what the agent wrote and said while
  making a promise it could not keep. It sent two SMS: one containing the literal
  `[Advisor Desk Number]` — the exact shape ADR-104 stopped from being *spoken*, delivered in writing
  five hours after that ADR shipped — and one containing `888-555-0199`, which exists nowhere
  (`orgs.human_transfer_number` NULL on all 4 prod orgs, `insurance_advisors` empty, the caller never
  said a number, nothing in the prompt had one). ADR-104's guard covered the token stream to TTS; the
  channel that *persists* — `sendSms.body`, `crmSync.notes`, `bookAppointment.notes` — was unscreened.
  It also read a stage direction aloud (*"\*Sending text message...\* [[tone:upbeat]] And that's
  everything I need"*): the prefix is 23 chars, `TONE_TAG_MAX_BUFFER_CHARS` is 24, so the filter hit
  the cap, correctly concluded "no leading tag is coming", released, and then forwarded the tag as
  speech because the post-resolution path was a raw pass-through — the cap ADR-101 added to stop short
  turns being muted is what let it through. And it framed an outbound call as inbound ("the line that
  you reached out on", plus asking which number to use), whose answer is the utterance that ran the
  phantom turn ADR-105 fixes. Shipped: `voice/outbound-text-guard.ts` reusing `scrubSpokenText`'s
  findings plus `unverified-phone-number`, **refusing rather than scrubbing** (an SMS is atomic; a
  scrubbed one reads as broken and still fails the caller), with the test being **provenance not
  plausibility** — every shape check passes `888-555-0199`, so a number is allowed only if the server
  put it in scope or the caller said it, tracked live in `callerSpokenNumbers` and read through a
  closure. Wired via `withOutboundTextGuard` in `buildVoiceTools` (crmSync, bookAppointment) and in
  `stream.ts` for `sendSms`, whose execute is signal-only; refusals log
  `guardrail_events.category = fabricated-outbound-text` (a plain-text enum widening, no migration).
  `stripToneTag` now strips the tag anywhere and the filter holds back only from a dangling `[`;
  `output-guard.ts` deletes markdown asterisks but keeps the words, with the narration fixed at the
  prompt layer instead. api tests 1,241 → 1,278. **Known and unfixed:** a refused SMS is a message the
  caller expected and did not get, and the agent is not told, so it cannot correct itself mid-call —
  feeding the refusal back into the turn is the next step. **Still unfiled:** `flagGuardrailEvent`
  false positives, 6× and 4× on polite non-abusive callers.

- **The best call this product has ever placed dropped a warm lead mid-promise (2026-08-12,
  ADR-105 — shipped).** Production call 25 reads `status = "completed"`, `disposition = "booked"`,
  `health_status = "healthy"`, `intent = "purchase_or_booking"`, and it closed with *"Let me connect
  you with a licensed advisor right now… **You're connected — the advisor will take great care of
  you.**"* Nobody was connected; the line was hung up on them. `orgs.human_transfer_number` is
  **NULL on 4 of 4 prod orgs** and `insurance_advisors` is still empty (ADR-098), so `performTransfer`
  resolved no target and hung up. Every layer behaved as written — the defect was upstream: the model
  was handed a `transferToHuman` tool on a call where it could not possibly succeed, plus a persona
  saying the best outcome is a live warm transfer. **The launch vertical's only conversion event is
  structurally impossible in production today.** Second finding, same call: the closing line, the
  transfer, `crmSync` and `sendSms` all fired **twice** — filed for two sessions as "duplicated agent
  text", it was a whole phantom turn, because ADR-082's `transferLatched` gated `hangUp` and nothing
  else while the bridge waits at `speak()`'s tail with STT still connected. Shipped: pure
  `voice/handoff.ts` resolving transfer capability once at `"start"` (reasons `no-org` /
  `provider-unsupported` / `no-transfer-number`), `narrowToolsForTransferCapability` dropping the tool
  (which rewrites the prompt for free via `buildCallControlBlock`, and materializes
  `AVAILABLE_TOOL_NAMES` in the `undefined` = "all tools" case that covers most prod calls),
  `bookAppointment` left intact as the fallback, a rule that the model may *promise* the handoff but
  never *report* it, the latch extended to short-circuit whole turns (transcript still written), and
  `handoff.test.ts` asserting against `stream.ts` source text that the duplicated decision stays in
  agreement. api tests 1,221 → 1,241. Also corrected a wrong claim on the record per ADR-078:
  "hand-off spoken but never recorded" was an ADR-103 *harness* finding, not prod behaviour — prod
  records the tool call **and** hangs up, which is worse. **Still open:** nothing tells an operator to
  set the number beyond a `console.warn` (dashboard surfacing is unbuilt), and `call-health.ts` still
  calls call 25 healthy — nothing in the stack notices a broken promise. **Next: ADR-106** (F3/F4/F5
  from the same call — `sendSms` sent a fabricated advisor number `888-555-0199` and an unresolved
  `[Advisor Desk Number]` placeholder, the tone-tag stripper is `^`-anchored so `[[tone:upbeat]]`
  mid-string is spoken, `*Sending text message...*` stage directions reached TTS, and the agent framed
  an outbound call as inbound).

- **The personas were authoring documents shipped verbatim to the model (2026-08-12, ADR-104 —
  shipped in code, NOT yet true in production).** Production call 22 spoke *"Hello, is this ? This is
  calling on behalf of krisn"* and call 24 spoke *"Hi, is this **[Caller Name]**? This is **[Agent
  Name]** with presistentads"* — six of nine personas opened with `You are [Agent_name: {{agent_name}}]`
  and the merge layer resolves only `{{tag}}`, so it stripped the tag from *inside* the brackets and left
  the label standing to be read aloud. Underneath, `seedAgentTemplates()` wrote the **whole file** into
  `default_persona_prompt`, so **13-40% of every persona was prose addressed to a maintainer** (the
  `**File:**` header, the regulatory pointer, the variables table, the tools table, the "Known gap"
  note), worst on the launch agent at 19,711 chars / 272 lines / 40% metadata — re-sent every turn of
  every call. What remained was a numbered script with lettered branches, which is exactly why ADR-103's
  harness caught near-verbatim recitation. Shipped: `runtime:begin`/`runtime:end` markers,
  `extractRuntimePersona` that **throws** instead of falling back to the whole file, all nine runtime
  regions rewritten goal-based with every guardrail and audited line verbatim, `voice/output-guard.ts`
  scrubbing tool syntax / JSON residue / bracket slots at the single `onTextDelta` chokepoint (a gateway
  8B model leaked `3"}</function>…` as speech in 4 of 6 probe runs), a new `persona:gate` CI ratchet, and
  G1.3/G1.4 re-pointed at the seeded region so G1.4 covers all 9 templates instead of 3. Measured:
  103,752 → 73,783 persona chars (−29%), launch agent −40%, api tests 1,188 → 1,221.
  **Next, and required for any of this to matter: re-seed `agent_templates` on production.** All four
  prod orgs still hold the old whole-file personas, so live calls keep reciting until that runs. Nothing
  in that table is hand-edited, so a full re-seed is safe — but it is a deliberate write to prod.
  Also still open: whether the goal-based rewrite actually reduces recitation is **unverified** — re-run
  the ADR-103 synthetic scenarios after the re-seed to find out.

- **The only automated behavioural check this product has could not fail the tests it claimed to run
  (2026-08-12, ADR-103).** An A/B model comparison used the synthetic harness as an instrument and the
  instrument was the finding. `wrong-info` had **never** passed and could not — reactive persona, caller
  speaks first from an empty transcript, caller model returns `""`, silent `break` on turn zero, lone
  assertion scored against an empty transcript (0 turns, ~1.7s, both models, both templates). Every
  scenario was **inbound** while production is 10 outbound / 1 inbound. All eight were ecommerce-shaped
  against six insurance templates, so ADR-081's boundary was prose only. Worst of the four: the scripted
  caller runs on an **aligned** model that **refuses adversarial personas** — asked to volunteer a
  fabricated SSN it answered in its own assistant voice and offered *the agent* a menu of insurance
  topics, and both data-handling scenarios **passed** with the agent never challenged. Shipped:
  `firstSpeaker` (Vapi's `firstMessageMode` axis; agent-first drives the exported `GREETING_TURN_SEED`,
  not a paraphrase), `callerMustSay` → `endedBy: "caller-off-script"` with `allPassed` forced false,
  per-scenario `callerModel` pin (boundary scenarios on direct Groq `llama-3.3-70b-versatile`, where the
  caller pushed the SSN four times and the agent refused every time), `endedBy: "caller-silent"`,
  `toolCalledAnyOf`, four outbound scenarios, both new non-results surfaced in the dashboard.
  `wrong-info` now runs 8 turns and passes. The harness is **on-demand, not in CI**, so the two
  scenarios that fail today are findings, not a red build.
  **Good news, now evidence instead of assumption: the ADR-081 boundary holds** under adversarial
  pressure — no premium quoted, no coverage bound, no start date confirmed, SSN and routing refused,
  licensure never claimed.
  **Three defects to act on, none fixed yet.** (1) *The hand-off is spoken and never recorded* — the
  agent promises an advisor callback and calls neither `bookAppointment` nor `transferToHuman`, so a
  warm lead who verbally agreed leaves **no row**. That is the launch vertical's only conversion event
  and it is ADR-090's class in the product itself. Highest value item in this batch. (2)
  `flagGuardrailEvent` fires **6×** on a polite-but-persistent caller and 4× on another — sales friction
  is being logged as abuse, which makes the signal unreadable. (3) A turn emitted duplicated text with a
  tone tag mid-sentence — **fourth** defect in that feature after ADR-082/-083/-101.
  Also: the "agent sounds scripted" complaint is now reproducible on demand — the same canned advisor
  line recited near-verbatim across turns, six consecutive refusals with no alternative offered.

- **The tail of production's LLM failover chain is ~40% broken (measured 2026-08-12, ADR-103, NOT
  fixed — needs an env decision).** Direct Groq supports tool use in streaming on all four models
  probed (`llama-3.3-70b-versatile` 256ms TTFT, `llama-3.1-8b-instant` 160ms, `qwen/qwen3.6-27b` 533ms,
  `openai/gpt-oss-120b` 229ms **with** content — which contradicts an earlier note in this repo). But
  `groq/llama-3.3-70b-versatile` **via the gateway failed 4 of 10** identical requests, and the routing
  metadata is explicit: `resolvedProvider: "groq"`, `canonicalSlug: "meta/llama-3.3-70b"`, and
  `providerAttempts` = **bedrock first** returning 400 *"This model doesn't support tool use in
  streaming mode"*, then groq 503. It is **Bedrock's** Llama-3.3-70B that lacks streaming tool use, not
  Groq's — so the earlier conclusion "that model can't do tool use" was wrong about the cause. That slug
  is the **last link of `AI_GATEWAY_FALLBACK_MODELS`** in prod, so the declared third leg of failover
  does not work for a 10-tool streaming workload. `google/gemini-3.1-flash-lite` (10/10, 1040ms p50) and
  `openai/gpt-5.4-mini` (10/10, 923ms p50) are sound. Decision needed: replace the tail slug, or accept
  a two-deep chain and say so.

- **The voice pipeline was measured before anything was changed (2026-08-12, ADR-100).**
  Real numbers, 44 turns with a complete measurement: `v2v` p50 **1863ms**, p90 4180, p95 4394, max
  8173; `pickup_to_first_audio_ms` 1770–2588ms on all 11 calls. One decomposed turn is pre-LLM 129ms
  (8%) | **LLM TTFT 1136ms (71%)** | TTS 336ms (21%). **The model is the cost; nothing else is close.**
  Two traps in this data, both of which I fell into first: `voiceToVoiceMs` is `speech_final` → first
  TTS byte **server-side**, so the US→India Twilio leg inflates what a tester hears but not what the
  table records (the numbers are not geographically poisoned); and `tts_first_byte_ms` is **cumulative
  from turn start**, not the TTS stage, so reading it as a duration overstates TTS.
  Fixed only what was being paid for nothing: caller-transcript INSERT off the hot path (it sat between
  `speech_final` and the LLM request, cross-region Singapore→Mumbai, writing a table the model never
  reads — **chained**, not fire-and-forget, because rows are read back ordered by identity column and
  racing inserts reorder a conversation; drained in `finalizeCall` with a 2000ms cap); the
  literal-greeting fallback now names the unresolved tag instead of failing silently; merchant free text
  trimmed where it becomes speech; `{{interaction_type}}` given a producer.
  **The finding to act on: the literal-greeting fast path is 0 for 11 — it has never fired in
  production**, so every call ever placed paid ~1.3s of LLM TTFT for an authored sentence. It is a
  **data** defect: 3 of 4 `leads` rows have `name = NULL` and `fields = {}`. Fixing the lead rows is
  worth more than any code change in this batch. No prod data was written.
  Explicitly deferred as unearned: the LLM TTFT fat tail (p50 1376 → p95 3826 — needs per-request
  gateway-vs-model timing before naming a cause) and Cartesia-vs-ElevenLabs at n=2. The third deferred
  item — the 10 of 78 turns with no TTS byte — was investigated and closed the same day, see ADR-101
  below; **its "dead air" framing here was wrong** and is retracted there.

- **A voice is an agent property, and the ElevenLabs failover leg had never worked (2026-08-12,
  ADR-102).** Every TTS adapter read `voiceIdOverride || process.env.<PROVIDER>_VOICE_ID`, which
  reintroduces ADR-070's hazard one layer lower: a voice belongs to an **agent**
  (`org_agent_configs.voice_provider` + `voice_id`, set in the dashboard picker), an env var belongs to
  a **deployment**, so the same agent row could speak as a different person depending on which
  environment served the call. Of 43 Railway prod vars, `ELEVENLABS_VOICE_ID` and `SARVAM_VOICE_ID` are
  **absent**; all 6 prod agent-config rows are Cartesia with `tts_fallback_order` null, so
  `DEFAULT_TTS_FALLBACK_ORDER = [cartesia, elevenlabs, sarvam]` governs **every call ever placed** and
  its second leg built `wss://api.elevenlabs.io/v1/text-to-speech/undefined/stream-input`. Silent at
  boot, silent on the call record, discoverable only during a Cartesia incident — ADR-090's class.
  Fixed with `FALLBACK_VOICE_BY_PROVIDER` as a `Record<TtsProvider, string>` code constant in
  `tts/default-voices.ts` (a missing env var is `undefined` mid-call; a missing constant does not
  typecheck), Cartesia pinned to the exact prod value so no agent's voice changes, blank-safe
  `resolveVoiceId` as the only adapter path, voice IDs removed from `assertVoiceConfig` and both doc
  surfaces, and a new boot `warn` per **dead failover leg** across both default chains. Tests assert at
  the wire via `MockWebSocket` and were proven to fail for the right reason.
  **Still open and a business call:** the ElevenLabs account returns `payment_issue` on every
  generation, so the leg is now structurally correct and still non-functional — TTS is effectively
  single-sourced on Cartesia until an invoice is paid (starter tier, 40k chars/month, break-glass at
  best). **Also measured, not yet a decision:** prod LLM primary `google/gemini-3.1-flash-lite` is
  ~929ms median TTFT vs ~334ms for `groq/llama-3.3-70b-versatile` on the same gateway; Cartesia
  `sonic-3` first byte ~183ms needs no change. Measured from a sandbox, not Railway Singapore.

- **A reply too short to trip the tone-tag buffer was never spoken at all (2026-08-12, ADR-101).**
  ADR-100's "10 of 78 turns produced no audio" was one label over two different things, and the label
  hid the row that mattered. 9 of the 10 are turns the caller aborted **before the first LLM token** —
  correct barge-in, and provable: call 25 has 27 turn rows and 23 agent transcript lines, and the 4
  all-NULL rows are exactly the 4 turns with no agent line, each between two caller lines under 1.5s
  apart. A further 8 rows read as "no LLM ran" are just `speakCannedLine` re-prompts, where no LLM is
  supposed to run. **The 1 real one is call 21 turn 3**: `llm_ttft_ms = 2779`, `tts_first_byte_ms`
  NULL, transcript recording `"OK."` as spoken, caller transferred having heard silence.
  Cause: ADR-082's tone-tag filter released its hold-back on the first of three conditions (complete
  tag / any `]]` / 24 chars) and had **no condition for end of stream**, so a reply shorter than the cap
  with no `]]` was still entirely buffered when the turn ended; ADR-083's lazy connect meant no socket
  existed, `endTurn()` took its "no speakable text" branch, and nothing errored or logged. Every short
  untagged reply was exposed — rare only because the model usually does emit the tag.
  **Third defect in this one feature** (ADR-082 unwired `setTone`, ADR-083 the socket lifetime) and
  ADR-090's class at its purest: a closure in a 2000-line `stream.ts` no test could reach.
  Fixed: the filter is now `createToneTagFilter` in `tone-tags.ts` with an idempotent `flush()` called
  in `speak()`'s `finally` before `endTurn()` — not on a barge-in, where abandoning the text is
  correct — plus a `DEAD AIR on turn N` error log, because a NULL `tts_first_byte_ms` was
  indistinguishable from three benign causes and that ambiguity is the whole reason this sat unexamined.
  **Next thing to look at from the same reconciliation, deliberately not fixed:** the silence re-prompt
  fired 3× in call 25 and the caller answered within ~3s each time — the agent interrupts people who
  are thinking. Timer tuning on n=1 call; needs a decision, not a patch.

- **CI on `main` is green again; the cause was an unversioned third-party input (2026-08-11, ADR-099).**
  `main` had been red for four commits — `visual`, `fonts`, `CI success` — while the whole range
  changed exactly one file under `packages/web` (two lines in a test that renders nothing). Cause:
  `styles.css:1` `@import`ed the Google Fonts CSS2 endpoint, so all 78 pixel baselines were a
  photograph of whatever binary the CDN served that minute, and upstream Fraunces moved. The four
  brand families are now `@fontsource-variable` packages pinned in `bun.lock` and bundled same-origin,
  and `ALLOWED_OFF_ORIGIN` in the screenshot guard is empty — a screenshot run reaches nothing but
  `localhost`. **Zero baseline bytes changed**, which is the proof: pinning restored the prior
  rendering rather than laundering the drift into the baselines. No ratchet was widened.
  **Take from this:** when a pixel gate goes red with no source change, work the four pins in
  `playwright.visual.config.ts`'s header before touching a baseline or an `ALLOWED` list. One of them
  had been aspirational rather than true.
  Also fixed in the same pass: `2a29a18` left an unused `dirname` import in
  `tools/dead-code/knip-gate.ts`, which is all the `lint` failure was.

- **Two facts that were stale everywhere (2026-08-11).**
  1. The GitHub repo is **`Aurora-091/weeber`**, not `openvent`. ADR-078 item G had left the rename
     "to be decided separately". The old slug `301`s, so git remotes are fine, but API calls that do
     not follow redirects break; the numeric id `1295249026` is stable. Historical ADRs/audits still
     say `openvent` and are deliberately left alone.
  2. The **Railway staging deploy of `2a29a18` is `SUCCESS`** on `api-staging-b11d.up.railway.app`,
     no longer `NEEDS_APPROVAL`, and staging's builder is now `NIXPACKS` matching production. Still
     true and still the real risk: staging shares ~33 of 40 env vars with production including
     `DATABASE_URL` and the Twilio account, so "staging" dials and writes production.

- **First outbound pilot prep, and the structural finding underneath it (2026-08-09, ADR-081…090).**
  Ten ADRs landed in one day and they are not ten topics. The scope decision is ADR-081: the agent
  **qualifies and warm-transfers**, it does not perform the licensed act — no claiming licensure, no
  carrier recommendation, no premium quote, no itemized health conditions, no SSN/DOB/routing/account
  capture, no effective date or beneficiary, no voice-signature ACH authorization. Treat that as a
  standing constraint on anything in the insurance vertical, not a pilot detail.
  Shipped with it: transfer outranks hang-up (082), lazy TTS connect so an unspoken socket stops
  tripping failover (083), call health counts `callerTranscriptCount` (084), outbound opener resolves
  lead greeting context in the pickup `Promise.all` (085) and the `interest_area`/`state` fields it
  needs now exist in the intake schema (087), per-account template `visibility`/`ownerOrgId` + an admin
  grant route (086), the prohibited-capture guard actually enforced at the write path (088), and
  preview-first CSV lead import (089).
  **The finding that matters more than any of them: eight of ADRs 073–088 are the same defect** —
  code written, documented, unit-tested, never connected to a caller. 073 and 088 are the identical
  bug found three days apart, both by a human running `rg`. Nothing measured reachability, and unit
  tests structurally hide it (the test imports the symbol, so the export looks used). ADR-090 adds
  `knip` as a CI **ratchet** — `bun run knip:gate`, baseline 61 findings in
  `tools/dead-code/knip-baseline.json`, fails only on new ones. **Before wiring anything new, run the
  gate; before trusting a "shipped" item below, check it has a caller.**
  Gates: typecheck clean · lint 0/0 (479 files) · test **1242 pass / 0 fail** · `knip:gate` green.
  **Not live-verified:** no outbound call has been placed since the silence-timer fix. 082–085 are
  unit-verified only. See `task.md` for the pilot blocker list (no real prospect CSV header row, no
  prospect org in the deployed DB so the bespoke template is still seeded public, uncalibrated 55 ms/char
  playback constant, unsolved US-vs-India TTS routing).

### Earlier context (kept for continuity — verify against `progress.md` before relying on it)

- **The caller identity a tool writes to comes from the carrier, not the model (2026-08-01, ADR-069).**
  Closes the one ADR-066 violation the tool audit found. `crmSync` took `phoneNumber: z.string()` as a
  required *model-authored* input and used it as the **upsert key** — `syncToGoHighLevel` POSTs it as
  `phone` to `/contacts/upsert` (`integrations/gohighlevel.ts:23-32`), which matches on phone, so a wrong
  number does not error: it writes this call's notes onto **someone else's contact** in the merchant's live
  CRM. Three routes there (LLM invents digits it was never given; STT digit errors on Indian accents; the
  caller just says a number that isn't theirs). Meanwhile the real number was already resolved server-side
  at `voice/stream.ts:1561` and already trusted for DNC (`:515`) and caller memory (`:611`).
  Fix is the ADR-064/066 pattern: `CrmSyncContext = { orgId, phoneNumber }`, `resolveCrmSyncContext()`,
  `createCrmSyncTool(ctx)`, resolved once in the `"start"` handler (`stream.ts:1580`) and fixed for the
  call's life; model input narrows to `{ callerName?, notes }` with `phoneNumber` **removed from the JSON
  Schema** (optional-with-a-default was rejected — a field in the schema is a field the model fills).
  **Non-registration is the gate:** `crmSync` is out of the static `voiceTools` map, `buildVoiceTools` took
  a 6th `crmSync?: CrmSyncContext`, and the tool only exists on calls where the context resolved.
  Intended side effect, kept deliberately: **test-chat, the synthetic harness and the preview drawer now
  get no `crmSync`** — a text test could previously write a live contact into a production CRM.
  Also fixed: five seeded insurance personas still documented `crmSync({ phoneNumber, notes })` in their
  tool tables, and those markdown files *are* the shipped prompts.
  Gates: api tsc 0 · web tsc 0 · api 852 pass · web 74 pass · oxlint 0/0. 13 new tests.
  **Not live-verified.** Open question: is `humanNumber` populated at `"start"` on *every* provider —
  Exotel's WS-only path inserts the `calls` row later than Twilio/Plivo. Failure mode is a *missing* CRM
  write, not a wrong one. Step 7 of the call-test protocol covers it.

- **G0.4 protocol written; the call itself is blocked on G0.1 (2026-08-01).**
  `docs/reference/live-call-test-protocol.md` — nine steps: environment isolation as a blocking
  prerequisite, three test numbers incl. a DNC negative control, instrumentation captured before dialling,
  four scripted calls, post-run DB verification, a same-day write-up, and an explicit list of what four
  calls do **not** cover. Deliberately no call was placed: staging bills prod's Twilio and writes prod's
  database. **Step 0 is the G0.1 infra work** (separate Twilio subaccount + number, separate Supabase
  project, `LLM_PROVIDER` matched to prod) and it is not doable in this sandbox — no `railway` CLI, and it
  is the user's billing.

- **Product layout responds to the content column, not the viewport (2026-08-01, ADR-068).** Every grid
  in `pages/app/` used viewport breakpoints while `AppShell`'s sidebar is `hidden md:flex` at `w-56`
  (`components/shell/app-shell.tsx:307,315`) — so it *appears* at 768px and immediately takes 224px, and
  with `--shell-page-px: 2rem` (`styles.css:478`) the content column at that width is 480px. `sm:` fires
  at 640px viewport, so `sm:grid-cols-3` was laying out 149px cards. Document `scrollWidth` was correct at
  every width, which is why this never produced a page scrollbar and was never caught: **the overflow was
  inside the cards, not on the page.** Screenshot at 768px showed `/app/integrations` telephony cards
  rendering "Not connected" one letter per line, "Download as Excel" escaping its card, and `/app/agents`
  truncated to `"COD co…"`.
  Fix: `@container` on both `<main>`s (`app-shell.tsx:367`, `:370`) and **26 in-flow grids** converted to
  container variants across 8 files. Two deliberate exceptions keep viewport breakpoints because they
  render *outside* `<main>` and so have no query container — `pages/app/leads.tsx:725` (Dialog) and
  `components/app/setup-modal.tsx:257` (Sheet); container variants there would silently never match.
  Marketing pages have no sidebar and were untouched. Agent card titles went `truncate` →
  `line-clamp-2 break-words`.
  Verified: overflow sweep over 8 product pages × 10 widths `[390…1440]` went **3 of 40 flagged → 0 of 80**;
  sidebar collapse at viewport 1180 reflows the agents grid **2 → 3 columns** (224px → 52px), which is the
  whole point and is something viewport breakpoints structurally cannot do. New
  `pages/app/responsive-grid.test.ts` (24 tests) fails the build on any bare `sm:grid-cols-*` in
  `pages/app/` or `components/shell/` and asserts `@container` on both `<main>`s; `leads.tsx` is the single
  allowlist entry. Gates: api tsc 0 · web tsc 0 · api 840 pass · web 74 pass · oxlint 0/0.
  **Caveat, stated rather than hidden:** `/app/home`'s three metric strips are data-driven and render empty
  in the backend-free preview harness, so their `sm:grid-cols-4` → `@md:grid-cols-2 @4xl:grid-cols-4` change
  passed the sweep with no tiles present. It is reasoned-correct, not eyes-on-verified.

- **G1 pilot gate — build round (2026-08-01).** Working the pilot-blocking list in
  `audit/pilot-readiness-checklist-2026-08-01.md` so Shopify merchant conversations can start. Four items
  shipped across two commits, all pre-pilot so no merchant was ever affected:
  - **G1.1/G1.2** (`f8c2ba1`, ADR-064) — the LLM chose `percentOff` on `offerCartRecoveryDiscount` and
    silently issued 10% by schema default while the merchant's configured discount was ignored. Now a
    server-bound factory; model input is `{ reason }`; **non-registration is the enforcement** (no discount
    configured → the tool is absent from that call's tool set).
  - **G1.3/G1.4** (`9990a54`, ADR-065 + ADR-066) — every seeded persona was a `{{merge_tag}}` template and
    **nothing rendered it**; `renderTemplate` only ever touched `literalGreetingTemplate`. Rendering was
    rejected (two drifted tag vocabularies; `cart_items_summary`/`product_name`/`delivery_days_estimate`
    have no producer anywhere). Personas 01–03 rewritten tag-free as *instructions*; values now arrive via
    fact blocks that emit a line only when the fact is known; `voice/merge-tags.ts` scrubs any surviving
    tag at the single `streamText({ system })` call site; `database/prompt-hygiene.test.ts` enforces it
    with a shrink-only insurance backlog. Same commit: `confirmCodOrder` was letting the model name the
    `orderId` of an order it **cancels irreversibly**, while (per a separate defect) never having been told
    the order reference — now server-bound, model input `{ confirmed, notes }` (ADR-066).
  - **G1.5** (this round) — `looksLikePromptInjection` was nine English `verb…object` regexes; Hindi and
    Hinglish are verb-final so none could ever fire. Extracted to `voice/injection-detection.ts` with
    order-independent verb/noun co-occurrence, Devanagari stem matching and nukta normalization. Still
    log-only.
  - Three silent producer defects fixed in passing: COD context never wrote `currency` (so the COD agent
    could not state the amount it exists to confirm); the facts block emitted no order reference at all
    (producers write `orderId`, the block read `order_id`); `03`'s seeded greeting carried
    `{{product_name}}`, which has no producer, so its fast canned-greeting path had **never once fired**
    and every feedback call paid full LLM time-to-first-token.

  **NEXT on G1:** insurance personas `04`–`09` are still templated (tracked in
  `MERGE_TAG_MIGRATION_BACKLOG`, which may only shrink). One open product decision, not a doc fix: whether
  the disposition enum should gain confirmed/cancelled and feedback-positive/negative values instead of
  overloading `booked`/`interested`.

  **ADR-066 audit of the two remaining tools — done (2026-08-01), one violation found.**
  - `bookAppointment` (`voice/tools/bookAppointment.ts`) is **compliant**. `orgId` is bound by the factory;
    `calendarId` and `accessToken` resolve from `orgIntegrations` (vault-first). The model supplies
    `callerName`/`dateTimeIso`/`notes`, which *create* a new event — it never names an existing entity, and
    cannot reach another org's calendar. Minor, non-blocking: `dateTimeIso` is unbounded, so a past or
    far-future slot is bookable.
  - `crmSync` (`voice/tools/crmSync.ts:15`) is a **violation of the same shape as `confirmCodOrder`**.
    `phoneNumber: z.string()` is model-supplied and required, and it is the **upsert key** —
    `syncToGoHighLevel` POSTs it as `phone` to `/contacts/upsert` (`integrations/gohighlevel.ts:23`). A
    hallucinated or caller-dictated number writes this call's notes onto a *different* contact in the
    merchant's CRM. The model has no legitimate reason to supply it: the caller's real number is already
    resolved server-side in the `"start"` handler as `humanNumber`
    (`voice/stream.ts:1561`, via `resolveHumanNumber`) and is already trusted for DNC opt-out (`:515`) and
    caller memory (`:611`). Fix is the established pattern — a `CrmSyncContext` carrying `humanNumber`,
    bound at `buildVoiceTools` (`voice/agent.ts:869`) alongside `cartRecovery`/`codOrder`, model input
    narrowed to `{ callerName?, notes }`. Lower blast radius than `confirmCodOrder` (a wrong write, not an
    irreversible cancellation), but the same class.
    **SHIPPED the same day as ADR-069** — see the top of this file. This audit note is kept for the
    reasoning trail.

- **Agent console UI (2026-08-01).** Overview grid shipped at `/app/agents` — the route was previously a
  pure redirect to the first agent, so nine agents were reachable only through a `<Select>` and the detail
  page's own "Agents" breadcrumb linked back to itself. Readiness logic deduped into
  `classifyReadiness`/`agentReadiness` so the grid and the detail page's caller-ID banner cannot drift.
  Browser-verified through an `AgentsGridProbe` in `__preview.tsx` (four synthetic states, no backend).
  A create-agent flow was considered and **rejected** — no POST route exists, the registry is curated, and
  the real complaint was seeing the agents that exist. Full reasoning in `changelog/2026-08.md`.
  Same round: `lookupInfo` added to the three Shopify templates' `defaultTools` (`database/seed.ts`) —
  **newly seeded orgs only**, existing `agent_configs` rows are untouched. **Backfill declined
  (2026-08-01):** every existing org is the founder's own or a test org, so a data migration would buy
  nothing and touch live rows for no reason. Revisit only if a real org predates the seed change.

  **Still unverified, and the honest gap in all of the above:** no real end-to-end PSTN call has been
  placed. Every claim here is from static source reading plus `--isolate` tests.

  **G0.1 closed (2026-08-01), badly.** The `progress.md`-vs-`adr-063` contradiction is settled: ADR-063
  was right, and understated it. Diffing the two Railway variable dumps, **33 of 40 variables are
  byte-identical** across staging and production — same `DATABASE_URL` (same Supabase project, pooler,
  db, role), same `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_PHONE_NUMBER`, same
  `SUPABASE_SERVICE_ROLE_KEY`, same `ADMIN_API_KEY` and internal secrets, same `PUBLIC_*_URL`s. The only
  real difference is `LLM_PROVIDER` (staging `groq`, prod `gateway`). So "staging" dials from the
  production phone number, bills the production Twilio account, writes into the production database, and
  runs a *different* LLM path than prod — it shares prod's blast radius while testing neither prod's data
  layer nor prod's model layer. **This is the top infra item to fix before a pilot merchant's data exists
  in that database**, and it converts Five Bets P5 gate (b) from unverified to confirmed unmet.

  Also corrected the same day: `architecture/voice-orchestration.md` claimed the PDF knowledge base
  "does not exist in the schema/backend yet." It has existed since 2026-07-14 (A3b) — tables, ingestion,
  retrieval, CRUD routes, merchant UI, and the `lookupInfo` binding are all real.

- **Phase III (Visibility) shipped — 2026-08-01, ADR-067.** The agent-editor case study's three
  visibility gaps, closed together. **D2:** new `composeSystemPrompt()` in `voice/agent.ts` is now the
  *single* system-prompt composition path (both `resolveAgentConfig`'s DB-row branch and
  `buildPreviewAgentConfig` call it) and returns the labelled layers alongside the final string; two new
  pure `compiled-prompt` endpoints serve them; a "Prompt" tab in the Preview drawer renders the layers,
  highlights the merchant's own text, and line-level diffs whatever the last edit changed. Invariant
  `segments.join("") === text` is unit-tested byte for byte, so the panel cannot drift from a live call.
  **D4:** tool chips carry a human label, a one-line description, and a consequence group
  (*Conversation control* / *Data capture* / *Acts outside the call*, the last one weighted) instead of a
  raw camelCase identifier. **D3:** each guardrail dial renders the exact sentence it injects, sourced
  from a dependency-free `voice/prompt-lines.ts` with a web parity test.

  Fixed in passing: `buildPreviewAgentConfig` never fetched `orgs.name`, so **every previewed prompt was
  missing the "You are calling on behalf of X" line a real call ships**. It now takes an optional `orgId`;
  all five call sites pass it.

  Stated in the UI rather than papered over: **`injectionSensitivity` changes prompt wording only** — the
  runtime injection detector is not wired to that dial and behaves identically at all three levels.
  Making it real is a separate, unstarted decision.

  **Browser-verified later the same day, and it found two defects.** A DEV-only `phase3` page in
  `pages/__preview.tsx` mounts `ToolsGuardrailsTab` (now exported for the harness) beside
  `CompiledPromptPanel` with local state — web-only Vite server, no API, no telephony. Groups, mono
  consequence lines, layer badges and diff-on-toggle all render as designed, light and dark, zero console
  errors. **(1)** Reading the call-control layer on screen exposed that `buildCallControlBlock` had been
  shipping **ragged indentation into every live call** — ``dedent`…` `` computes its minimum indent *after*
  interpolation and the multi-line constants it interpolates are flush-left, so nothing was ever stripped.
  Now a flush-left `string[]` + `join("\n")`; content unchanged, whitespace only; `/^ {3,}/` regression test
  added. **(2)** The "no caller ID" banner (`agents.tsx:712`) hardcoded dark-mode-only `amber-*` and was
  unreadable in light mode; now semantic `warning`/`foreground` tokens. Both were type-correct, lint-clean
  and covered by passing tests — *rendering for a human to read is a distinct verification class.*

  **NEXT on the editor:** the Tools & Guardrails tab still has no render test (the harness is a DEV page,
  not an assertion). `D1` (create-agent), `D5` (prompt versioning) and Phase IV (eval/judge) remain
  deliberately out of scope.

- **Semantic turn-detection SEAM — Five Bets Phase V (2026-07-31):** Fifth/final phase, and the Five
  Bets plan is now complete. Ships the pluggable end-of-turn (EOT) **seam + fallback discipline only —
  NOT a model vendor**, because the model is gated (zero Phase II production health data yet, pre-pilot;
  staging+prod still share `DATABASE_URL` so no isolation). New module `packages/api/src/voice/turn-detection/`:
  (1) `types.ts` `TurnEndDetector` interface `decide(input)→{done,by,reason?}`; (2) `heuristic.ts` —
  `endsMidThought`+pattern MOVED here unchanged from stream.ts, wrapped as `HeuristicTurnDetector` (default
  + always-available fallback, zero I/O); stream.ts re-exports `endsMidThought` for back-compat;
  (3) `budgeted.ts` `withLatencyBudget(primary,fallback,budgetMs)` — a slow/throwing model degrades to the
  heuristic, never adds unbounded latency to the hot path; (4) `composite.ts` — heuristic first, short-circuit
  (skip model) when it wants to hold, consult refiner ONLY when the turn looks complete; (5) `index.ts`
  `createTurnDetector(config)` + `SEMANTIC_TURN_DETECTION_FLAG` (`semantic-turn-detection`) +
  `DEFAULT_REFINER_BUDGET_MS` 300. Wiring: per-call `turnDetector` built in stream.ts start handler from the
  flag (refiner=null default → plain heuristic, byte-identical to old inline check); call site is now
  `const d = await turnDetector.decide({text}); if(!d.done){armSilenceTimer;return;}`. **Flag default OFF, no
  DB column / no migration** (org-flag path). Model wiring correctly deferred — dropping in Smart Turn/OpenAI
  Realtime/LiveKit later = pass a `refiner` + flip the flag. Verified: api+web tsc 3/3 · web build ✓ · oxlint
  0/0 · `bun test --isolate src/voice/turn-detection/turn-detection.test.ts src/voice/stream.test.ts` 24/0
  (StubModelTurnDetector mock, no live vendor, audio path untouched). **NEXT: nothing in Five Bets — model
  wiring waits on Phase II call-health data + staging isolation. No live-audio/live-server test without
  explicit go-ahead.**

- **Backchannels — Five Bets Phase IV (2026-07-31):** Fourth phase. Adds short low-latency acks
  ("Mm-hm."/"Right."/"Okay.") played sparingly while the caller is mid-utterance, covering the
  caller-is-talking silence window (pre-tool fillers only covered the agent-is-working window). Shipped:
  (1) pure `packages/api/src/voice/backchannel.ts` `shouldBackchannel(input)` → bool with all guardrails
  in one place (off unless org flag on; never while agent speaking; never on speech_final; only after
  `BACKCHANNEL_MIN_UTTERANCE_MS` 2500; rate-limited to one per `BACKCHANNEL_MIN_GAP_MS` 4000) + 10 tests;
  (2) `stream.ts` wiring — fires on Deepgram interim partials before the speech_final early-return;
  `maybePlayBackchannel` renders cached clips only (warm-cached on start via existing `warmFillerCache`);
  per-call state `callerUtteranceStartedAt` (reset on barge-in + consumed turn) + `lastBackchannelAt`;
  **NOT a turn** — never sets agentIsSpeaking / enters history / clears, so it can't corrupt
  turn-taking/barge-in/endsMidThought; (3) org flag `backchannels`, default OFF, **no DB column / no
  migration** (org-flag path like expressive-delivery). Verified: api+web tsc 3/3 · web build ✓ · oxlint
  0/0 · `bun test --isolate src/voice/backchannel.test.ts` 10/0 (41/0 across all four phase test files).
  **Synthetic-harness assert-unchanged check is N/A (text-only, no interim-STT path; backchannels never
  touch history). Real validation = controlled LIVE-AUDIO test, pending explicit go-ahead. NEXT: Phase V
  gate decision — build semantic turn-detection ONLY if Phase II call-health data shows a real
  turn-taking problem in production.**

- **Synthetic scenario expansion — Five Bets Phase III (2026-07-31):** Third phase. Extended the EXISTING
  AI-to-AI synthetic-test harness (`packages/api/src/voice/synthetic-scenarios.ts` + `synthetic-test.ts`)
  from 3 → 8 scenarios — NOT a rebuild. **Honest scope: text-only harness cannot test audio-timing
  failure modes (dead air/barge-in/mid-thought cut-off/silent STT-TTS); those stay gated on live
  telephony + Phase II health data.** Phase III locks the behavioral/prompt regressions instead. Added:
  `escalation-needed` (→`transferToHuman`), `abusive-caller-guardrail` (→`flagGuardrailEvent`, positive
  counterpart to `angry-customer`), `cod-confirmation` (→`confirmCodOrder`), `unknown-info`
  (→`lookupInfo`, hallucination guard), `multi-intent` (→`captureField`). All use existing assertion
  types (no schema change, no migration). New catalog-integrity tests in `synthetic-test.test.ts`: unique
  keys, ≥1 assertion + positive maxTurns each, and every tool assertion resolves to a real tool (closes
  the "assertion names a bogus tool → silently passes forever" trap). Verified: api+web tsc 3/3 · web
  build ✓ · oxlint 0/0 · `bun test --isolate src/voice/synthetic-test.test.ts` 10/0. **NEXT: Phase IV
  (backchannels), then Phase V gate decision from Phase II health data.**

- **Call health / silent-failure detection — Five Bets Phase II (2026-07-31):** Second phase of the
  approved Five Bets plan. `status` only says how a call ended for the carrier — it counts dead-air /
  STT-never-connected / greeting-only calls as `completed`. This derives a health verdict at call end.
  This is the phase that GENERATES the evidence Phase V (semantic turn-detection) is gated on. Shipped:
  (1) pure `packages/api/src/voice/call-health.ts` `classifyCallHealth(input)` → `{status, reasons}`,
  status `healthy|degraded|silent-failure`, judges only answered calls; named threshold constants
  (`DEAD_AIR_SILENT_MS` 8000, `DEAD_AIR_DEGRADED_MS` 3000, `LLM_TTFT_DEGRADED_MS` 2500,
  `STT_CONNECT_DEGRADED_MS` 2000) + 14 unit tests; (2) additive nullable `calls.healthStatus` (text) +
  `calls.healthReasons` (jsonb) + index `calls_health_status_idx` + **offline** migration
  `drizzle/0046_colorful_robbie_robertson.sql` — **NOT applied; user runs `db:migrate` (shared DB);
  Call Health view empty until then**; (3) `stream.ts` `finalizeCall` classifies from in-memory signals
  (added `transcriptCount` counter + local `sttReconnectCount` mirror) and folds the verdict into the
  SAME finalize `update` (atomic, no extra write); (4) admin `GET /api/voice/compliance/call-health`
  (`status`/`orgId` filters, only computed verdicts, `{calls, byStatus, byReason, total}`); (5) "Call
  Health" card in `compliance.tsx` (filter chips + per-call reason lists + CSV export). Verified: api+web
  tsc 3/3 · web build ✓ · root oxlint 0/0 · `bun test --isolate src/voice/call-health.test.ts` 14/0.
  **Migration 0046 pending user apply. NEXT: Phase III synthetic scenario expansion (await go-ahead).**

- **Guardrail event log — Five Bets Phase I (2026-07-31):** First phase of the approved Five Bets plan
  (`docs/product-strategy/five-bets-build-plan-2026-07-31.md`). Approved sequencing (inverted from
  research): **I** guardrail-events table (this) → **II** silent-failure/call-health detection → **III**
  synthetic scenario expansion → **IV** backchannels → **V** semantic turn-detection (last, gated on
  Phase II data showing a real turn-taking problem). Shipped: (1) `guardrail_events` table in `schema.ts`
  + **offline** migration `drizzle/0045_sour_matthew_murdock.sql` — **NOT applied; user runs `db:migrate`
  (shared DB); panel empty until then**; (2) pure `packages/api/src/voice/guardrail-events.ts`
  `deriveGuardrailEventFields(name, input)` → `{category,source,detail}` | null (category enum
  topic-boundary/unauthorized-promise/prompt-injection/abuse/unknown; source agent-self-report |
  heuristic-detector) + 7 unit tests; (3) `stream.ts` `logToolCall` fire-and-forget insert after the
  `toolCalls` insert (both guardrail signals already funnel through this one choke point; best-effort,
  swallows DB errors, never blocks call — ADR-062); (4) admin `GET /api/voice/compliance/guardrail-events`
  (`orgId` filter, `{events, byOrgCategory, bySource, total}`); (5) "Guardrail Event Log" card in
  `compliance.tsx` (per-event list + `bySource` chips + CSV export). Existing `/compliance/overview`
  tool_calls-scan counts left untouched (cover pre-migration calls). Verified: api+web tsc 3/3 · web
  build ✓ · root oxlint 0/0 · `bun test --isolate src/voice/guardrail-events.test.ts` 7/0.
  **Migration 0045 pending user apply. NEXT: Phase II call-health detection (await go-ahead).**

- **Canvas product telemetry — first-party event pipe (2026-07-31):** Closed the highest-value gap
  flagged below — the canvas/Customize flow was unmeasured. Built a **first-party** product-usage event
  pipe (deliberately NOT PostHog/Amplitude: zero vendor cost, data stays in our Postgres, no PII to a
  processor, pre-pilot volume is tiny). Three pieces: (1) `product_events` table in `schema.ts` +
  **offline** migration `drizzle/0044_nostalgic_lilith.sql` — **NOT applied; user runs `db:migrate`
  (shared DB)**; (2) `packages/api/src/app/events-ingest.ts` (pure `parseEventBatch` — name regex,
  4KB props cap, batch cap 50, epoch sanity; best-effort `recordEvents` that swallows DB errors) +
  `POST /api/app/events` after `requireUserOrg` (orgId/userId from session, always 2xx, 429 on flood,
  limiter `APP_EVENTS_RATE_LIMIT` 120/60s); (3) `packages/web/src/web/lib/analytics.ts` — typed
  `track()` that **never throws/blocks**, canonical `AppEventName` union (14 names; server validates
  shape only so new events are client-only), sessionId + batched flush + keepalive on hide. Deleted the
  dead `window.stonks` shim (`types/analytics.d.ts`). Wired `workflows.tsx` end-to-end: activation funnel
  (`workflow_list_viewed` → `workflow_customize_started {source: template|blank|ai_draft|reopen}` →
  save `attempted`/`blocked`/`succeeded` with `activated:true` + `msSinceStart` → list-toggle
  `activated`/`paused`) + canvas-usage (`node_added {via}`, `node_deleted`, `edge_connected`,
  `node_config_opened`) + AI-draft (`requested`/`succeeded`/`failed`). Activation not double-counted
  (save carries `activated:true`; toggle events reserved for list). Verified: api+web tsc 0 · web build
  ✓ · root oxlint 0/0 · `events-ingest.test.ts` 9/0 · `bun test --isolate src/app/` 45/0.
  **No funnel UI yet** (the first-party trade-off) — query `product_events` via SQL / small admin view
  later. Admin `workflow-editor.tsx` intentionally not instrumented (merchant flow only).
  **Migration 0044 pending user apply.** Pre-existing `src/app` test-isolation issue (below) still open.

- **Workflow graph validation (P1) + Sentry loop closed (2026-07-30):** Shipped a shared,
  authoring-time graph validator and proved the monitoring loop end-to-end.
  **Sentry:** ran a one-off smoke test through the real `initSentry`/`captureError` +
  `Sentry.flush(5000)` → returned `true` (event delivered), env-tagged `sentry-smoketest`. Loop is
  proven working; `SENTRY_DSN` set on Railway prod+staging. Smoke-test script deleted, not committed.
  **P1 validation:** new pure module `packages/api/src/voice/workflows/graph-validation.ts`
  (`validateWorkflowGraph(graph)` → `{ issues, errors, blockers, warnings }` + `hasStructuralErrors`,
  `canActivate`; no I/O). Severity taxonomy maps to real `graph-engine.ts` runtime behavior —
  **error** (run fails/ambiguous → always block save), **blocker** (runs wrong/nothing → block admin
  save + merchant *activation*, allow draft), **warning** (engine tolerates → never blocks, surfaced).
  This is the authoring-time **belt**; `validateLockedNodesEnforced` stays the compliance **suspenders**
  and `scheduler.ts` stays the runtime enforcement — neither replaced. Wired: admin `validateGraph`
  delegates to it; merchant `PUT /workflow-configs/:templateKey` (errors→400 always, blockers→400 when
  `enabled:true`, warnings echoed in 200 body); `ai-draft` rejects drafts with structural errors only
  (blockers expected — merchant fills them in). Frontend `workflows.tsx` surfaces an amber "Saved with
  N suggestions" note. 14 new tests (`graph-validation.test.ts`). Verified: `packages/api` tsc 0 ·
  `packages/web` tsc 0 · web build ✓ · root `oxlint` 0/0 · `bun test src/voice/workflows` 110 pass/0.
  **Known pre-existing (NOT this work):** `bun test src/app` has 1 failing test
  (`supabase-auth.test.ts`, `getOrgLead` export + `db.update` mock leaking across files when the whole
  `src/app` dir runs in one invocation); reproduces on a clean tree, passes in isolation — flagged for
  a separate test-isolation fix. **Still open:** P2 template gallery at entry; **no usage analytics on
  the canvas/Customize flow** (still the highest-value gap — instrument before further tuning).

- **Workflow builder P0 UX fixes — persona dropdown + AI-draft front door (2026-07-30):** After a cold
  UX audit of the merchant workflow builder (`audit/2026-07-30-audit-08-workflow-canvas-ux.md`) +
  competitor matrix. **Decision: keep the canvas** — it's *orchestration* (the Shopify-Flow pattern
  merchants know), not conversation-flow; the fix is to stop making raw wiring the front door.
  Shipped two P0s: (1) call-node `persona` is now a **dropdown** of the org's agents instead of raw
  text (a call node could otherwise point at a non-existent agent — persona = a resolved templateKey).
  `NodeConfigPanel` took an optional `personaOptions` prop and stays presentational, so the admin
  template editor keeps the raw input (different auth); merchant canvas feeds it via new
  `useAgentPersonaOptions` (`GET /api/app/agent-configs`). (2) The AI-draft "describe your flow" bar,
  previously buried inside the canvas, is now the **primary path on the Standard View entry** →
  generate → land in canvas to edit/save. Files: `components/canvas/NodeConfigPanel.tsx`,
  `pages/app/workflows.tsx`. Verified: `packages/web` tsc 0 · build ✓ · root `oxlint` 0/0.
  **Still open:** P1 graph validation, P2 template gallery, and — flagged highest-value — **no usage
  analytics exist on this flow**, so all of the above is reasoned from code+competitors, not observed
  sessions; instrument before tuning. `SENTRY_DSN` is set on Railway (prod+staging) but not yet proven
  end-to-end. Whether SMBs should ever see a node-graph canvas at all: deferred (canvas kept for now).

- **Workflows Standard View — affordance/legibility fixes (2026-07-30):** Follow-up to a UX audit —
  a tester got lost on the default workflow view because the read-only React Flow graph looks editable
  but only `wait/call/sms` nodes respond to a click, with no signal which. Fixed with pure
  affordance/legibility changes (no architecture change; canvas editor untouched): editable-node cue
  (hover ring + pencil + pointer cursor via a new `editable` flag on `WorkflowNode`), an orientation
  strip + legend above the graph, "Save changes" now only renders when there are unsaved edits (was a
  looks-broken disabled button on load), and the "No workflows" empty state gained a "Connect your
  store" CTA to `/app/integrations` (was a dead end). Files: `components/canvas/WorkflowNode.tsx`,
  `pages/app/workflows.tsx`. Verified: `packages/web` tsc clean · build clean · `oxlint` 0/0.
  See `changelog/2026-07.md`. **Still open (unchanged):** set `SENTRY_DSN` on Railway; the deeper
  question of whether SMBs should ever see a node-graph canvas at all (deferred, not this session).

- **App UI/UX Restructuring & Integrations Alignment (2026-07-20):** Resolved UI defects across `/app` routes.
  **Toaster Z-Index Elevation**: Elevated Sonner `Toaster` z-index to `99999` in `sonner.tsx` and `styles.css`
  so notifications float over all modal dialogs, drawers, sticky headers, and backdrop overlays.
  **Integrations Page Redesign**: Removed `bg-background` root class overrides in `integrations.tsx` (preventing
  nested double-background box artifacts) and replaced full-screen blur overlays (`fixed inset-0 z-50`) with an
  inline card-level status banner. **Route Fallbacks**: Upgraded `PageFallback` in `app.tsx` from a bare spinner
  to a structured page skeleton (`page-enter space-y-6`). Verified: `typecheck` clean · `test` 16 pass / 0 fail · `build` clean. Pushed to `origin/main`.

- **Native, person-centric leads/records layer shipped (2026-07-19, Phases 1–3):** built the *owned*
  data-of-record layer before bolting on external CRMs. New tables (`leads` deduped by
  `(orgId, phone)`, `leadIntakeSchemas`, `leadApiKeys`; `calls.leadId` plain indexed int, no FK;
  migration `0040_mushy_arclight.sql`). **Phase 1 (owned core):** captured fields promoted
  `capturedState → leads.fields` at `finalizeCall`; insurance `Leads` page (list/search, detail +
  call history, pipeline status, assign advisor, call-now, Excel export, manual add/edit).
  **Phase 2 (edges & config):** `POST /api/leads/ingest` (per-org `wlk_` key auth, schema-validated,
  regulated keys rejected, idempotent upsert; `triggerWorkflow` accepted-but-not-wired until it
  respects DNC/TCPA dial-gates) + per-org/per-agent intake-schema editor. **Phase 3 (reach):**
  public hosted form `/f/:orgId` (**`orgId` is the non-secret write-only form token** — honeypot +
  per-(ip,org) rate limit, no migration) + on-demand "Sync to CRM" mirror (HubSpot/Salesforce/GHL,
  leads stays source of truth). Scoping decisions in **ADR-061**; plan in
  `product-strategy/native-leads-layer-plan-2026-07-19.md`. Verified: `typecheck` clean · `test`
  **621 pass / 0 fail** · `lint` 0/0 · `build` clean.
- **Integrations strategy set (2026-07-19):** Pipedream on the *inbound* edge (any CRM/form → our
  ingest API), native adapters for *outbound* (CRM mirror). `product-strategy/integrations-strategy-
  and-roadmap-2026-07-19.md`; recipe in `integrations/pipedream-inbound-recipe.md`. **Pipedrive
  native adapter** flagged as the next likely inbound native adapter.
- **Insurance vertical filled out (2026-07-19):** config-driven en/hi/hinglish language variants for
  insurance agents 04–08, plus a new **Final Expense Qualifier + Warm-Transfer** agent (persona 09,
  scoped US/English-only). All 10 insurance agent prompts now live in `docs/agent-prompts/`.
- **Language support: closed/scoped (ADR-060, 2026-07-19)** — see the section below.
- **Workflow Canvas v4 Phase 3 — SHIPPED (2026-07-19), not open.** Flow preview via web call is
  built and merged (`voice/workflows/preview-walker.ts`, `components/workflow-preview/
  FlowPreviewPanel.tsx`, commits `a9dca16`/`91b13ac`; changelog `b491f15`). The whole v4 plan
  (Phases 1/2/3) is done — do not carry this forward as an open item again.
- **Still open from 2026-07-18 (carried forward):** adopt **Supabase Realtime** for the dashboard
  (decided `ADR-058`, not built — currently polls `refetchInterval` every 4–5s); **set `SENTRY_DSN`
  on Railway** (Sentry wired, no-op until the env var is set). Everything else from the 2026-07-18
  session (insurance KPI-mislabel fix, feedback agent live, VoiceOrb rebuild, infra review, pricing
  lock `ADR-057`, docs→brain restructure) shipped — see `progress.md` "Closed recently" and
  `changelog/2026-07.md`.

## Language support: closed, scoped correctly (ADR-060, 2026-07-19)

**B2 — multilingual understanding, not mid-call switching.** The Hindi/Hinglish STT/TTS foundation is
solid and live-verified (2026-07-16, `../voice-quality/hindi-hinglish-voice-support.md`), and Indic
calls now smart-default to Sarvam automatically (ADR-060, `../voice-quality/language-support.md`).
Mid-call *spoken-language switching* is REJECTED — not an open gap — because flipping the TTS voice
mid-call breaks voice identity, adds latency, and destabilizes the call (one fixed spoken language per
call; STT code-switching understanding is separate and stays). The differentiator is native Hinglish
+ multilingual understanding, not a switching gimmick. Only open B2 item: B2.5 (localized system
messages), minor polish. See `WEEBER-PLAN.md` Phase B and ADR-060.

## Next candidate items (not started, pick by sequencing not scope — ADR-037)

**Road ahead is now tiered in `WEEBER-PLAN.md` → "Road ahead — prioritized (2026-07-19)". Short version:**

- **Tier 1 (highest leverage):** **C4b — ingest-triggered call activation.** Wire the
  accepted-but-not-wired `triggerWorkflow` on `/api/leads/ingest` → agent router → outbound call,
  routed through the existing DNC/TCPA/quiet-hours dial-gates (reuse `scheduler.ts` /
  `place-outbound-call.ts`). This is the "lead lands → agent picks → call fires" loop; the leads
  layer (C4) is shipped up to the point where the call would fire.
- **Tier 2 (multi-channel reach):** C5 — WhatsApp node/tool/action mirroring the SMS 3-surface
  pattern; expose the transactional email path (`app/email.ts`) as a flow node; cross-channel
  fallback chains (Wait + delivery/read-status branch).
- **Tier 3 (integrations/templates):** C6 — Pipedrive native inbound adapter + Pipedream
  connector layer; activate per-org `wlk_` keys for a first external source; vertical flow
  templates (clinic/hotel/restaurant) once those verticals are built.
- **Tier 4 (carried forward):** Supabase Realtime dashboard (`ADR-058`, decided not built);
  `SENTRY_DSN` on Railway; A1b VAD/endpointing audit; B2.5 localized system messages.
- Opportunistic + cheap: D1 (Kokoro TTS pilot), D4 (join NVIDIA Inception).

## Open decisions waiting on the user (STOP-AND-ASK)

- Supabase Realtime on the dashboard: decided (`ADR-058`), just needs someone to actually build it.
- Set `SENTRY_DSN` on Railway (Sentry itself is wired, just needs the free Sentry.io project + env var).
- **C4b entry-condition branching** — config-driven vs. visual-canvas-from-day-one for the
  ingest→call activation router is still the open product decision (CLAUDE.md gate #4). Ask before
  building the routing UI.

_Last updated by: ADR-114 (per-agent transfer destination, and collapsing the two independent reads of the transfer number into one), 2026-08-14._
