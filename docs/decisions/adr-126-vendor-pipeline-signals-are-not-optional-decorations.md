---
adr: 126
title: "Vendor pipeline signals are not optional decorations"
date: 2026-09-05
status: Accepted
---

## ADR-126 — Vendor pipeline signals are not optional decorations
**Date:** 2026-09-05
**Status:** Accepted
**Relates to:** ADR-049 (telephony wire-format adapters), ADR-063 (end-of-turn),
ADR-083 (lazy TTS connect), ADR-125 (Cartesia buffer delay)

**Context:** After ADR-125, the cascade still ignored several signals the vendors
already send and we already requested:

| Signal | We had | Vendor meaning |
|---|---|---|
| Deepgram `is_final` chunks | Buffered only for `UtteranceEnd` | A long utterance is several finals; the last `speech_final` Results is often **only the tail** |
| Deepgram `vad_events=true` | Query param set, `SpeechStarted` dropped | Acoustic start of speech, before any words |
| Twilio `mark` / Plivo `checkpoint` | Unused | Playback finished this named chunk |
| Plivo `clearedAudio` | Parsed as `stop` | Barge-in buffer flush ack — **not** hangup |
| Cartesia `{ cancel: true }` | Unused; barge-in only `close()` | Drop unstarted generation on this `context_id` |
| Exotel codec | Always transcode PCM16 | Voicebot applet **defaults to mu-law**; L16 is opt-in |

Silence and hangup used `estimateRemainingPlaybackMs` (characters × 55ms) as if
it were a playback clock. Barge-in used only interim text (`decideBargeIn`).
Exotel default mu-law would have been decoded as PCM16 and sounded like noise.

Industry comparison (2026): Vapi/Retell/Pipecat use these same vendor events.
The gap is wiring, not architecture. Stay cascade.

**Decision:**

1. **Deepgram concat.** On `speech_final`, emit `pendingFinalText + last chunk`.
   Interims still pass through for barge-in. Empty concat is skipped.
2. **VAD is a streak hit, not a cut.** `SpeechStarted` → `{ vad: "speech_started" }`.
   `decideBargeIn` increments the short-fragment streak. It does **not** fire
   alone (a cough still trips VAD). VAD + one short interim reaches
   `BARGE_IN_STREAK_REQUIRED` one Deepgram frame earlier than two transcripts.
3. **Playback marks.** Twilio `mark` / Plivo `checkpoint` after a spoken turn.
   Ack re-arms the silence timer with 0 unplayed audio (unless hangup/transfer
   is pending). Closing line waits for the mark, capped at
   `min(estimate, CLOSING_LINE_MAX_WAIT_MS)`. Exotel has no mark — estimate only.
   Stale marks after barge-in are ignored (`pendingPlaybackMark` cleared).
4. **Plivo `clearedAudio` is `cleared`, not `stop`.** A barge-in must not hang up.
5. **Cartesia `cancel()`** before `close()` on barge-in. Optional on `TtsConnection`.
   Cancel only stops **unstarted** generation; already-playing audio still needs
   the telephony `clear` frame.
6. **Exotel default mu-law pass-through.** Transcode PCM16 only when `start`
   encoding is L16/linear. Fresh adapter per call so codec state cannot race.

**Rejected:**

- **Barge-in on `SpeechStarted` alone.** F5 cough/bleed would get worse.
- **Waiting only on marks, dropping the estimate.** Marks can be late or absent
  (Exotel, packet loss). Estimate remains the cap and the fallback.
- **Treating Cartesia cancel as a substitute for `close()`.** Cancel does not
  tear the socket; ADR-083 idle timeout still applies to an abandoned context.
- **Rewriting onto Pipecat/LiveKit/S2S** to "get these signals." They are
  already on the sockets we have.

**Consequences:** credit-card / long utterances reach the LLM whole; barge-in
can start counting before the first word; silence windows can shrink when the
carrier confirms playback; Plivo barge-in no longer looks like a hangup; Exotel
default calls stay μ-law. Operators still need a live Twilio re-test: look for
`event: mark` after a turn and no `DEAD AIR` on short replies (ADR-125). Plivo
and Exotel remain untested against a real account.
