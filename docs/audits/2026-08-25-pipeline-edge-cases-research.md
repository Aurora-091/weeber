# Voice pipeline edge cases — industry research cross-referenced against this codebase

- **Date:** 2026-08-25
- **Source:** external research (web search, cited inline per finding) cross-referenced against `main` @
  `230c07d`
- **Scope:** known failure modes in production voice-AI pipelines (turn-taking, barge-in, STT, tool-calling,
  demographics) that this repo's own audits haven't named yet — not a re-read of call data (see the
  same-day `2026-08-25-ten-calls-full-pipeline-review.md` for that)
- **Class:** dated point-in-time artifact (ADR-118 class 2) — a research reference, not a plan. Nothing here
  is implemented; each item names a verdict (handled / partial / gap) and where to look if it's picked up.

## Why this exists

Asked to find edge cases the pipeline should cover, beyond what this session's own data reads surfaced.
Rather than guess, this pulls from what the wider industry has already documented as recurring, named
failure modes — several with academic sources — and checks each one against the actual code, not against
what the docs claim. Two findings below are corrections of an assumption this session was about to make
(code-switching, hallucination) and one confirms a defect this session already fixed from a different
angle (tool-call cancellation).

## Priority 1 — gaps with a clear, direct line to this product's own vertical

### 1. Silence timeout is a global constant; this product's flagship persona is explicitly elderly-skewing

Research (UC Berkeley AgeVoicE project; dementia-friendly EVA research, Frontiers in Dementia 2024):
default voice-AI silence timeouts (1.5-2s in generic assistants) lock out older callers, whose real
speech shows slower articulation and longer, more frequent pauses; the documented fix is a
persona/demographic-**adaptive** timeout, not a single global value — one dementia-care study found
current-generation agents interrupting prematurely as the specific, named breakdown pattern.

