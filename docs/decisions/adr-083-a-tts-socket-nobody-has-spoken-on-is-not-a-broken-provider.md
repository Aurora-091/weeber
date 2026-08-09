# ADR-083: A TTS socket nobody has spoken on is not a broken provider

- **Status:** Accepted
- **Date:** 2026-08-09
- **Supersedes / relates to:** ADR-082 (a transfer outranks a hangup) — same defect family, "the call went wrong and the logs said everything was fine"

## Context

The per-turn TTS websocket was opened at the top of every turn:

```ts
tts = attemptTts(primaryTtsProvider);   // stream.ts, before generate()
```

`generate()` then ran the LLM and any tool round-trips. On a turn with a tool
call that is seconds of wall-clock time during which the socket is open and has
been sent nothing. Both live providers hang up on an idle socket:

- Cartesia — close code `1000`, `connection idle timeout`
- Sarvam — close code `408`, `Websocket was left open without any messages for too long.`

That close arrived at the connection's `onError`, which had no way to tell
"this provider is broken" from "we connected before we had anything to say". It
therefore did the full failure ritual:

1. `ttsFailoverChain.shift()` — permanently burned a link off this call's chain
2. `recordProviderFailover()` — logged a provider fault that never happened
3. reassigned `activeTtsProvider`, which is **sticky for the rest of the call**
   by deliberate design (ADR in `stream-tts-voice-identity.test.ts`: rebuilding
   from the primary each turn makes a transient error flip the voice back and
   forth)

The compounding effect is the part that matters. The default TTS chain is
`["cartesia", "elevenlabs", "sarvam"]` and `toSarvamLanguageCode` forces an
`*-IN` locale. So on a US call, two idle timeouts — from two ordinary tool-using
turns, with every provider perfectly healthy — walk the caller down to Sarvam's
Indian-accented default voice, and leave them there for the remainder of the
call. `sentTextBuffer` replays as empty, so there is nothing in the replay path
to make this visible either.

The first vertical this lands on is US final-expense insurance: a bereavement
call to an elderly caller, where the agent's voice silently changing identity
mid-conversation is not a cosmetic defect.

## Decision

**1. Connect on first text, not at the top of the turn.** `tts` is now a facade
with the same `TtsConnection` shape that instantiates the real connection inside
`sendText`. Every call site already went through `tts?.`, so this is a drop-in
change with no call-site edits. The socket now opens when there is something to
synthesize — which is when the provider expects it.

Consequences handled by the facade:

- `setTone` is contractually called *before* any `sendText`. A tone parsed
  before the socket exists is buffered in `pendingTone` and applied on connect,
  so expressive delivery still applies to the turn it belongs to. (This method
  being silently absent was the ADR-082 bug; it is not being re-broken here.)
- `endTurn()` / `close()` against a turn that never produced text — aborted
  mid-generate, or a pure tool turn — no longer wait on a provider `onDone`
  that can never arrive. They release the `ttsDone` waiter directly instead of
  letting it burn its full 8s `Promise.race` timeout.

**2. An error on a socket that was never handed text is not a provider fault.**
Each connection tracks `textReachedProvider`. When `onError` fires with that
false, we log at warn, drop the dead socket, and let the next `sendText`
transparently reconnect to the *same* provider. No chain burn, no
`recordProviderFailover`, no sticky voice flip. A failure after text was sent is
untouched and still fails over exactly as before.

This second rule is defence in depth rather than the primary fix — lazy connect
closes the wide window on its own — but it is the correct rule regardless, and
it is reachable: a provider is free to report failure synchronously from inside
`connectTts`, before it has returned. That ordering also forced the `wrapper`
binding to become a `let` declared above `connectTts`; as a `const` initialized
below it, `onError` closing over it would hit a temporal-dead-zone throw at
precisely the moment we are trying to recover from a failure.

## Consequences

- Time-to-first-audio is unchanged in the good case. The socket handshake now
  overlaps with the first text rather than with the LLM, so on a fast turn there
  is a small handshake cost that was previously paid during LLM latency. Not
  measured; if it shows up in `tts_first_byte_ms`, the fix is to pre-warm on
  first LLM delta rather than to revert to connecting before generate().
- The failover chain now means what it says: a burned link corresponds to a real
  provider fault. `recordProviderFailover` becomes a usable health signal
  instead of a count that is mostly idle timeouts.
- `provider_failover` counts will drop sharply. That is the bug leaving, not
  reliability regressing — do not read the delta as a regression.

## What this does not fix

- **The US/India provider split.** Sarvam remains in the default chain tail for
  US calls, and `toSarvamLanguageCode` still forces `*-IN`. A genuine
  Cartesia + ElevenLabs double failure on a US call still lands an Indian voice
  on the caller. Pinning one org was explicitly rejected as the wrong axis:
  vertical is not language, and a per-org row does not generalise. The real fix
  routes the chain on the call's language/region. Deferred, tracked separately.
- **Sticky failover itself is unchanged** and still correct — ADR-082's
  reasoning stands; this ADR only stops it triggering on non-events.

## Tests

`packages/api/src/voice/stream-tts-lazy-connect.test.ts` (4 tests), driving the
real `createVoiceStreamHandlers` with a provider fake:

- no socket is opened while a turn is still blocked on its tool round-trip, and
  exactly one opens when text starts streaming
- a synchronous connect failure keeps the configured provider and voice, and
  never dials `elevenlabs`
- a failure *after* text still fails over to `elevenlabs` with no voice ID
  (regression guard: the carve-out must not swallow real faults)
- a turn that ends with no text does not stall on the 8s `ttsDone` timeout

Full suite green at 1144 pass / 0 fail.
