# Provider currency deep dive — going past the first-pass research

- **Date:** 2026-08-25
- **Source:** external research (web search + official provider docs, cited inline), cross-referenced
  against this codebase's actual integration code (`packages/api/src/voice/stt/deepgram.ts`,
  `packages/api/src/voice/backchannel.ts`, `packages/api/src/voice/stream.ts`,
  `packages/api/src/llm/transport-chain.ts`)
- **Scope:** the three items `2026-08-25-provider-model-currency-research.md`'s "What this changes"
  section flagged as "worth measuring/checking before deciding" but never went deeper than a first-pass
  search on. This doc goes deeper on each and gives a real verdict.
- **Class:** dated point-in-time artifact (ADR-118 class 2) — a research reference, not a plan. Same
  reasoning as the doc this one follows up: opportunistic infrastructure currency, evaluated on its own
  merits, not filed into a phase.

## Summary

| Item | Verdict |
|---|---|
| Deepgram Flux vs Nova-3 | **Worth a live A/B test, not a blind swap.** Flux's turn-detection genuinely appears built to solve D6's exact scenario, and its `StartOfTurn`/`TurnResumed` events look like they'd replace D7's barge-in gating too — but it's a different API (`/v2/listen`), a different message shape (turn events, not `is_final`/`speech_final`), and it drops `smart_format`, which this codebase actively depends on (`deepgram.ts:96`). Real migration effort, not a config flag. |
| Cartesia Sonic-3.6 fillers | **Still undocumented, and the live test is now blocked, not just unrun.** `sonic-3.6` isn't a real `model_id` (Cartesia's live docs list `sonic-3`/`sonic-3.5`/`sonic-latest`), and this environment's `CARTESIA_API_KEY` is invalid against Cartesia's own API (confirmed directly, 401) — someone needs to rotate that credential before the hands-on test can run. A live ElevenLabs↔Deepgram round trip using this codebase's actual pins worked cleanly in the meantime, as an unrelated regression check. |
| Groq tool-use model swap | **Moot — the model is gone.** `Llama-3-Groq-70B-Tool-Use` does not appear in Groq's current (August 2026) model catalog or docs. The specific swap the prior research named is no longer available to make. |

---

## 1. Deepgram Flux — a real architecture change, not a version bump, and it targets D6/D7's exact problems

### Turn detection appears to solve D6's exact scenario

