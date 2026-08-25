# Fresh SOTA sweep — what's new since the 2026-08-16 architecture audit

- **Date:** 2026-08-25
- **Source:** external research (web search + fetch, cited inline), checked against `main` @ `96a82c2`
- **Scope:** deliberately narrow — only findings that are genuinely new since
  `docs/audits/2026-08-16-manus-weeber-vs-sota-voice-architecture.md` (read in full before this pass) or
  not already covered there, and not already decided against in `docs/plans/phase-c-latency.md` /
  `docs/plans/phase-d-conversation.md`'s "Explicitly out of scope" sections. Provider version currency
  (Deepgram Flux, Cartesia Sonic-3.6, Groq tool-use models) is **out of scope here** — that's
  `docs/audits/2026-08-25-provider-currency-deep-dive.md`'s territory, done in parallel.
- **Class:** dated point-in-time artifact (ADR-118 class 2) — a research reference, not a plan.

## What's NOT repeated here

The 2026-08-16 audit already gave a thorough, well-cited comparison of Weeber's imperative-closure
architecture against LiveKit Agents, Pipecat, Vapi, Retell, ElevenLabs, and OpenAI Realtime, plus a
4-phase roadmap (measurement correctness → hot-path fixes → runtime contract → production-scale session
infra → eval harness). None of that is re-litigated here. Two of its named gaps are also already
partially closed by work shipped since: Phase C (TTS session reuse, prompt-cache scrubbing, tool-call
batching) addressed several of its Phase-1 latency items, and Phase D (D6 dictation heuristic, D7
non-interruptible protection) added turn-taking/interruption sophistication the Aug-16 audit's turn-taking
section didn't have yet. Region/replica latency (the audit's `+91` callers on a US Twilio number) is
already correctly filed as Phase E, not re-raised here.

## Finding 1 — Weeber's barge-in has no acoustic confidence signal; 2026 production practice has moved to one

**What's new:** the 2026-08-16 audit's turn-taking section named the gap generically ("major gap in
naturalness and latency," semantic refiner not wired). Since then, the specific *mechanism* the industry
converged on has gotten more concrete and more measurable:

- Production barge-in in 2026 targets a **false-barge-in rate under 2%** (above 5%, the agent reads as
  broken), achieved via a VAD-confidence signal feeding the interruption decision — not text-length
  heuristics alone.[1]
- The specific migration path named across three separate frameworks is a **learned classifier that
  distinguishes backchannel vs. barge-in vs. continued silence**, replacing energy-threshold VAD: Pipecat's
  `SmartTurnAnalyzer`, LiveKit's `TurnDetector`, Vapi's `endpointing` controls.[1]
- Silero VAD (small neural net, reported 5-8% false-positive rate on noisy phone audio, open-source) is
  the named lightweight option when a full learned turn-classifier isn't warranted.[1]
- Named latency budgets: end-of-user-speech → agent audio start targets 250-350ms P95 for sales/IVR
  workloads, with the barge-in handle itself (end-of-speech → TTS flush) budgeted at ~150ms.[1]

**Why this is a real gap, not a restatement:** `packages/api/src/voice/barge-in.ts`'s `decideBargeIn` fires
purely off STT **interim transcript text** — length (`BARGE_IN_MIN_CHARS`) and a consecutive-hit streak
(`BARGE_IN_STREAK_REQUIRED`) — with no acoustic confidence score anywhere in the decision. The codebase
does have audio-level filters (`audio-noise-filter.ts`'s rolling noise filter, `wind-noise-filter.ts`'s
high-pass filter, both gated behind `ADAPTIVE_NOISE_FILTER_FLAG`/`WIND_NOISE_FILTER_FLAG` and **both
off by default**, confirmed via `stream.ts:3424-3428`), but those clean the audio *before* STT, not add a
speech/non-speech confidence signal to the barge-in decision itself. A codec artifact or background noise
burst that Deepgram mistranscribes as a short garbage string must still pass the same character-count gate
as a real word — there is no independent signal that says "this probably wasn't speech at all."

**Not a recommendation to build Silero VAD integration today** — that's a real scoping decision (a new
audio-path dependency, a new per-frame inference cost) this doc isn't positioned to make. It's a
measurement gap worth naming: Weeber has never measured its own false-barge-in rate against the 2%/5%
industry benchmarks above, and doing so (instrument `decideBargeIn`'s `fire: true` decisions against a
human-reviewed sample of whether the caller was actually trying to interrupt) is cheap and would tell you
whether this is worth building before deciding to build it.

