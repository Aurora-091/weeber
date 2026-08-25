# Code-level performance and simplification audit — `voice/stream.ts` and `voice/agent.ts`

- **Date:** 2026-08-25
- **Source:** repo `main` @ `96a82c2`, read directly (`stream.ts`, `agent.ts`, `tools/`, `tts/`, `stt/`,
  `turn-detection/` under `packages/api/src/voice/`) — not inferred from plan docs or prior audits.
- **Scope:** a dedicated code-quality pass after C1-C4 and D1-D8 plus the backchannel default-flip landed
  in this one session on top of `stream.ts`'s pre-existing 3500+ lines. Looking for redundant per-turn
  work, dead/unreachable branches from the rapid layering, genuine simplification opportunities, and
  latency gaps Phase C didn't cover. Not a correctness review — Phase C/D's own test suites and this
  session's own re-verification passes already covered that ground.
- **Class:** dated point-in-time artifact (ADR-118 class 2) — findings, not a plan. Nothing here is
  applied; each item names its own risk so whoever picks it up can decide.

## Summary

Three findings, ranked by impact. `bun run knip:gate` was run directly (0 findings beyond baseline) rather
than re-describing what it already covers — this audit only lists things reachability analysis by
definition can't see: a runtime completeness gap, redundant work on an invariant value, and duplicated
logic across two structurally identical functions.

| # | Finding | Impact | Risk to fix |
|---|---|---|---|
| 1 | Tool-call filler lines are never pre-warmed at call start, unlike backchannel lines | Real, audible — every call's first slow tool call gets silent dead air instead of filler audio | Low |
| 2 | `stablePrefix` is scrubbed (regex scan) and hashed twice per turn despite being call-invariant | Minor CPU only — not on the latency-dominant path | Low |
| 3 | `maybePlayToolCallFiller`/`maybePlayBackchannel` are near-duplicate functions | Code cleanliness, not performance | Low |

No dead/unreachable branches were found from this session's rapid C1-C4/D1-D8 layering. The state this
session added (`nonInterruptibleCounter`, `backchannelsEnabled`, `silenceWarningMs`/`silenceHangupMs`
overrides, `askCount`, etc.) is each read on a live path — checked directly, not inferred.

---

## 1. Tool-call filler lines are never pre-warmed — every call's first slow tool call is silent

