# Hindi / Hinglish Voice Support — Plan & Progress

Started 2026-07-16. Tracks the work to make Hindi/Hinglish agents actually good, not just
"technically has a language dropdown entry."

## Why this exists

Hinglish (Hindi-English code-switching) is how most urban Indian callers actually speak — not a
dialect, a genuine code-mixing register, switching between languages at the sentence, phrase, and
even word level ("adjust-karo", "driving-wala"). Monolingual STT/TTS treats this as noise, not
signal. Documented WER on identical Hindi-English code-switched audio ranges from ~27% to ~70%
across different models/modes — the gap between "works" and "unusable" is which provider/mode you
pick, not fine-tuning.

Our `RECOMMENDED_LANGUAGES` list (agent-frame.ts) has `"hi"` (Hindi) and `"multi"` (Deepgram-only
English + one auto-detected other), but no real Hinglish option, and the two TTS providers we
already use (ElevenLabs, Cartesia) were being used at a fraction of their real capability for this.

## Decision: lean into ElevenLabs/Cartesia's own features, not a third vendor

Original plan (first pass) was Sarvam-first, since Sarvam is India-first and has an explicit
`codemix` STT mode. Reconsidered per direct steer: maximize what ElevenLabs/Cartesia (providers we
already bill and use for TTS) can do natively before reaching for a third vendor.

**Research findings that changed the plan:**
- **ElevenLabs Scribe v2 Realtime** (their streaming STT): WebSocket, ~150ms latency, native
  mu-law 8kHz + PCM 8-48kHz (drops straight into our existing Twilio pipeline, same as our TTS
  adapters already do — zero re-encoding). Ships an explicit **"Indic-English code-switching"**
  feature: English words stay in Latin script automatically regardless of surrounding language, no
  config needed, works across Hindi/Telugu/Kannada etc. Independent benchmark (coval.ai) rates it
  ~35% better at code-switching than the nearest competitor. Also has keyterm prompting up to 1,000
  terms (order IDs, "COD", "UPI", merchant/product names).
- **Deepgram's `multi` mode** (what we default to today for code-switching) has a real, open
  complaint on Deepgram's own GitHub discussions: Nova-3 multi "many times is detecting Hindi as
  Spanish, ruining the whole [transcript]." Not reliable for Hindi specifically, despite being
  marketed for code-switching generally.
- **Cartesia Sonic** markets native Hinglish voices and is the fastest TTS in the market (sub-90ms
  TTFA) — a strong low-latency TTS alternative to ElevenLabs for this. Their STT (Ink-Whisper)
  supports Hindi as one of 15 languages but has no explicit code-switching claim like Scribe does —
  not the STT pick, still a good TTS pick.
- **Sarvam** stays wired, not removed — still the better call for other Indic languages (Tamil,
  Telugu, Bengali, etc.) where it's already proven. Just no longer the *default* recommendation for
  Hindi/Hinglish specifically.

**One thing flagged as unverified, not assumed:** ElevenLabs' "Indic-English code-switching" blog
post covers "Scribe v2" (the batch/file model). I did not find explicit confirmation the same
improvement is identically present in "Scribe v2 Realtime" (the streaming variant we'd actually
wire in) — marketing bundles them together, but this needs a real test call before the Realtime STT
adapter becomes the default, not just taken on faith.

## Concrete gaps found in our own code (before this work)

- `tts/elevenlabs.ts`: hardcoded to `model_id=eleven_flash_v2_5`, **never accepted a `language`
  argument at all** (function signature only had 4 params), no pronunciation-dictionary wiring.
- `tts/cartesia.ts`: received the call's configured language as `_language` and **discarded it** —
  never sent to Cartesia despite Cartesia's own Generation Request schema having a top-level
  `language` field (confirmed against `docs.cartesia.ai/api-reference/tts/websocket`).
- `stt/sarvam.ts`: hardcoded to `mode: "transcribe"` instead of Sarvam's own `mode: "codemix"` —
  **fixed and live-verified, see "Phase 2.5" below.**
- No STT adapter for ElevenLabs or Cartesia existed at all — STT providers were Deepgram + Sarvam
  only.

## Plan

### Phase 1 — Fix what's already wired but unused (DONE, 2026-07-16)
- [x] `tts/elevenlabs.ts`: accept the `language` argument, append `&language_code=` to the
  WebSocket connection URL when set (ElevenLabs' own documented query param — "ISO 639-1 language
  code, for specific models"). Never forwards `"multi"` (Deepgram's own STT-only code-switching
  mode, not a real language).
- [x] `tts/cartesia.ts`: actually send the `language` field in both the `sendText`/`endTurn`
  Generation Request payloads instead of discarding it. Same `"multi"` guard.
- [x] `tts/types.ts`: corrected the `ConnectTts` doc comment, which previously (and incorrectly)
  claimed both providers ignore `language`.
- [x] Test coverage: `tts/language-passthrough.test.ts` (6 tests, all passing) — first-ever test
  coverage for either adapter's URL/payload construction, using a minimal mocked `WebSocket`.
