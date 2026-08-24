# Provider and model currency — what's shipped since this codebase pinned its versions

- **Date:** 2026-08-25
- **Source:** external research (web search, cited inline per finding) cross-referenced against the exact
  model/version strings pinned in `main` @ `230c07d`
- **Scope:** the four external providers this codebase talks to (Deepgram STT, ElevenLabs TTS, Cartesia
  TTS, Sarvam STT/TTS) plus LLM model choice, checked for what's shipped since integration that this
  codebase hasn't adopted
- **Class:** dated point-in-time artifact (ADR-118 class 2) — a research reference, not a plan.
  Deliberately **not** filed into `docs/plans/phase-d-conversation.md` or any A-E phase: this is
  opportunistic infrastructure currency, evaluated on its own merits whenever it's picked up, not audit-
  driven work with a named production defect behind it. Forcing it into the phase structure would blur
  that distinction. See `2026-08-25-pipeline-edge-cases-research.md` for the conversation-behavior
  findings from the same research pass, which *were* filed into Phase D because they trace to named
  audit findings and existing code mechanisms.

## What's pinned today, and what's shipped since

| Provider | Pinned in this codebase | Current as of this research | Where pinned |
|---|---|---|---|
| Deepgram (STT) | `nova-3` | **Flux** and **Flux Multilingual** (GA) | `stt/deepgram.ts:91` |
| Cartesia (TTS) | `sonic-3` | **Sonic-3.6** (beta, GA imminent) | `tts/cartesia.ts:133` |
| Sarvam (STT) | `saaras:v3` | **Saaras v4** (GA) | `stt/sarvam.ts:137` |
| LLM (default) | `gateway/google/gemini-3.1-flash-lite` | still current-generation | `llm/`, confirmed live in production data |
| LLM (dark, ADR-109) | `direct:groq/llama-3.3-70b-versatile` | a **tool-use-tuned variant** exists | `llm/transport-chain.ts` |

## Deepgram — Flux is a different architecture, not a version bump

Flux (STT) and Flux TTS are Deepgram's **conversation-native** models — not nova-3 with new flags, a
different model built around the turn-taking problem directly:

- **Flux Multilingual** (GA, expanded to 10 languages including Hindi as of the 2026-04-29 release):
  language detection, **code-switching, turn detection, and interruption handling all run natively
  through a single streaming connection** — the exact three mechanisms this codebase currently hand-rolls
  separately (`toDeepgramNova3Language`'s `multi` routing, `turn-detection/heuristic.ts`'s
  `endsMidThought`, `barge-in.ts`'s streak-gated `decideBargeIn`).
- **Voice Agent API's `auto_language_detection`**: configure TTS voices per language, and the agent
  routes to the matching voice based on what Flux detects — this codebase currently does that manually via
  `prefersSarvam(language)` + per-provider voice resolution.
- **Flux TTS** (GA, free through 2026-09-12 up to 45 concurrent streams): a conversation-aware TTS model
  released as the "listening → turn detection → generated speech" pipeline's speech half — meaning
  Deepgram now offers STT+TTS from one vendor with native shared turn-taking state, an architecture this
  codebase's cascade (Deepgram STT + separate Cartesia/ElevenLabs/Sarvam TTS) doesn't have.

**Why this matters for Phase D specifically:** D6 (dictation-sequence endpointing) and part of D7/D8
propose building semantic/sequence-aware turn detection as custom heuristics on top of nova-3's plain
acoustic signal. If Flux's native turn detection already handles dictated sequences correctly — untested
here, not confirmed — some of D6's hand-built heuristic work could be a migration decision instead of a
build decision. **Not recommended to switch mid-Phase-D** without measurement: this codebase's own plan
docs are emphatic that provider/architecture swaps need their own ADR and their own before/after data
(see Phase C's explicit refusal to revisit the cascade architecture on assumption rather than evidence).
Flagging it as the first thing to *measure* before D6 is built as a from-scratch heuristic, not as a
decision made here.

## Cartesia — Sonic-3.6 ships native filler words and better Hinglish, 8 days before this research

Sonic-3.6 (beta 2026-08-17, GA "later in August" per Cartesia's own announcement) — released **while this
session's own work was in progress**:

- **#1 on both Artificial Analysis speech leaderboards** (Provider Voice and Controlled Voice) as of
  release.
- **"English with natural pauses and filler words"** as a stated model capability, plus **Hinglish
  code-switching between Hindi and English** — both directly relevant to D4 (filler lines) and this
  product's Hindi/Hinglish personas.
- Adds Odia and Urdu, bringing total language coverage to 44.

**Recommendation:** before building out D4's hand-cached filler-line/backchannel system further, run a
direct comparison — does asking Sonic-3.6 for a natural response (with the model's own pacing/fillers)
sound as good as or better than the cached-clip approach this codebase already has, for less engineering?
Sonic-3.6 is still beta at time of writing; not recommended to pin production to it before GA, but worth
evaluating on `sonic-preview` now so the comparison is ready when D4 is actually worked.

## Sarvam — Saaras v4 adds Global English; check whether it changes anything for this codebase's use

Saaras v4 (GA) sits alongside `saaras:v3` on the same REST/WebSocket/Batch endpoints, same five output
modes (`transcribe`, `translate`, `verbatim`, `translit`, `codemix`) this codebase already uses via
`stt/sarvam.ts`. The stated addition is **Global English** support alongside Indian English, on top of the
existing 22 Indic languages. Given this codebase's `prefersSarvam` routing is India/Indic-language-first
by design, this is a smaller, lower-urgency upgrade than the Deepgram/Cartesia items — same interface,
incremental language coverage. Sarvam also opened a self-serve Voice Agents builder (2026-08) and shipped
new LLMs (Sarvam-30B/105B, MoE architecture, 32K/128K context) — not evaluated here as an LLM option since
this codebase's LLM transport (`llm/`, ADR-109) is gateway/Groq-centric and a Sarvam LLM swap would be a
much larger architectural conversation than a model-version bump.

## LLM model choice — this codebase is already on a small/cheap tier; one specific swap worth naming

The question "what smaller models can we use instead of GPT-4-mini/Gemini Flash" has a starting-point
answer worth being explicit about: **this codebase is already on `gemini-3.1-flash-lite`** (confirmed
live in the 2026-08-25 production data read, `llm_provider_used` uniform across all 10 calls) — the
cost/speed tier the research below recommends, not GPT-4-mini. There is limited headroom to go
meaningfully cheaper on the *default* path without a real accuracy tradeoff; 2026 buyer's-guide consensus
(Retell, Layer3, Murf, others) puts Gemini Flash/Flash-Lite and `gpt-realtime-2.1-mini`/Claude Haiku 4.5
as the current cost floor for production-grade tool-calling voice agents, and this codebase is already at
that floor on the default path.

**One concrete, specific opportunity, not a general "go cheaper" recommendation:** ADR-109's dark
(`LLM_TRANSPORT_FAILOVER`, off everywhere) direct-Groq path is pinned to
`llama-3.3-70b-versatile`, chosen for cross-transport failover, not for tool-calling accuracy. A
tool-use-tuned variant exists on Groq's own infrastructure — `Llama-3-Groq-70B-Tool-Use`, benchmarked at
90.76% on the Berkeley Function-Calling Leaderboard — that could be a straight swap on the same transport
(same LPU speed characteristics, ~180ms median TTFT, 250+ tok/s on 70B-class models) for a model actually
tuned toward this codebase's own heaviest per-turn workload (tool calling). Worth a measured comparison
before the ADR-109 flag is ever turned on for real, not before.

## What this changes

Nothing shipped. Three follow-ups worth doing before or alongside Phase D work, none blocking it:

1. **Measure Deepgram Flux's native turn-detection against this codebase's dictation-cutoff scenario
   (D6) before building a from-scratch heuristic for it** — if Flux already solves it, D6 becomes a
   provider-migration decision with its own ADR, not new heuristic code.
2. **Run a Sonic-3.6-vs-cached-clips comparison for filler naturalness (D4)** before investing further in
   the hand-built filler-audio-cache path.
3. **If ADR-109's direct-Groq path is ever turned on, benchmark `Llama-3-Groq-70B-Tool-Use` against
   `llama-3.3-70b-versatile`** on this codebase's actual tool set first — a same-infrastructure swap with
   a plausible accuracy win on the workload that matters most for this product.

None of these are scheduled into a phase — they're prerequisites-to-check, not committed work.