## Finding 2 — cost-per-minute benchmarks confirm the provider-currency doc's LLM finding extends to the whole stack

**What's new:** the existing `2026-08-25-provider-model-currency-research.md` established that Weeber's
LLM choice (`gemini-3.1-flash-lite`) is already at the 2026 cost/speed floor for tool-calling voice agents.
Fresh component-level pricing data confirms the same is true for the rest of the stack, and sharpens *why*
STT quality matters more than STT price for this product specifically:

- 2026 India/Hinglish market rates: STT $0.005-0.015/min, LLM $0.02-0.09/min, TTS $0.02-0.05/min
  component-wise; Deepgram Nova priced around $0.0043/min.[2] Weeber's stack (Deepgram STT, Cartesia TTS,
  Gemini Flash-Lite) sits at or below the cheap end of every one of these bands already — there's no
  "swap to a cheaper provider" lever left unpulled on cost alone.
- The same source states the risk directly: **"cheap STT that mishears code-mixed speech quietly destroys
  ROI for Hinglish deployments"** — language mix costs less to run and more to get wrong, in that order
  (English-only cheapest, Hinglish code-switch next, then Tamil, then Malayalam/Bengali).[2]

**Why this matters here specifically:** this independently corroborates D8's own cited stat (Deepgram's
25.5% missed named-entity/alphanumeric rate) from an economic angle rather than a correctness angle — a
mis-captured order ID or policy number isn't just a compliance/UX defect, it's the specific failure mode
that erases the cost advantage of running a cheap-but-imperfect STT provider in the first place. D8's
spell-back mitigation (shipped this session) is the right-shaped fix; this is corroborating evidence it
was worth building, not a new action item.

## Finding 3 — speech-to-speech production-readiness: nothing new found

Searched specifically for evidence beyond the 2026-08-16 audit's already-thorough OpenAI Realtime section
(which gave a nuanced, correctly-scoped recommendation: audio-native S2S for simple low-latency turns,
cascaded for regulated/tool-heavy workflows). Results were market-sizing and adoption-percentage claims
("67% of Fortune 500 run voice AI in production," "$47.5B by 2034") — marketing-report numbers, not
production engineering evidence, and not specific to S2S readiness for a cost-sensitive, Indic-language,
tool-heavy use case like this one. **No new finding here** — the Aug-16 audit's S2S section and Phase D's
explicit decision not to chase this without a stated reason and its own measurement still stand
unchallenged by anything this pass turned up.

## What this changes

Nothing shipped, matching the sibling provider-currency doc's convention. One measurement worth doing
before any build decision:

1. **Instrument and measure Weeber's actual false-barge-in rate** against the 2%/5% industry reference
   points named in Finding 1, using a human-reviewed sample of real calls — before deciding whether an
   acoustic VAD-confidence signal is worth adding to `decideBargeIn`. This is a measurement task, not a
   build task, and it's the same "measure before building" discipline this session already applied
   successfully to C3, D1, and D3.

None of this is scheduled into a phase — a prerequisite-to-check, not committed work, same convention as
the provider-currency doc.

## References

[1]: https://futureagi.com/blog/voice-ai-barge-in-turn-taking-2026/ "Production Voice AI Barge-In & Turn-Taking: 2026 Technical Findings"

[2]: https://www.thinnest.ai/blog/voice-ai-cost-per-minute-india "Voice AI Cost Per Minute India (2026)"