Deepgram's own comparison page and a third-party review both independently describe Flux distinguishing
"a user stumbling over a credit card number" (an incomplete, in-progress numeric sequence) from a
genuinely finished utterance — this is D6's `DictationSequenceDetector`
(`packages/api/src/voice/turn-detection/dictation.ts`) scenario, described unprompted by an outside
source, not something I asked about specifically. [Deepgram Flux Review, Auto Interview AI](https://www.autointerviewai.com/blog/deepgram-flux-semantic-end-of-turn-stt-review-2026)
No source discloses the actual mechanism (semantic model internals aren't published), so this can't be
verified as covering every case D6's regex heuristic covers (spelled letters, trailing hyphens) — only
that the general "mid-dictation pause" class is a named, marketed capability, not a happy accident.

### The turn-event model looks like it would also replace D7's barge-in gating

Flux's official migration doc describes four turn-state events, not the `is_final`/`speech_final`
flags this codebase's `ConnectStt` abstraction consumes today:

- **`StartOfTurn`** — explicitly documented as the signal to "interrupt active agent response."
- **`EagerEndOfTurn`** — medium-confidence, begin the LLM reply early (~260ms p50 latency).
- **`TurnResumed`** — the user kept talking after a pause; cancel the pending reply.
- **`EndOfTurn`** — high-confidence, send the transcript to the LLM.

[Migrating from Nova-3 to Flux, Deepgram Docs](https://developers.deepgram.com/docs/flux/nova-3-migration)

`TurnResumed` in particular is a native version of exactly what D6's dictation detector and D7's
non-interruptible-counter freeze/resume logic hand-build today: "the caller paused, then kept going,
don't treat the pause as done." Deepgram's own docs state this "eliminates custom VAD/barge-in
implementation entirely" — a vendor claim, not verified against this codebase's specific barge-in
requirements (the streak-based noise filtering in `barge-in.ts`, the non-interruptible-tool-call window
D7 just added), but directionally aimed at the same problem this codebase solved with three separate
hand-built layers (`turn-detection/`, `barge-in.ts`, D7's counter).

### What migration actually costs

This is not a model-name swap:

- **Different endpoint and protocol.** `/v1/listen?model=nova-3` → `/v2/listen?model=flux-general-en`
  (or `flux-general-multi` for multilingual). [Migrating from Nova-3 to Flux, Deepgram Docs](https://developers.deepgram.com/docs/flux/nova-3-migration)
- **Different message shape entirely.** `deepgram.ts`'s current handler reads `msg.type === "UtteranceEnd"`,
  `msg.is_final`, `msg.speech_final` (`deepgram.ts:148-168`) and hands `{text, isFinal, speechFinal,
  endpointSignal}` up through `ConnectStt` to every consumer in `stream.ts` (barge-in, silence timers,
  turn-detection). Flux's `TurnInfo` events (`event`, `turn_index`, `end_of_turn_confidence`,
  word-level timestamps) don't map onto that shape — this is a rewrite of the STT adapter's output
  contract, not its input parameters, which ripples into every downstream consumer of `ConnectStt`.
- **Language handling changes shape.** Nova-3's `language=multi` becomes `model=flux-general-multi` +
  optional `language_hint` — this codebase's `toDeepgramNova3Language`/`DEEPGRAM_NOVA3_LANGUAGE_CODES`
  normalization (`deepgram.ts:30-49`, hand-tuned against live 400-response testing per its own comment)
  would need the same live-testing treatment against Flux's language acceptance, not an assumed
  equivalence.
- **`smart_format` has no stated Flux equivalent.** Deepgram's own Flux-vs-Nova-3 comparison page lists
  Smart Formatting, Speaker Diarization, Profanity Filtering, Find and Replace, and Search as Nova-3
  features Flux does not have. [Compare Flux to Nova-3, Deepgram Docs](https://developers.deepgram.com/docs/flux/flux-nova-3-comparison)
  This codebase sets `smart_format: "true"` today (`deepgram.ts:96`) — without it, `captureField`'s
  `value` for a spoken number/date would come back as spoken words ("nine eight seven six five") instead
  of formatted digits ("98765"), a direct functional regression for exactly the D8 critical-field
  capture path this session just built spell-back confirmation for.
- **Coverage is narrower.** Flux covers English + a 10-language multilingual variant; Nova-3 covers 54
  languages. [Compare Flux to Nova-3, Deepgram Docs](https://developers.deepgram.com/docs/flux/flux-nova-3-comparison)
  Need to confirm this codebase's shipped Indic language set (`hi`, `mr`, `ta`, `te`, `kn`, `bn`, `gu`,
  `pa`) is a subset of Flux's 10 before assuming parity.
- **Pricing is higher per-minute** but may still net out cheaper end-to-end: Flux English is
  $0.0065/min, Flux Multilingual $0.0078/min. [Speech-to-Text APIs in 2026, FutureAGI](https://futureagi.com/blog/speech-to-text-apis-in-2026-benchmarks-pricing-developer-s-decision-guide/)
  No direct nova-3 per-minute figure was found in this pass to compare against; Deepgram also reports
  ~200-600ms lower agent response latency and ~30% fewer false interruptions versus a traditional
  STT+VAD pipeline, which — if it holds for this codebase's specific traffic — could be worth the
  per-minute delta on its own. [Best STT Providers 2026, Coval](https://www.coval.ai/blog/best-speech-to-text-providers-in-2026-independent-benchmarks-and-how-to-choose/)

### Verdict

Worth a real, isolated A/B test — not a blind swap, and not something to build D6/D7-equivalent logic
against on faith. The specific test: replay the dictation-cutoff synthetic scenarios D6's own test suite
already has (`turn-detection/dictation.test.ts`) against a live Flux connection and see whether its
native turn events actually withhold the turn the same way, then separately confirm `smart_format`'s
absence doesn't break `captureField`'s number/date capture. This is a multi-day integration project
(new STT adapter, new `ConnectStt` output contract, re-validation of every downstream consumer), not a
config change — size it as its own piece of work with its own before/after data, consistent with this
codebase's standing "no architecture swap on assumption" rule (Phase C's explicit refusal to revisit the
cascade architecture without evidence).

---

## 2. Cartesia Sonic-3.6 — the one open question that actually matters is undocumented

Every source found (Cartesia's own launch posts, MarkTechPost's technical writeup, a buyer's-guide-style
review) repeats the same two facts — "natural pauses and filler words," "#1 on Artificial Analysis" —
without ever explaining the mechanism. [Cartesia Ships Sonic-3.6, MarkTechPost](https://www.marktechpost.com/2026/08/18/cartesia-ships-sonic-3-6-a-streaming-tts-model-that-now-leads-both-artificial-analysis-speech-arenas/)
[Cartesia on X](https://x.com/cartesia/status/2089401199967559932)

The question that actually decides whether this is relevant to D4/D8 is one no source answers: **does
Sonic-3.6 insert filler words/pauses that are not in the input text, or does it just render disfluencies
that already exist in the text more naturally?** A TTS model is a text-to-audio renderer, not a language
model that improvises content — the more likely mechanism is improved prosody around filler tokens/pause
markers already present in the text, not spontaneous insertion. But "more likely" is a guess, not a
finding, and the distinction is exactly what determines the risk to D8: if the model can add unscripted
audio content on its own, that's directly in tension with D8's critical-field spell-back requiring
precise, controlled speech ("A, L, E, X" must render as exactly those characters, nothing inserted around
them). No official Cartesia documentation found in this pass describes a parameter to explicitly disable
or bound this behavior — pronunciation control exists (`pronunciation_dict_id`, inline IPA overrides)
[Custom Pronunciations, Cartesia Docs](https://docs.cartesia.ai/build-with-cartesia/sonic-3/custom-pronunciations),
but nothing found addresses filler-word suppression specifically.

No independent (non-Cartesia, non-press-release) reports — Reddit, HN, dev blogs — turned up in this
search pass discussing real production use of Sonic-3.6's filler behavior or Hinglish quality. The model
is beta as of this research (GA "later in August" per Cartesia), which is consistent with why organic
third-party usage reports don't exist yet.

### Verdict

Cannot be resolved by more searching — this needs a hands-on test against `sonic-preview`, specifically:
send the exact literal text D4's `TOOL_CALL_FILLER_LINES`/D8's spell-back confirmation phrasing would
produce, and confirm nothing is added beyond what's in the string. If Sonic-3.6 only renders what's given
more naturally, it's safe to adopt broadly, including for D8's controlled speech. If it can add
unscripted content, it needs to be scoped OUT of D8's spell-back path even if adopted elsewhere. This is
the same recommendation the original research made ("worth evaluating on sonic-preview") — this pass
didn't find a shortcut past that, only sharpened exactly what the test needs to check.

### Attempted 2026-08-26 — blocked, not resolved

Went to actually run the hands-on test the verdict above calls for. First, checked Cartesia's own live API
docs for the exact `model_id` string: **`sonic-3.6` does not exist as a documented value.** The
enumerated `model_id` list is `sonic-3`, `sonic-3.5`, `sonic-latest` — "Sonic-3.6" is Cartesia's public/
marketing name for whatever `sonic-latest` (or `sonic-3.5`) resolves to server-side; there's no way to
address it explicitly by that string.

More fundamentally: **the `CARTESIA_API_KEY` value in this environment's `.env` is invalid.** Confirmed
directly against Cartesia's REST endpoint (`POST /tts/bytes`), not an environment-loading bug — the key
loads correctly (29 chars, `sk_car_...` prefix) and Cartesia's own API returns
`401 {"message":"Invalid API key."}`. The WebSocket path this codebase's actual `tts/cartesia.ts` adapter
uses failed the same way (`Expected 101 status code`), consistent with the same root cause. **This test
cannot run in this environment until someone rotates/replaces that credential** — a separate, unrelated
finding from the filler-insertion question itself, but it blocks answering it.

What was verified live instead, since `DEEPGRAM_API_KEY` and `ELEVENLABS_API_KEY` both authenticate
successfully: a real ElevenLabs TTS (`eleven_flash_v2_5`, this codebase's actual pinned model) → Deepgram
STT (`nova-3`, this codebase's actual pinned model) round trip, using the same voice ID
(`EXAVITQu4vr4xnSDxMaL`) and provider pins this codebase ships. Input `"Please confirm your appointment
for the fifteenth at three PM."` came back as `"Please confirm your appointment for the fifteenth at
3PM."` — the only difference is Deepgram's `smart_format` rendering "three PM" as "3PM", not an inserted
or fabricated word. This is a live regression check that both of this codebase's actually-configured
adapters still work end-to-end against real accounts, independent of the Cartesia question — it does not
answer the Sonic-3.6 question, since ElevenLabs is a different provider on a different model.

Also checked, same session: Deepgram's `flux` model is **not reachable through the batch `/v1/listen`
REST endpoint** this codebase's `stt/deepgram.ts` doesn't currently use for Flux anyway — Deepgram's own
API explicitly rejects it (`V2_MODEL_ON_V1_LISTEN_ENDPOINT`, "use `/v2/listen`"), and `/v2/listen` itself
returned `405` on a plain POST, consistent with it being a WebSocket-only streaming endpoint. This
confirms (rather than newly discovers) §1's finding that Flux is a different protocol, not a same-shape
model swap — a real entitlement/access check would need a full WebSocket handshake test, which is the
same "real migration project, not a config flag" scope §1 already named, not a quick smoke test.

**Next step for whoever has a working Cartesia credential:** re-run this exact test —
`send the literal D4/D8 filler/spell-back text to sonic-latest, transcribe the output back through
Deepgram, diff against the input`. The method is proven (the ElevenLabs/Deepgram round trip above used
the identical technique successfully); only the credential is blocking it.

---

## 3. Groq's tool-use-tuned Llama variant — the model this codebase's dark path could have swapped to no longer exists

`Llama-3-Groq-70B-Tool-Use` — the model the original research doc named as a same-infrastructure,
tool-accuracy-tuned swap for ADR-109's `llama-3.3-70b-versatile` — **does not appear in Groq's current
model catalog** as of this research (August 2026), confirmed independently across a general pricing
search and Groq's own docs. [Groq Pricing In 2026, CloudZero](https://www.cloudzero.com/blog/groq-pricing/)
[Groq's current models, Groq Docs](https://console.groq.com/docs/models)
Groq's docs list a set of "legacy model groups hidden from current catalogs" without naming them, which
is consistent with this model having been retired rather than never having existed — the 90.76%
Berkeley Function-Calling Leaderboard figure the original doc cited for it is now a number for a model
that can no longer be provisioned.

Groq's current lineup includes `llama-3.3-70b-versatile` (already pinned, $0.59/$0.79 per 1M tokens
in/out), `gpt-oss-120b` and `gpt-oss-20b` (OpenAI's open-weight models, with documented built-in
browser-search/code-execution tool support), and Groq's own "Compound" system-level tool orchestration
layer built on top of these models rather than a single fine-tuned checkpoint.
[Groq's current models, Groq Docs](https://console.groq.com/docs/models)
One data point on the currently-pinned model itself: `Llama-3.3-70B-Instruct` scores 88.20% Non-Live AST
accuracy / 76.70% Live AST accuracy / 30.80% overall on BFCL in one cited evaluation context — notably
lower than the 90.76% figure for the now-gone tool-use variant, though these numbers come from different
evaluation runs/BFCL versions and aren't a clean apples-to-apples comparison.
[The Llama 3 Herd of Models, arXiv](https://arxiv.org/pdf/2407.21783)
Live current-leaderboard numbers for both `llama-3.3-70b-versatile` and `gpt-oss-120b` were not
retrievable in this pass — the Berkeley leaderboard's results table is JS-rendered and didn't return
data via fetch.

### Verdict

The specific recommendation from the prior research doc is no longer actionable — there's nothing to
swap to. If ADR-109's dark path is ever turned on, `gpt-oss-120b` (documented native tool support, still
Groq-hosted, same LPU latency characteristics) is the more concrete current candidate worth a real
before/after comparison against `llama-3.3-70b-versatile` on this codebase's actual tool set — but that's
a new recommendation from this pass, not a confirmation of the old one, and still gated behind ADR-109's
flag ever being flipped on for real.

## What this changes

Nothing shipped — this is research only, same as the doc it follows up.

1. **Deepgram Flux is now a concrete migration candidate with a scoped test plan**, not just a
   "worth measuring" note: replay D6's dictation synthetic suite against a live Flux connection, and
   separately verify `smart_format`'s absence doesn't regress `captureField`'s number/date capture,
   before any decision to migrate.
2. **Cartesia Sonic-3.6's filler mechanism is unresolved and unresolvable by more research** — the next
   step has to be a hands-on `sonic-preview` test of the exact literal strings D4/D8 would send it, not
   another search pass.
3. **Retire the Groq `Llama-3-Groq-70B-Tool-Use` recommendation** — the model is gone. If ADR-109's dark
   path is ever activated, evaluate `gpt-oss-120b` instead, as a fresh comparison, not a continuation of
   the old one.

None of these are scheduled into a phase — same as the doc this one follows up, they're
prerequisites-to-check, not committed work.