- [x] Verified: typecheck clean, oxlint 0/0, vite build green, backend suite 285 pass (was 279
  before this phase, +6 matches the new tests) / 38 fail (same as prior checkpoint, no new
  failures — confirmed none of the 6 new tests appear in the fail list).
- Commit: (see git log after this doc is committed)

### Phase 2 — Build the ElevenLabs Scribe v2 Realtime STT adapter (DONE + LIVE-VERIFIED, 2026-07-16)
- [x] `stt/elevenlabs.ts` — same `ConnectStt` shape as `stt/deepgram.ts`/`stt/sarvam.ts`, wired into
  `stt/index.ts`'s provider registry, `SttProvider` type, `agent-frame.ts`'s `sttProvider` enum,
  `agent.ts`'s `ResolvedAgentConfig`, and both `stream.ts`/`test-call-stream.ts` local override
  types. Also added an "ElevenLabs Scribe" option to both the merchant (`pages/app/agents.tsx`) and
  admin (`pages/dashboard/agents.tsx`) STT provider dropdowns so it's actually selectable end-to-end,
  not backend-only dead code.
- [x] Test coverage: `stt/elevenlabs.test.ts` (6 tests) — mocked-WebSocket coverage of connection
  URL/headers, `session_started` → `onConnected`, `partial_transcript`/`committed_transcript` →
  final/non-final, raw mu-law passthrough, and the close/commit sequence.
- [x] **Live-tested against a real ElevenLabs account and real Hinglish audio.** User provided a
  real API key; synthesized "मुझे एक flight book करनी है, aur mera order भी confirm karna hai."
  via ElevenLabs TTS, resampled to Twilio's exact 8kHz mu-law format, and streamed it through the
  actual `connectElevenLabsStt` code path (not a mock). Result:
  **"मुझे एक flight book करनी है और मेरा order भी confirm करना है।"** —
  flight/book/order/confirm all stayed in Latin script automatically, Hindi stayed in Devanagari.
  The Indic-English code-switching claim is confirmed real, not just marketing copy.
