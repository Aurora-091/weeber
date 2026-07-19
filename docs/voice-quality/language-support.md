# Language support — what actually works, and which provider handles what

_Last updated 2026-07-19. See ADR-060 for the decision record behind the smart routing described here,
and [`hindi-hinglish-voice-support.md`](./hindi-hinglish-voice-support.md) for the deeper Hindi/Hinglish
quality work this builds on._

## The short version

Weeber is **not** an English/Hindi-only pipeline, and never was at the schema level. An agent's
`language` (agent-frame.ts) is **open free text** — any language a provider supports can be tried
without a code change. The curated `RECOMMENDED_LANGUAGES` list is a starting point, not a fence.

What was actually missing (and is now fixed): when you picked an Indic language but *didn't* also
pick a provider, the call stayed on the English-first platform default (Deepgram STT / Cartesia TTS),
which under-performs on Indic speech and voices. It now smart-defaults to **Sarvam** for those
languages. See "Smart provider default" below.

## What "multi-language support" means here — three distinct things

1. **Understanding the caller (STT).** Multilingual and, for code-switching, automatic:
   - **Deepgram `multi`** — English + one auto-detected other language, mid-sentence.
   - **Sarvam `codemix`** — India-tuned code-switching (keeps English loanwords in Latin script
     instead of transliterating them into Devanagari).
   - **ElevenLabs Scribe v2 Realtime** — Indic-English code-switching, live-verified (see the
     Hindi/Hinglish doc).
   This is free and already on. A caller mixing Hindi and English mid-sentence is handled.

2. **Speaking to the caller (TTS).** Multilingual-*capable*, but **not** auto-switching — you pass
   **one** language per synthesis call. Sarvam voices are language-agnostic speakers mapped via
   `${lang}-IN`; ElevenLabs/Cartesia take an explicit `language`. The agent speaks **one fixed
   language for the whole call**.

3. **Switching the spoken language mid-call.** **Deliberately not built** — and that's correct, not
   a gap. See "Why no mid-call spoken-language switching" below.

## Provider-by-language cheat sheet

| Language | STT default (no explicit choice) | TTS default (no explicit choice) | Notes |
|---|---|---|---|
| English (`en`) | Deepgram | Cartesia | Platform default, unchanged. |
| Hindi (`hi`) | **Sarvam** | **Sarvam** | Hinglish: also strong on ElevenLabs Scribe (STT) + Cartesia/ElevenLabs (TTS) — see Hindi doc. |
| Marathi, Tamil, Telugu, Kannada, Malayalam, Bengali, Gujarati, Punjabi (`mr`,`ta`,`te`,`kn`,`ml`,`bn`,`gu`,`pa`) | **Sarvam** | **Sarvam** | India-specialized; smart-defaulted (see below). |
| `multi` | Deepgram | (pick a specific language) | `multi` is Deepgram's own code-switching STT mode — stays on Deepgram. No single "auto" TTS voice exists; set a specific TTS language. |
| Anything else (free text) | Deepgram | Cartesia | Try any language a provider supports; override the provider per agent if the default isn't right. |

Any of these can be overridden per agent (frame `sttProvider` / `voiceProvider`), per number, or per
session — an explicit choice always wins.

## Smart provider default (2026-07-19)

`resolveSttProvider(override, language)` and `resolveTtsProvider(override, language)` now apply this
precedence:

1. **Explicit provider choice wins** — per-agent frame, per-number, session, or a mid-call failover
   target. Untouched.
2. **Indic smart default** — if nothing above is set and `language` is in `SARVAM_PREFERRED_LANGUAGES`
   (`hi, mr, ta, te, kn, ml, bn, gu, pa` — i.e. `RECOMMENDED_LANGUAGES` minus `en` and `multi`), route
   to **Sarvam** (India-specialized) instead of the English-first platform default. **Guarded by
   `SARVAM_API_KEY` being set** — no key, no re-route, clean fallback for self-hosted setups.
3. **Platform default** — `STT_PROVIDER` env → Deepgram; `TTS_PROVIDER` env → Cartesia.

The smart default beats the *global env default* (the call's language is a more specific signal than a
platform-wide fallback) but never an *explicit* per-agent/number/session choice.

Helper lives in `agent-frame.ts` (`SARVAM_PREFERRED_LANGUAGES`, `prefersSarvam()`) so the STT and TTS
resolvers stay in sync. Threaded through `connectStt`/`connectTts` and every direct resolver call site
in `stream.ts` / `test-call-stream.ts`. Covered by `stt/index.test.ts` and `tts/index.test.ts`.

## Why no mid-call spoken-language switching

The agent's spoken language is fixed per call **on purpose**:

- **Voice identity** — a Sarvam Hindi speaker and a Cartesia English voice are literally different
  voices. Flipping mid-call makes the agent sound like a different person, which is worse than
  speaking one consistent language.
- **Latency** — switching provider/voice mid-stream means re-initializing the TTS connection mid-call.
- **Stability** — more moving parts mid-call = more ways for a live call to break.

The natural, correct behavior for Indian callers is a single agent that **speaks one consistent
language** while **understanding** code-switching (point 1 above). "Dynamic mid-call language
switching" is therefore an anti-feature, not a roadmap item — do not reintroduce it, and do not claim
it in marketing/pitch copy.

## Prerequisites for Indic languages to actually work in an environment

- `SARVAM_API_KEY` must be set (Weeber prod: live as of 2026-07-19). Without it, Indic languages fall
  back to the English-first default and `config-check.ts` warns if a Sarvam provider is selected
  without a key.
- Everything else is code-side and already shipped — no per-language config, no schema change.