**This codebase:** `SILENCE_WARNING_MS = 8000` / `SILENCE_HANGUP_MS = 7000` (`stream.ts:151-152`) are
hardcoded constants — no per-agent, per-org, or per-vertical override exists. The 2026-08-21 audit already
found 8s "too aggressive" for `insurance-final-expense-qualifier` (a caller "doing arithmetic about their
own funeral costs" got interrupted mid-thought). This research reframes that finding: it isn't a tuning
miss, it's a **known, named problem class** with a **known solution shape** (configurable per persona).
**Verdict: gap.** Not attempted here — Phase D's scope (turn-taking), not this session's.

### 2. Endpointing has no concept of an incomplete dictated sequence (phone numbers, emails, spelled names)

Research (Speechmatics, Cekura, industry consensus): a caller spelling an email or reading a card/order
number who pauses to check a digit gets cut off by acoustic-only endpointing; modern endpointers layer a
semantic check — "is what's been said so far a plausible complete thought" — specifically to catch
sequences like "my number is five five five" that don't end in an obvious filler word.

**This codebase:** `endsMidThought` (`turn-detection/heuristic.ts:19-23`) is a single regex checking only
for **trailing filler words** (`and|so|but|or|because|um+|uh+|like|well|then`). A caller who pauses
mid-sequence while dictating an order ID or spelling `callback_time`/`email` (both live `captureField`
targets in this codebase's own templates) does not trigger that pattern and gets treated as done. **Verdict:
gap.** No dictation-sequence detection exists at any layer.

### 3. No tool call is ever protected from a barge-in mid-execution

Research (LiveKit's `run_ctx.disallow_interruptions()`; general voice-agent failure-mode literature):
"mid-tool-call interruptions" and "stale responses after barge-in" are named, recurring failure classes —
the documented fix is marking irreversible-action tools (a booking, a payment, a database write) as
non-interruptible so caller speech can't orphan them mid-flight.

**This codebase:** confirmed directly in this session already — no file under `voice/tools/` reads
`abortSignal`, and `withToolTimeout` (`agent.ts:1022-1061`) explicitly lets an orphaned tool call keep
running after the turn stops waiting on it. `bookAppointment`, `crmSync`, `sendSms` all have zero
protection from a barge-in mid-execution. **Verdict: gap, already documented once** (2026-08-24 pre-C2
review, barge-in question 5) — this is independent confirmation from outside literature that it's a real,
named class, not an idiosyncrasy of reading this codebase.

### 4. The recording-consent disclosure is fully interruptible

Research (2026 production barge-in standard, multiple sources): "set policy per message type, not
globally — keep legal disclosures and payment confirmations non-interruptible (or DTMF-only)."

**This codebase:** `agentIsSpeaking = true` is set unconditionally at the top of every `speak()` call
(`stream.ts:1841`), including the mandatory recording disclosure (`withDisclosure`, spoken first on every
call this product places under ADR-096-class compliance gates). A caller who talks over the very start of
the call — plausible, since they don't yet know a disclosure is coming — can barge-in and cut off the
disclosure before `stampDisclosureFired()` even records it as delivered. Given how much engineering this
codebase has already put into compliance-gate correctness (ADR-096, -108, -110), this is a real
inconsistency: the single most legally load-bearing utterance in the call has the *same* interruptibility
as small talk. **Verdict: gap.**

## Priority 2 — real, but lower confidence or lower likelihood in this product's actual traffic

### 5. STT-level PII redaction isn't used; only the application layer screens captured fields

Research (Deepgram's own `redact` API param for `credit_card`/`ssn`/`email_address`; general PII-in-voice
literature): production voice agents handling regulated data run STT-level redaction as a first layer,
independent of what the LLM decides to do with the value.

**This codebase:** `stt/deepgram.ts`'s connection params (`model, encoding, sample_rate, channels,
punctuate, smart_format, interim_results, endpointing, vad_events, utterance_end_ms, language`) never set
`redact`. `screenCapture`/`prohibited-capture.ts` stops the **model** from writing a structured field for
an SSN/card/DOB — real and already tested — but a caller who states a card number **unprompted** still
lands verbatim in `transcripts`, in `history`, and in whatever the model reads next turn, since that guard
only gates the `captureField`/`markFieldUnanswered` write path, not raw STT output. **Verdict: gap** —
smaller in practice than it sounds, since this product's personas never ask for card/SSN/DOB by design
(ADR-081's licensed-act boundary), so the exposure is caller-initiated-only, but it's real defense-in-depth
this codebase's own stated philosophy ("screened in two places on purpose") would otherwise apply here.

### 6. No inbound DTMF handling at all

**This codebase:** `stream.ts`'s media-stream event switch handles exactly `start`, `media`, `stop`,
`unknown` (`stream.ts:2853/3351/3375/2850`) — there is no `dtmf` case. `sendDtmf` (`tools/sendDtmf.ts`) is
**outbound-only** (the agent playing tones, e.g. for IVR navigation elsewhere) — nothing recognizes or
reacts to the caller pressing a key. **Verdict: gap, likely low priority** — this product is a
conversational agent, not an IVR the caller navigates by keypress, so the realistic exposure is a caller
pressing a key out of habit (muscle memory from other systems) or by accident; worth a cheap defensive
no-op (recognize the event, do nothing disruptive) more than a feature.

### 7. ASR hallucination during silence/noise — unverified for this codebase's actual STT provider

Research (Whisper-specific studies, arXiv 2402.08021 and others): ASR models can hallucinate fluent,
plausible text from silence or noise with no acoustic basis — documented at ~1% of silence-chunk
transcriptions for Whisper specifically, and *not* reproduced when the same audio was run through Google/
Microsoft/Amazon/AssemblyAI/RevAI as controls in the same study.

**This codebase uses Deepgram nova-3, not Whisper** — a materially different architecture, and the one
study that ran multi-vendor controls did not reproduce Whisper's hallucination rate on any of them. This
is **not evidence Deepgram has this problem** — it's evidence the failure mode exists in this product
category and this codebase has no defense against it either way (no confidence-score filtering, no
minimum-energy gate before treating an STT event as real speech). **Verdict: unverified, not a confirmed
gap** — worth a targeted check (does nova-3 ever emit a `speech_final` transcript with implausible content
during a known-silent stretch of a real call) before spending any engineering time on a defense for a
failure mode that may not apply to this specific vendor.

## Priority 3 — already handled, confirmed rather than assumed

### 8. Backchannel vs. barge-in confusion

Research names this as a common failure: pure energy-threshold VAD can't distinguish a listener's "mm-hm"
from a real turn-taking attempt. **This codebase already separates them structurally** —
`backchannel.ts`'s `shouldBackchannel` (rate-limited, threshold-gated, only when the agent is silent) and
`barge-in.ts`'s `decideBargeIn` (streak-gated, only when the agent is speaking) are independent gates on
the same STT stream, not one heuristic doing both jobs. **Verdict: handled.**

### 9. Echo/acoustic bleed causing phantom barge-in

Research names this as the single most common cause of false barge-in in telephony voice AI.
**Partially handled**: `barge-in.ts`'s streak requirement (`BARGE_IN_STREAK_REQUIRED = 2` for short
fragments) exists specifically because "the agent's own TTS audio bleeding back into the line" was
identified as a real risk on some carrier/SIP trunk combinations (see that file's own doc comment) — this
is a statistical defense at the STT-output layer, not acoustic echo cancellation. Whether Twilio/carrier-
side AEC is sufficient on top of it is unverified, but the known failure mode is not unaddressed.
**Verdict: handled at the layer this codebase controls.**

### 10. Hinglish code-switching STT accuracy

Research (gnani.ai, multiple 2026 vernacular-AI sources): treating Hindi/English as two separate language
modes with a language-detector in front breaks on real Hinglish speech, which switches within
200-500ms — faster than most detectors react. The fix is an STT model trained on genuinely code-switched
audio, not language detection plus mode-switching.

**This codebase:** `toDeepgramNova3Language` (`stt/deepgram.ts:44-49`) already routes anything nova-3
doesn't natively support — which includes real Hinglish speech — to Deepgram's own `"multi"` code-switch
mode, exactly the documented correct approach, not a detect-then-switch shim. **Verdict: handled** —
better positioned here than the initial assumption going into this research suggested; no gap found.
Whether nova-3's `multi` mode actually holds up at the researched 70-80%-accuracy risk band for this
product's real Hinglish traffic is a measurement question (Phase-B-style), not a code gap.

## What this changes

Nothing shipped — this is reference material for whoever picks up Phase D (turn-taking) or a future
compliance/PII pass. Ranked by directness to this product's actual vertical and users:

1. Adaptive silence timeout for elderly-skewing personas (#1) and dictation-aware endpointing (#2) are the
   two most concretely justified by this product's own traffic (final-expense insurance, callers reading
   out order IDs/callback times/emails) — both are Phase D territory.
2. Tool-call interruption protection (#3) has now been named twice, independently — once from reading this
   codebase directly, once from outside literature. Worth weighting accordingly whenever tool-calling
   reliability work is scoped.
3. The disclosure-interruptibility gap (#4) is cheap to reason about and touches compliance, which this
   codebase already treats as higher-priority than latency — worth a look before the others, despite being
   found last here.
4. STT-level PII redaction (#5) and inbound DTMF (#6) are real but lower-urgency, given this product's
   actual call shape.
5. ASR hallucination (#7) needs a measurement, not a fix, before it's actionable.
