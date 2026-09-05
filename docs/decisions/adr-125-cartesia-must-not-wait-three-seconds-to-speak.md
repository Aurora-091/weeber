---
adr: 125
title: "Cartesia must not wait three seconds to speak"
date: 2026-09-05
status: Accepted
---

## ADR-125 — Cartesia must not wait three seconds to speak
**Date:** 2026-09-05
**Status:** Accepted
**Relates to:** ADR-101 (tone-tag hold-back muted a short reply), ADR-083 (lazy TTS connect),
ADR-107 (TTS first-byte measurement)

**Context:** After ADR-124, the remaining live defect on the 2026-09-05 founder calls is
**appointment-setter turn 5**: the LLM produced 59 characters, TTS emitted **zero** audio bytes,
and `DEAD AIR` logged while the transcript still recorded the line as spoken. That is ADR-101's
class, not a hearing problem and not an empty hangUp.

The Cartesia websocket adapter streamed LLM deltas with `continue: true` and never set
`max_buffer_delay_ms`. Cartesia's generation schema **defaults that field to 3000ms**. Their own
buffering guide says that default is *managed* buffering: the server holds text until it has
enough context **or** the delay elapses. Their contexts guide also says a context expires about
**1 second** after the last audio output; if generation has not started yet, a 3s hold is long
enough for a short turn to die with nothing on the wire. Weeber forwards token-sized chunks, not
pre-aggregated sentences — exactly the shape they tell you to pair with an explicit short
`max_buffer_delay_ms`.

Industry comparison (2026): the cascade (Deepgram → LLM → Cartesia → Twilio) is the same recipe
as Vapi BYOK / Pipecat. The gap was this knob, not the architecture. Phase C1 (reuse the TTS
socket across turns) is a real ~200–270ms handshake cost; it does **not** explain zero bytes.
ADR-083 still forbids opening that socket before there is text, because Cartesia and Sarvam kill
an idle websocket during a tool round-trip and we used to treat that as a provider failover.

**Decision:**

1. Send `max_buffer_delay_ms: 180` on **every** Cartesia generation message on a context
   (continuations must keep fields other than `transcript`/`continue`/`duration` identical).
   180ms is managed buffering for token streaming: enough to gather a word, well under a 1s
   context window, 16× shorter than the omitted-field default.
2. `endTurn()` sends empty transcript, `continue: false`, **and** `flush: true` — the documented
   "I do not know the last token in advance" close.

**Rejected:**

- **`max_buffer_delay_ms: 0` (custom buffering).** Cartesia reserves 0 for callers who already
  aggregate sentences. We still push LLM deltas; 0 makes Sonic start on fragments and sounds
  choppy at token boundaries.
- **Leaving the 3000ms default and aggregating sentences in `stream.ts`.** Their docs call that
  the middle ground to avoid: you wait for a sentence *and* the server waits again.
- **TTS socket reuse this change.** Still Phase C1. Idle-timeout during tools (ADR-083) is
  unchanged; a keep-alive that actually resets Cartesia's *application* idle timer is unproven.
  Handshake delay produces late audio, not silent audio. Do not reopen ADR-083 to buy 250ms
  until buffering is live-verified.

**Consequences:** short Cartesia turns should start speaking within ~180ms of the first tokens
plus connect, and `endTurn` must force remaining buffer out. Operators still need a live
appointment-setter re-test after deploy: if turn-5-class dead air remains, the next suspects are
the tone-tag filter (ADR-101), a mid-call agent `PUT`, or a socket that never opened. `tts_first_byte_ms`
on Cartesia turns should drop versus the 3s-default era; do not pool those rows with pre-cutover
calls (same discipline as ADR-107).
