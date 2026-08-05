---
doc: decision
id: ADR-070
status: accepted
date: 2026-08-05
supersedes: —
related: ADR-040, ADR-060
---

# ADR-070 — One voice per call: TTS failover is sticky, and a voice ID never crosses providers

## Context

Reported defect: **"the agent's voice changes during the call."**

Cross-provider TTS failover (2026-07-17) is per-*turn* by construction — the TTS connection is
per-turn, unlike STT's persistent per-call socket — so `speak()` rebuilt the chain every turn:

```ts
const ttsFailoverChain = resolveTtsFailoverChain(resolveTtsProvider(ttsProviderOverride, languageOverride), ...);
// ...
tts = attemptTts(ttsProviderOverride);   // always the primary again
```

Two consequences, both audible to the caller, neither visible in any log or on the call record.

**1. The configured voice ID travelled to the fallback provider.** `attemptTts` passed
`ttsVoiceIdOverride` unchanged on every hop. Voice IDs are provider-scoped: Cartesia's are opaque
UUID-ish strings from `api.cartesia.ai/voices`, ElevenLabs' are its own catalog IDs *interpolated
into the WebSocket URL path*, and Sarvam takes a fixed **speaker name** ("anushka", "shubh", …).
They are stored as a pair with the provider they were picked from (`org_agent_configs.voice_provider`
+ `voice_id`, from a picker already scoped to the selected provider). Every adapter then **fails open
on a foreign ID** — `voiceIdOverride || process.env.<PROVIDER>_VOICE_ID`, and Sarvam falls back again
to `DEFAULT_SPEAKER = "shubh"`. So the fallback either errored the turn outright or silently
synthesized in an env-default voice nobody chose.

**2. A failover was undone on the next turn.** One transient primary-provider error made turn *N*
speak in the fallback's voice and turn *N+1* flip straight back to the primary's. The caller heard
the agent become a different person and then change back — worse than either voice used
consistently.

**3. The cache learned the wrong voice.** `tts-cache.ts` is a process-global `Map` keyed on
`(provider, voiceId, language, text)`, and `speakCannedLine`/`warmFillerCache`/
`maybePlayToolCallFiller`/`maybePlayBackchannel` all computed that key from
`resolveTtsProvider(ttsProviderOverride, …)` — the *intended* provider — before synthesis. Audio a
fallback actually produced was therefore stored under the primary's key, so canned/filler/backchannel
lines replayed in a voice that did not match the live turns, for the rest of that call **and every
later call in the same process**.

ADR-060 already settled the principle for the language axis: *"a Sarvam Hindi speaker and a Cartesia
English voice are literally different voices — the caller would hear the agent become a different
person."* It rejected mid-call spoken-language switching on exactly that reasoning. Failover was
violating the same principle, just through a different door.

## Decision

**(a) A voice ID is only ever sent to the provider it belongs to.** New pure module
`voice/tts-voice-identity.ts` (`voiceIdForProvider`), used by `stream.ts` and
`test-call-stream.ts`'s simulated-failover path. A fallback provider gets **no** voice ID and uses
its own configured default voice — a known default beats an ID that provider cannot resolve. An
unknown owner is treated as a mismatch rather than guessed at.

**(b) Failover is sticky for the rest of the call.** `activeTtsProvider` tracks the provider the
caller is *currently* hearing: resolved once at `"start"`, then updated on every `attemptTts`. The
next turn starts from `activeTtsProvider`, not from the configured primary. The voice can therefore
change **at most once per call** instead of flip-flopping per turn.

The trade-off, stated plainly: a one-off blip on the primary provider now downgrades the *whole* call
to the fallback, where before it downgraded a single turn. That is deliberate — consistency of voice
identity is worth more than getting the preferred voice back mid-conversation, and the alternative to
a failover is not "the primary voice", it is a **dead turn** (failover only fires when the primary
errored *before any audio played*; once audio has played, the turn ends instead, unchanged).

**(c) Cache keys follow the audio, not the intention.** All tts-cache reads/writes go through one
helper (`currentTtsVoice()`) that returns the `(provider, voiceId)` pair actually in use. On the
canned-line path the key is re-read **after** speaking, so a line that itself failed over is stored
under the provider that produced it.

**(d) The call record reports the provider that actually spoke.** `calls.ttsProviderUsed` and the
per-call cost estimate now read `activeTtsProvider ?? ttsProviderOverride`. Previously both read the
*configured override*, so ADR-060's smart Indic default recorded `null` and a mid-call failover was
invisible in the data — the reported defect could not have been confirmed from the call record.

## Alternatives considered

- **Retry the same provider before failing over to another.** Rejected for now as a separate
  concern: it reduces how often the voice changes but does nothing about the two bugs above, and a
  same-provider retry on a socket that just hard-failed is the case the existing bounded-reconnect
  logic already covers on the STT side.
- **Refuse to fail over across providers at all** (end the turn instead, preserving voice identity
  absolutely). Rejected — dead air on a live call is worse than a one-time voice change, and it would
  discard the failover capability ADR-040's provider abstraction exists to provide.
- **Translate the voice ID across providers** (map "this Cartesia voice" to "the closest ElevenLabs
  voice"). Rejected as unfoundable: there is no cross-vendor voice-similarity mapping we could
  verify, and inventing one would be a guess shipped as a feature.
- **Key the cache on text alone.** Rejected — the whole point of the key is that the same sentence in
  a different voice is different audio.

## Consequence / scope shipped

- New: `voice/tts-voice-identity.ts` + `tts-voice-identity.test.ts`.
- `voice/stream.ts`: `ttsVoiceIdProvider` + `activeTtsProvider`, `currentTtsVoice()`, sticky
  `attemptTts(attemptProvider)`, all six tts-cache call sites, `ttsProviderUsed` + cost estimate.
- `voice/test-call-stream.ts`: the Preview drawer's simulated failover no longer carries the
  primary's voice ID onto the fallback, and now resolves the primary **with** the call's language
  (it was resolving the English-first default, so an Indic agent was shown a chain the real call
  would never take).
- New: `voice/stream-tts-voice-identity.test.ts` — drives the real stream state machine with a fake
  TTS provider that fails before emitting audio; all three defect tests fail without this change,
  and a fourth (healthy call stays on its configured provider and voice) passes either way.
- No DB migration, no schema change, no compliance-package change, no frontend change.