- [ ] Keyterm prompting for domain terms — still deferred (needs the actual term list, same
  reasoning as Phase 3's pronunciation dictionaries).

**Two real bugs found and fixed via the live test (would have shipped silently broken otherwise):**
1. **`audio_format`/`sample_rate` are connection-time query params, not per-message fields.** The
   first version of this adapter put `sample_rate: 8000` inside each `input_audio_chunk` message —
   the server silently ignored that and defaulted the whole session to 16kHz PCM regardless.
   Feeding 8kHz audio into a session that assumed 16kHz produced a corrupted waveform and nonsense
   transcripts (literally Korean-looking gibberish from the distorted audio), with **zero errors of
   any kind** — a real, silent-failure class of bug that only a live test could catch. Fixed by
   moving `sample_rate=8000&audio_format=ulaw_8000` onto the connection URL itself.
2. **`ulaw_8000` is a valid `audio_format`, confirmed directly from the server's own error message**
   enumerating valid values (`pcm_8000, pcm_16000, pcm_22050, pcm_24000, pcm_44100, pcm_48000,
   ulaw_8000`) — so the original defensive PCM16-decode step (taken because the mu-law option
   couldn't be confirmed from public docs alone) was unnecessary. Removed; Twilio's raw mu-law
   bytes now go straight over the wire, same zero-re-encoding path the TTS adapters already use.
3. **`close()` raced the server's response.** Sending `commit:true` and immediately calling
   `ws.close()` right after killed the connection before the server could send back the final
   `committed_transcript` — confirmed directly (identical commit message + immediate close = no
   transcript; same commit message + staying connected = transcript arrives ~1-2s later). Fixed
   with a 1.5s grace period between sending commit and actually closing the socket.

### Phase 2.5 — Sarvam `mode: "codemix"` fix (DONE + LIVE-VERIFIED, 2026-07-16)

User provided a real Sarvam API key too, to check whether the deprioritized `stt/sarvam.ts` fix
(hardcoded `mode: "transcribe"` instead of Sarvam's own `mode: "codemix"`) was actually worth doing,
now that live-testing had already caught two silent bugs in the ElevenLabs adapter.

Synthesized the same Hinglish sentence via Sarvam's own TTS ("मुझे एक flight book करनी है और मेरा
order भी confirm करना है।"), resampled to Twilio's 8kHz mu-law format, and streamed it through the
real `connectSarvamStt` code twice — once with each mode — to compare directly:

| Mode | Output |
|---|---|
| `transcribe` (the old default) | "order" → **"ऑर्डर"**, "confirm" → **"कन्फर्म"** — English loanwords phonetically transliterated into Devanagari |
| `codemix` | "order" and "confirm" **stayed in Latin script** — matches Sarvam's own docs guidance verbatim |

Sarvam's own docs say it plainly: *"Use codemix for chat/agent transcripts that feel natural,
transcribe for clean native-script records."* A live voice agent is squarely the "chat/agent
transcript" case — so `codemix` is the correct default, not a Hindi-only special case (it's about
English-loanword handling generally, applies to Sarvam's other 9 Indian languages the same way).

Fixed in `stt/sarvam.ts` (one-line mode change + doc comment explaining the live-tested rationale),
covered by new `stt/sarvam.test.ts` (2 tests — first-ever coverage for this adapter). Verified:
typecheck clean, oxlint 0/0, vite build green, backend suite 293 pass (was 291, +2 = the new
tests) / 38 fail (same baseline, no new failures).

### Phase 3 — Pronunciation dictionaries + domain terms (DONE + LIVE-VERIFIED, 2026-07-16)

**Wiring:** `tts/elevenlabs.ts` now includes `pronunciation_dictionary_locators` in the initial
WS handshake message (confirmed from ElevenLabs' own reference: this field belongs in the first
message, alongside `voice_settings`/`xi_api_key`, not as a query param) whenever both
`ELEVENLABS_PRONUNCIATION_DICTIONARY_ID` and `ELEVENLABS_PRONUNCIATION_DICTIONARY_VERSION_ID` are
set — omitted entirely otherwise, same no-op-by-default pattern as `language_code`. Covered by 3
new tests in `tts/language-passthrough.test.ts` (both-set / neither-set / only-one-set cases).

**Domain terms (decided with the user):** OTP, Weeber (brand name), COD, RTO, UPI, KYC, plus two
more added from research into common Indian fintech/e-commerce TTS mispronunciation issues — GST
and PIN code, both near-universal in COD-confirmation/order calls. All encoded as **alias rules**
(not phoneme rules) since alias rules work on every ElevenLabs model, while phoneme rules are
restricted to specific models — a real constraint found during the research, not assumed.

**Live-created and live-verified with the user's real ElevenLabs account:**
- Dictionary created via `POST /v1/pronunciation-dictionaries/add-from-rules`:
  `id: 3ygOtN1S5v8oM8eoBHvn`, `version_id: wid8pyPH48GSfGg73uFc`, 8 rules confirmed by the API's
  own response (`version_rules_num: 8`).
- **Direct before/after proof, not just a successful API call:** synthesized "Please confirm your
  COD order using OTP and UPI." twice — once without the dictionary, once with — then transcribed
  both back through the now-verified ElevenLabs Scribe STT adapter:
  - **Without the dictionary:** "Please confirm your **card** order using OTP and UPI." — COD was
    genuinely mispronounced/misheard as "card."
  - **With the dictionary:** "Please confirm your **COD** order using OTP and UPI." — correct.
  - This is exactly the failure mode the dictionary exists to prevent, caught and fixed with real
    evidence, not assumed to work because the create-dictionary API call returned 200.

**Action needed from the user (not done by me — Railway is intentionally out of scope per earlier
instruction):** set these two env vars on Railway to activate the dictionary in production:
```
ELEVENLABS_PRONUNCIATION_DICTIONARY_ID=3ygOtN1S5v8oM8eoBHvn
ELEVENLABS_PRONUNCIATION_DICTIONARY_VERSION_ID=wid8pyPH48GSfGg73uFc
```
Until these are set, the code path is a safe no-op — no behavior change for any existing deployment.

Verified: typecheck clean, oxlint 0/0, vite build green, backend suite 296 pass (was 293, +3 = the
new tests) / 38 fail (same baseline, no new failures). API key and all temporary test scripts
deleted from disk after testing.

### Phase 4 — Agents tab language option (NOT STARTED)
- [ ] Add a real **"Hindi (Hinglish)"** entry to `RECOMMENDED_LANGUAGES` (agent-frame.ts), distinct
  from plain `"hi"`.
- [ ] Selecting it should default `sttProvider: "elevenlabs"` (once Phase 2 ships) + an
  ElevenLabs/Cartesia TTS voice — not Sarvam — with a short UI explainer on why.
- [ ] Update the agents tab UI (packages/web) to surface the recommended provider pairing when this
  language is chosen, instead of leaving the org to guess at a combination that might silently
  underperform (e.g. Deepgram `multi` for Hindi).

## Status snapshot

| Phase | Status |
|---|---|
| 1 — Fix existing TTS adapters | ✅ Done, sanity-checked (fresh typecheck/test/lint/build all green) |
| 2 — ElevenLabs Scribe v2 Realtime STT adapter | ✅ Done, **live-verified with a real account and real Hinglish audio** — 2 real bugs found and fixed via that test (see above) |
| 2.5 — Sarvam `mode: codemix` fix | ✅ Done, **live-verified** — real before/after comparison confirmed the fix (see above) |
| 3 — Pronunciation dictionaries | ✅ Done, **live-created + live-verified** — real before/after COD mispronunciation fix confirmed. Needs env vars set on Railway (see above) to activate |
| 4 — Agents tab language option | Not started |
