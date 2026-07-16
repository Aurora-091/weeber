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
- `stt/sarvam.ts`: hardcoded to `mode: "transcribe"` instead of Sarvam's own `mode: "codemix"` (not
  touched in this work since the plan no longer leans on Sarvam as the default — left as a known,
  low-priority fix if Sarvam is ever used for a non-Hindi Indic language agent).
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

### Phase 2 — Build the ElevenLabs Scribe v2 Realtime STT adapter (NOT STARTED)
- [ ] `stt/elevenlabs.ts` implementing the same `ConnectStt` shape as `stt/deepgram.ts`/
  `stt/sarvam.ts` — WebSocket streaming, mu-law 8kHz input (no re-encoding needed), wired into
  `stt/index.ts`'s provider registry.
- [ ] Wire ElevenLabs keyterm prompting for domain terms (order IDs, "COD", "UPI", merchant name)
  once the adapter exists — same mechanism Scribe already supports for STT, mirrors what
  pronunciation dictionaries do on the TTS side.
- [ ] **Verify the Indic-English code-switching claim empirically** with one real test call before
  treating Scribe v2 Realtime as reliable for Hindi/Hinglish — do not take the marketing claim on
  faith (see the caveat above).

### Phase 3 — Pronunciation dictionaries + domain terms (NOT STARTED)
- [ ] Create an ElevenLabs pronunciation dictionary with the org/product's actual domain terms
  (brand names, "COD", "UPI", city names as needed) and wire `pronunciation_dictionary_locators`
  into the TTS connection. This is a content/curation step (needs real terms decided with the
  user), not just a code change — do not build this blind.

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
| 1 — Fix existing TTS adapters | ✅ Done |
| 2 — ElevenLabs Scribe v2 Realtime STT adapter | Not started |
| 3 — Pronunciation dictionaries | Not started |
| 4 — Agents tab language option | Not started |
