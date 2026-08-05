# ADR-072: A provider contract is what the server accepts, not what its docs say — and a provider that hears nothing must not be treated as healthy

- **Date:** 2026-08-05
- **Status:** Accepted
- **Supersedes / relates to:** ADR-060 (Indic-language calls smart-default to Sarvam), ADR-042 (voice pipeline seams)

## Context

Reported defect: **the Hindi agent is not listening.** The agent greets the caller, the caller speaks,
and nothing happens — no reply, no error, no failover. The call stays up until the silence timer or the
duration cap ends it.

This was reproduced locally without placing a phone call. Sarvam TTS synthesized the same Hinglish
sentence used in the 2026-07-16 Hindi/Hinglish work ("मुझे एक flight book करनी है, aur mera order भी
confirm karna hai.") at 8kHz mu-law — Twilio's exact wire format — and the resulting 3.71s / 29,700-byte
buffer was streamed through the **real** adapters in 160-byte / 20ms frames at real-time pace, exactly as
a Twilio Media Stream delivers it, followed by mu-law silence frames (`0xFF`) because a real stream never
stops sending and every provider's endpointing depends on that.

Result, before this change:

| Config | connected | errors | heard |
|---|---|---|---|
| Sarvam, `language=hi` | 906ms | none | **nothing** |
| Sarvam, `language=hinglish` | 890ms | none | **nothing** |
| Deepgram, `language=hi` | 132ms | none | full transcript |
| Deepgram, `language=hinglish` | **never** | reconnects exhausted | **nothing** |
| Deepgram, `language=multi` | 116ms | none | full transcript |

Two independent root causes, one per provider, both landing on the same symptom.

### 1. Sarvam was sent a wire format it silently refuses to decode

`stt/sarvam.ts` declared `input_audio_codec=pcm_s16le` at connection time (raw PCM) while `sendAudio`
sent `mulawChunkToWavBase64(...)` — a full 44-byte RIFF/WAVE header plus payload **in every 20ms frame**,
where the header is ~12% of the bytes. The two statements contradicted each other and Sarvam resolved the
contradiction by returning nothing at all.

All four combinations were tested against the real endpoint with the real audio:

| Connection codec | Per-frame payload | `sample_rate`/`encoding` fields | Result |
|---|---|---|---|
| `pcm_s16le` | WAV container | present | **no transcript, no error** (what shipped) |
| `wav` | WAV container | present | **no transcript, no error** |
| `pcm_s16le` | raw PCM16LE | omitted | rejected: `2 validation errors ... audio.encoding Field required` |
| `pcm_s16le` | raw PCM16LE | present | **correct code-mixed transcript** |

The last row is now what we send. Note what that means: `encoding: "audio/wav"` is a **required field
whose value is ignored** — the bytes beside it are bare PCM16LE. Sarvam's own AsyncAPI spec calls the
per-message `sample_rate` legacy and says "8kHz is only supported via connection parameter, not in
AudioData messages", while simultaneously marking both fields required — there is no spec-legal way to
describe an 8kHz stream. Reading the docs alone, the natural fix (drop the legacy fields) is the one
combination that fails outright.

**Why the 2026-07-16 "live-verified" note in `docs/voice-quality/hindi-hinglish-voice-support.md` did not
catch this:** that test streamed the audio as large buffers, where one 44-byte header per multi-second
chunk is negligible. The bug only exists at Twilio's frame size. A live-test harness that doesn't
reproduce the production frame cadence can validate a broken adapter.

### 2. Deepgram was sent a language code that prevents the socket from opening

`stt/deepgram.ts` forwarded any non-`en` language verbatim. Handshake results against `model=nova-3`,
by HTTP status (authoritative, via `curl --http1.1`):

- **101 accepted:** `hi`, `mr`, `ta`, `te`, `kn`, `bn`, `gu`, `pa`, `multi`
- **400 rejected:** `hinglish`, `ml`, `hi-IN`

`hinglish` and `ml` both ship in `RECOMMENDED_LANGUAGES`, so both were reachable from the agent config
UI. A rejected code means the WebSocket never opens, the bounded reconnect burns all three attempts, and
the call is deaf for its entire duration.

This also **corrects** the module's own doc comment, which claimed "nova-3 supports most single Indian
languages directly (e.g. hi, mr, ta)" and implied the rest were fine too. `mr`/`ta` are fine; `ml` is not.

### 3. `hinglish` never had a Sarvam language code

`toSarvamLanguageCode` derived `${language}-IN` blindly, producing `hinglish-IN`. Sarvam accepts the
socket, then rejects the request mid-stream and closes. Both `stt/sarvam.ts`'s module doc and
`agent-frame.ts`'s `SARVAM_PREFERRED_LANGUAGES` comment **claimed** it mapped to `hi-IN`; only
`tts/sarvam.ts` actually did. The comment described an intention no code implemented.

### 4. A deaf provider reported itself healthy

`msg.type === "error"` in `stt/sarvam.ts` was a bare `console.error`. STT failover works and is wired
(`stream.ts` `connectSttForCall(ws, next)`) — it just was never told. A server-side rejection therefore
produced a call that stayed up, kept billing LLM/TTS, and could never hear anything, instead of failing
over to Deepgram or ElevenLabs.

## Decision

1. **Send Sarvam raw PCM16LE base64 and keep its required-but-ignored legacy fields.** New
   `mulawChunkToPcm16Base64` in `audio-codec.ts`; `mulawChunkToWavBase64` stays for any future provider
   that genuinely wants a container. The exact combination and the three that fail are documented in the
   adapter's module comment so nobody "cleans it up" back into silence.
2. **Never send a provider a language code it rejects.** Both adapters now normalize against an
   allow-list derived from live handshakes, not from docs: `toSarvamLanguageCode` falls back to
   `unknown` (Sarvam's auto-detect, verified to transcribe the same Hinglish audio correctly) and
   `toDeepgramNova3Language` falls back to `multi`. Degraded recognition beats a socket that never opens.
3. **`hinglish` maps to `hi-IN` on Sarvam and `multi` on Deepgram** — matching what the comments already
   claimed, and keeping the shipped UI option honest.
4. **A provider that reports an error loses the call.** Sarvam `error` messages escalate to
   `onFatalError`, so the existing STT failover chain engages. A permanently deaf call is a failure, not
   a quiet state.
5. **Buffer audio while Sarvam is connecting.** Sarvam's connect measured ~900ms–1.2s versus Deepgram's
   ~130ms, and `sendAudio` dropped every frame until `open`. It now holds a bounded 2s tail and flushes
   on open, mirroring `stt/deepgram.ts`'s reconnect buffer.

## Consequences

Same harness, after the change — every path hears the caller and produces a turn-final:

| Config | connected | heard |
|---|---|---|
| Sarvam, `language=hi` | 1197ms | `F:मुझे एक flight book करनी है` `F:और मेरा order भी confirm करना है` |
| Sarvam, `language=hinglish` | 901ms | `F:मुझे एक flight book करनी है` `F:और मेरा order भी confirm करना है` |
| Deepgram, `language=hi` | 159ms | interims + `F:...confirm करना है.` |
| Deepgram, `language=hinglish` | 126ms | interims + `F:...confirm करना है.` |
| Deepgram, `language=multi` | 80ms | interims + `F:...confirm करना है.` |

English words stay in Latin script and Hindi in Devanagari, which is the `codemix` behaviour ADR-060 and
the Phase 2.5 work intended and could not deliver while the audio never arrived.

**Malayalam is now honest rather than broken:** with `SARVAM_API_KEY` set, `resolveSttProvider` routes it
to Sarvam (`ml-IN` is in Sarvam's enum). Without a Sarvam key it lands on Deepgram `multi`, which is a
real degradation — Malayalam is not one of Deepgram's multilingual languages — but it connects and can
report transcripts rather than being silently deaf. If Malayalam becomes a real requirement it needs
Sarvam, not a Deepgram flag.

**What is still unverified:** none of this was observed on a live PSTN call. The audio path tested here is
byte-identical to Twilio's (8kHz mu-law, 160-byte frames, real-time pace) and exercises the real adapter
code, but the first real Hindi call should still be checked. Which provider that call uses depends on
whether `SARVAM_API_KEY` is set in Railway — both paths are fixed, so the answer no longer decides
whether Hindi works, only which of the two fixes is exercised first.

**Process consequence:** two of the three "known" root causes carried into this session from code reading
alone were wrong — Deepgram was believed to reject `mr`/`ta`/`te`/`kn`/`bn`/`gu`/`pa` (it accepts all of
them), and Sarvam was believed to reject `hinglish-IN` at handshake (it accepts the socket, then fails the
request). Provider behaviour was settled by probing the real endpoint. Where a provider's docs and its
server disagree, the server wins and the disagreement gets written down.
