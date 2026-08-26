# ADR-082: A transfer outranks a hang-up

- **Status:** Accepted
- **Date:** 2026-08-09
- **Supersedes:** nothing
- **Related:** ADR-062 (disclosure stamping), docs/audits/2026-08-09-audit-10-outbound-hangup.md (the silence-timer half of the "calls drop" family)

## Context

Production call 21 (2026-08-09, 54s, inbound, insurance appointment-setter)
was reported as "the call disconnects after the greeting". It did not
disconnect after the greeting. It disconnected at the handoff, which is worse.

Reconstructed from `transcripts` + `tool_calls` + `turn_latency`:

```
17:06:51  agent   greeting + AI/recording disclosure          turn 0  tts 1854ms  played
17:07:09  caller  "Yes."
17:07:10  agent   "...coverage for yourself, or someone in the family?"  turn 1  played
17:07:20  caller  "For myself."
17:07:23  TOOL    transferToHuman {reason: "warm appointment-setter handoff"}
17:07:25  TOOL    hangUp          {reason: "caller said goodbye"}
17:07:26  agent   "Perfect. Let me connect you with a licensed advisor right now..."  played
17:07:37  caller  "Okay."
17:07:38  TOOL    transferToHuman + crmSync + setDisposition + hangUp   (same turn)
17:07:39  agent   "OK."                                       turn 3  tts NULL  never played
17:07:42  call ends -- status completed, health degraded, disposition booked
```

The model emitted `transferToHuman` and `hangUp` **in the same turn, twice**.
`speak()` resolved that tie as:

```ts
if (pendingHangUp) {
  pendingHangUp = undefined;
  pendingTransfer = undefined;   // transfer silently discarded
  await performHangUp(ws, reason);
} else if (pendingTransfer) { ... }
```

So the caller was told "let me connect you with a licensed advisor right now",
said "Okay", and was hung up on. The call row says `completed` / `booked`. On
the dashboard this is a successful booking. It is a lost lead on the one turn
that is the entire commercial purpose of the insurance agents.

### Why the model does it, and why this is not a prompt bug

Two instructions are appended to every agent's frame (`agent.ts`), with no
mutual exclusion between them:

- "When the call is genuinely done (... caller said goodbye ...), say your
  closing line and call the hangUp tool in the same turn."
- "If the caller explicitly wants a person ... call transferToHuman in the same
  turn."

A caller answering "Okay" to a transfer offer satisfies both readings: it is
assent to the handoff *and* a conversation-ending pleasantry. The model's own
`hangUp` reason — `"caller said goodbye"` — shows it believed both, sincerely.
Nothing in the frame said they were exclusive, the tool layer did not prevent
the pair, and `stream.ts` resolved the ambiguity in the most destructive
direction available.

This is in the shared frame, not in any one prompt, so it affected **every
agent with transfer enabled, in every vertical**. Templates 06
(appointment-setter) and 09 (final-expense qualifier) both route their primary
success path through `transferToHuman`, so both had their success path wired to
a coin flip.

## Decision

**1. When both are pending, the transfer wins.** The branch is inverted, and a
`console.warn` records the conflict with both reasons so it is greppable.

The asymmetry is the whole argument. A transfer *is* an ending — the caller
keeps talking, to a human. So:

- Honouring the transfer when the model meant "goodbye" costs one unnecessary
  bridged call to a human who says "hello?" and hangs up.
- Honouring the hangup when the model meant "handoff" drops a caller who was
  explicitly promised a person, seconds after the promise.

`performTransfer` already falls back to a hang-up when the org has no
`humanTransferNumber` configured, so the worst case of this change is exactly
the old behaviour. Asserted by test.

**2. A latched transfer makes `hangUp` a no-op for the rest of the call.**
`transferLatched` is set the moment `transferToHuman` is requested and is never
cleared. Precedence in `speak()` only sees conflicts *within* one turn; the
latch covers the ordering it cannot see, where the model requests a transfer on
one turn and a hangup on a later one while `performTransfer` is still bridging.

**3. The frame says so explicitly.** A prompt line now states that `hangUp`
must never be called in the same turn as `transferToHuman` nor after one, and
that a short "okay" following a handoff offer means *yes, take me to them* —
not goodbye. This is defence in depth, not the guarantee. The guarantee is (1)
and (2), because prompt instructions are advisory and this one is being given
to a model that already demonstrated it can hold both readings at once.

## Consequences

- The insurance warm-transfer path — templates 06 and 09, the primary revenue
  path for the vertical — stops dropping callers at the handoff.
- An unnecessary bridge to a human is now possible where previously an
  unnecessary hangup was certain. That is the trade accepted above.
- `disposition = booked` on a call that actually hung up remains in historical
  data. Call 21 is contaminated this way and should not be read as a booking.
- Four regression tests in `stream-hangup.test.ts` cover both tool orderings,
  the plain-hangup path (so the inverted branch cannot make `hangUp`
  unreachable), and the no-transfer-number fallback.

## Also fixed here: expressive delivery was dead in production

Found while sizing this work, same file, so it ships in the same commit.

`attemptTts` in `stream.ts` returns a wrapper object around the real TTS
connection — and that wrapper never included `setTone`. `sendTtsTextWithTone`
calls `tts?.setTone?.(emotion)`, so on **every live synthesized turn** the
optional call resolved to `undefined` and did nothing. The entire tone-tag /
expressive-delivery feature (Tier 1, 2026-07-17) has been inert in production
since it shipped. Cartesia's own `setTone` implementation is fine; the wrapper
simply never forwarded it.

It failed silently by design: the `?.` was deliberate so that a provider
without `setTone` no-ops instead of throwing, which is exactly what made this
invisible. No test caught it because the only path that exercises tone without
the wrapper is the cached-audio path, which sets `tts = null` and never calls
`setTone` at all. The wrapper now forwards `setTone` conditionally, preserving
the no-op for providers that genuinely lack it.

## Rejected: pinning TTS providers per template in this commit

The related request — Sarvam only for Shopify, Cartesia/ElevenLabs for US,
Cartesia only for insurance — was scoped as a small `seed.ts` config change and
is **not**. It is deferred, for two reasons.

**It does not fit the schema.** `voice_provider` and `tts_fallback_order` live
on `org_agent_configs` (per-org), not on `agent_templates`. Templates have no
such columns, and `org-queries.ts` creates configs with
`{ orgId, templateKey, enabled: true }` and nothing else — there is no
template-to-config inheritance for provider fields at all. Pinning a provider
per template therefore needs a migration (two columns on `agent_templates`),
seed wiring, and inheritance at config-creation time. That is a schema change,
not configuration.

**The proposed routing axis is wrong.** Vertical does not imply language.
Shopify is the global ecommerce vertical (WooCommerce/BigCommerce next), so
"Shopify implies Sarvam" would give a US merchant's cart-recovery calls a
Hindi-voice agent; conversely the India insurance line (templates 04-08)
*should* get Sarvam. The correct axis is language/target market, which
`prefersSarvam()` in `agent-frame.ts` already implements.

What *is* a real finding: the platform default chain is
`["cartesia", "elevenlabs", "sarvam"]`, so Sarvam sits in the fallback tail of
every agent including US final-expense. Since `toSarvamLanguageCode` maps
everything to `*-IN`, a mid-call failover on a US bereavement call can hand the
caller an Indian-accented voice — and failover is *sticky for the rest of the
call* by design (see the voice-identity comment in `speak()`), so it does not
revert. Template 09 needs `cartesia` primary with `["elevenlabs"]` and Sarvam
excluded. Tracked as follow-up work with its own migration.