**File:** `packages/api/src/voice/stream.ts:3419-3453` (the "start" handler's flag-resolution block).

**What's there:** D4 (this session) flipped `HYBRID_AUDIO_CACHE_FLAG` to default-on for both the tool-call
filler (`TOOL_CALL_FILLER_LINES`, `:1697`) and the backchannel lines (`BACKCHANNEL_LINES`,
`backchannel.ts`). The backchannel flip (this session, later the same day) added a proactive warm at call
start:

```
if (backchannelsEnabled) {
  for (const line of BACKCHANNEL_LINES) void warmFillerCache(line);
}
```

**Nothing equivalent exists for `TOOL_CALL_FILLER_LINES`.** `maybePlayToolCallFiller` (`:1725-1746`) only
warms the cache lazily, on the first real trigger:

```
const cached = getCachedTtsAudio(resolvedProvider, resolvedVoiceId, languageOverride, text);
if (!cached) {
  void warmFillerCache(text);
  return;   // <-- nothing is sent to the caller this time
}
```

`stream-tool-call-filler.test.ts`'s own doc comment already names this exactly: *"the first slow-tool-call
trigger only warms the cache (nothing cached yet to send); the second, one turn later, should find a
hit."* That's correct as a description of current behavior, but it means **every single call's first slow
tool call plays no filler audio at all** — the caller gets dead air for that one instance, silently,
despite the flag being on specifically so this wouldn't happen. Only the *second* slow tool call in a call
(if there is one) benefits.

**Why this is worth fixing now, not filed as a later item:** it's the direct, mechanical gap left by this
session's own two flag flips landing a few hours apart — backchannel got the warm-at-start treatment,
tool-call filler didn't, purely because that code was written earlier in the session before the pattern
existed. It is not a pre-existing, load-bearing design decision.

**Fix:** mirror the exact same pattern already sitting three lines below the backchannel warm, e.g.:

```
if (fillerFlags[HYBRID_AUDIO_CACHE_FLAG] !== false) {
  for (const line of TOOL_CALL_FILLER_LINES) void warmFillerCache(line);
}
```

placed in the "start" handler alongside the backchannel warm (needs the resolved flags, which are already
in scope there as `noiseFilterFlags`/`resolvedFlags` — `TOOL_CALL_FILLER_LINES` itself is declared later
in the file as a `const` inside the closure, so this either needs hoisting the constant above the "start"
handler or referencing it after declaration order is fixed; either is mechanical). **Risk: low** — purely
additive (a fire-and-forget warm, same as the existing backchannel one), doesn't touch turn-taking or
barge-in state, and the existing `stream-tool-call-filler.test.ts` cache-hit assertions would need one
more case (first-trigger-of-a-fresh-call now also hits) rather than being invalidated.

---

## 2. `stablePrefix` is scrubbed and hashed twice per turn despite being call-invariant

**Files:** `packages/api/src/voice/agent.ts:2115-2123` (`runVoiceAgentTurn`), `:1826-1831`
(`composeTurnSystemPrompt`), `:1841-1843` (`hashStablePrefix`); `merge-tags.ts:73-92`
(`stripUnresolvedMergeTags`).

**What's there:** every turn, `runVoiceAgentTurn` does:

```
const { stablePrefix, dynamicSuffix } = buildTurnPromptParts({ persona, ... });
const systemPrompt = composeTurnSystemPrompt(stablePrefix, dynamicSuffix);
//   composeTurnSystemPrompt internally: scrubSystemPrompt(stablePrefix, ...) + scrubSystemPrompt(dynamicSuffix, ...)
onStablePrefixHash?.(hashStablePrefix(scrubSystemPrompt(stablePrefix)));
//   ^ a SECOND scrubSystemPrompt(stablePrefix) call, immediately after the first
```

`buildTurnPromptParts`'s own doc comment (`:1758-1762`) states `stablePrefix` is "resolved once at
'start' ... and reused unchanged for every turn of the call" — and Phase C2's status note in
`phase-c-latency.md` independently confirms this by construction (`persona` is a `let` assigned exactly
twice, both during one-time call setup, never inside the per-turn loop). So `scrubSystemPrompt(stablePrefix)`
is being run on a provably-identical string twice per turn, every turn, for the life of a call —
`stripUnresolvedMergeTags` does a full `prompt.matchAll(MERGE_TAG_PATTERN)` walk over the *entire* string
(not a short-circuiting `.test()`), and `hashStablePrefix` runs a fresh SHA-256 over the same scrubbed
string result, both on input that cannot have changed since the previous turn. On the real production call
16 (33 turns, cited throughout this session's Phase C/D work), that's roughly 66 redundant regex scans
plus 33 redundant SHA-256 hashes over a multi-KB persona+call-control string, computing the identical
result every time.

**Honest impact assessment: this is not a latency-critical finding.** Phase C's own numbers put LLM at
~70% of voice-to-voice time and TTS at ~23%; a regex scan plus a SHA-256 over a few KB of text is
sub-millisecond work, nowhere near that magnitude. This is CPU cleanliness, not a v2v-moving fix — flagged
because it's easy and free to fix, not because it's costing anything a caller would notice.

**Why it's not a bug, and shouldn't be "fixed" by removing the check:** the whole point of
`onStablePrefixHash` is to catch the day this invariant silently breaks (a future change accidentally
threading per-turn data into `persona`). Deleting the recomputation would defeat the diagnostic it exists
to be. The right fix preserves the check while removing the redundant work:

**Fix:** memoize the `(stablePrefix, scrubbedStablePrefix, hash)` triple once per call — e.g. in
`stream.ts`, compute `scrubSystemPrompt(persona)` and its hash once when `persona` is assigned during
"start" setup (the two exact spots `phase-c-latency.md`'s own status note names, `:3071`/`:3263` at the
time of writing), and pass the pre-scrubbed value through instead of the raw `persona` string —
`composeTurnSystemPrompt` would then only need to scrub `dynamicSuffix` per turn, which genuinely does
change. **Risk: low** — a pure memoization, behavior-identical on the happy path; the one thing to get
right is invalidating the cache on `persona`'s two legitimate reassignment points, which is exactly where
the recompute would move to.

---

## 3. `maybePlayToolCallFiller` and `maybePlayBackchannel` are near-duplicate functions

**Files:** `packages/api/src/voice/stream.ts:1725-1746` (`maybePlayToolCallFiller`), `:1758-1780`
(`maybePlayBackchannel`, by line proximity in the same file).

**What's there:** both functions do the identical four steps — pick a random line from a fixed array,
resolve the current TTS voice via `currentTtsVoice()`, look up cached audio for `(provider, voiceId,
languageOverride, text)`, and either forward it to the caller or warm the cache for next time. They differ
only in: which line array they draw from (`TOOL_CALL_FILLER_LINES` vs `BACKCHANNEL_LINES`), one extra flag
check inside the filler version (the backchannel version's caller already checked `backchannelsEnabled`
before invoking it), and a log-message label. This is accidental duplication, not two genuinely different
mechanisms — both this session's own two flag-default flips (D4, then backchannels) grew this shape
independently rather than sharing it.

**Fix:** factor out one shared `playOrWarmCachedLine(ws: Sendable, lines: readonly string[], logLabel: string)`
helper both call. **Risk: low** — pure refactor, no behavior change, and both call sites already have
direct test coverage (`stream-tool-call-filler.test.ts`, `stream-backchannel-default-flip.test.ts`) that
would catch any accidental divergence introduced while merging them. Worth doing *together* with finding 1
above, since fixing 1 means adding a warm-at-start call for `TOOL_CALL_FILLER_LINES` right next to the
existing one for `BACKCHANNEL_LINES` — a natural moment to also share the play/warm body if the two lines
are being looked at side by side anyway.

---

## What was checked and found clean

- **No dead/unreachable branches from this session's own rapid layering.** Checked directly rather than
  assumed: `nonInterruptibleCounter` (D7) is read by both `barge-in.ts`'s `decideBargeIn` and
  `agent.ts`'s `withNonInterruptible`; `askCount` (D2) is read by `buildKnownFactsBlock`'s
  confirmed/retryable/exhausted split; `silenceWarningMs`/`silenceHangupMs` (D1) are read by
  `armSilenceTimer` and diverge from the module constants only when `resolveSilenceTimeouts` returns an
  override — both branches are live, not one dead default. `bun run knip:gate` independently confirms 0
  findings beyond the recorded baseline.
- **The C2 mid-call-cache-drop mechanism** (`dynamicSuffix` concatenated into the same `system` string as
  `stablePrefix`, so any turn right after a new capture misses cache) is already fully diagnosed in
  `phase-c-latency.md`'s own C2 status note, confirmed architecturally expected rather than a bug — not
  re-litigated here.
- **No parallelizable sequential-await chain was found in `speak()` or the per-turn hot path** beyond what
  Phase C already addressed (TTS session reuse, STT-connect-off-pickup-path, prompt-cache stabilization,
  terminal-tool-batch cap). The remaining sequential structure (generate → speak → persist) is inherent to
  a live phone call's turn-taking, not an accidental serialization.
