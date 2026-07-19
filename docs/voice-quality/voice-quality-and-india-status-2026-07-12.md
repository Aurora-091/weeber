# Voice pipeline, Hindi/multilingual layer, and India-readiness — status, gaps, priorities

> **Superseded on 2026-07-19 by ADR-060 (see `language-support.md`).** This is a point-in-time
> snapshot; its body is left as-written for history. Two items below are now decided: (1) mid-call
> spoken-language *switching* — the "Language Switching Instructions field" and the "TTS cannot
> switch, bigger build" notes — is **REJECTED, not a roadmap item** (voice-identity break, latency,
> instability; one fixed spoken language per call, STT code-switching understanding stays); (2) Indic
> calls now **smart-default to Sarvam** automatically. Read this doc as of 2026-07-12; read
> `language-support.md` + ADR-060 for current truth.

**Not a public doc — internal status artifact**, same convention as `strategy-2026-07.md`. Written after a
direct code audit (not assumptions) of the voice pipeline, the compliance layer, and a competitive read of
Bolna's multilingual architecture, plus a vendor feature audit of Cartesia/ElevenLabs/Sarvam. Purpose: one
place that says what's actually done, what's flagged-but-not-fixed, and what order to do it in, before the
Exotel/Plivo telephony evaluation starts.

## Done this pass (shipped, tested, pushed to `main`)

1. **Cartesia word-level timestamps wired up** (`add_timestamps` was hardcoded `false`, now `true`) —
   feeds a new `onWordTimestamp` callback on the shared `ConnectTts` interface. Other providers (ElevenLabs,
   Sarvam) simply never call it — no behavior change for them, no breaking change.
2. **Barge-in now records only what the caller actually heard.** Previously, when a caller interrupted the
   agent mid-sentence, the *entire* LLM-generated reply got pushed into conversation history — including
   the part TTS never got to speak (LLMs stream faster than TTS speaks it, so on interruption the full text
   is usually already sitting in memory). Now, when a turn is interrupted and Cartesia timestamp data
   exists, history only gets the words actually spoken. This was a real, silent state-corruption bug: the
   agent could "remember" saying things it never said out loud, which shows up later as confused follow-up
   turns.
3. **Explicit language-behavior instructions added to the system prompt** (`buildLanguageInstructionBlock`
   in `agent.ts`) — previously **zero**. The `language` field only ever drove which STT/TTS provider+code
   got used technically; the LLM itself was never told what language to respond in or what to do if the
   caller switches. Mirrors Bolna's trigger/fallback/default instruction pattern (see Bolna analysis below).
4. **Per-call latency now persists incrementally**, not only at `finalizeCall` (fixed same week) — a call
   ending through any path that skipped the single end-of-call write was silently losing every latency
   metric captured up to that point, even though STT/LLM/TTS all genuinely worked.
5. **Workflow canvas backend is complete** (built in a separate session, verified here): 3 new tables
   (`workflow_templates`, `org_workflow_configs`, `workflow_runs`), the `advanceWorkflow` graph walker, the
   server-side 1-30% discount ceiling (enforced regardless of template/override values — closes the gap
   flagged when this was speced), cart-recovery-URL + discount-code merge tag composition, save-time graph
   validation (rejects a `conditionalSplit` node with no `default` edge), admin CRUD endpoints, and an admin
   Workflow Runs observability page. Migration applied to Supabase. `resumeWorkflowAfterCall` wired into
   both call-end paths (normal completion in `stream.ts`, and the Twilio status-callback path for
   no-answer/busy/failed in `routes.ts`). One real test regression found and fixed in this pass (a mock-only
   issue, not a production bug — see commit `2e73091`). **Remaining:** the Bolt canvas UI prototype still
   needs to connect to the now-live admin CRUD endpoints.

## Critical, unresolved — do before anything India-facing goes live

**`calling-window.ts` computes actively wrong permitted-calling-hours for `+91` numbers.** It resolves
local time entirely off US/NANP area codes; any Indian number falls through to the "safe" fallback —
11am-9pm **US Eastern**, which is roughly 8:30pm-6:30am **IST**. Today, this compliance gate would treat
Indian nighttime as an allowed calling window. This is not "not yet extended for India" — it is actively
backwards, and it sits in the same code path that's genuinely blocking non-compliant calls for US numbers
today (verified: DNC + calling-window checks are real, active, `403`-and-never-dials for both manual
outbound calls and scheduled/workflow calls, and `BYPASS_COMPLIANCE` is confirmed unset in the real Railway
staging env — so this isn't a "compliance is fake" problem, it's a "one geography's rule is wrong" problem).
**Fix requires the actual current TRAI-mandated calling-window hours** — don't guess at the number, verify
it as part of the fix, the same way `india-telephony.md` already flags TRAI enforcement as a moving target.

## Bolna Hindi/multilingual architecture — what they do that Weeber doesn't (yet)

Researched directly (Bolna's own docs + LinkedIn posts from their team), not assumed:

- **Per-language prompts, not one prompt with a "respond in caller's language" instruction.** Each
  supported language gets its own dedicated prompt tab in Bolna's agent builder. Weeber has exactly one
  `systemPrompt` per agent config, with the caller's language handled (now) via the instruction block added
  this pass — a cheaper fix, not the same level of control Bolna gives an operator.
- **An explicit "Language Switching Instructions" field** — trigger conditions, fallback behavior, default
  rule, written once, applied across every language automatically. Weeber's new instruction block covers
  the same *idea* but is fixed logic, not an operator-editable field yet.
- **Per-language handoff messages** — a specific canned line plays when the agent transitions away from a
  language. Weeber has no equivalent.
- **Per-language STT/TTS provider routing** — confirmed directly: when a Bolna agent switches from Hindi to
  Marathi mid-config, it automatically routes to whichever provider has the lowest WER for that specific
  language (e.g. Sarvam for Marathi), not one fixed provider across every supported language. **Weeber picks
  one STT and one TTS provider per agent, full stop** — there is no per-detected-language dynamic provider
  switching. This is the same structural issue as the TTS-fixed-language problem below, generalized: Weeber's
  provider selection model assumes one language per call; Bolna's assumes several, with per-language routing
  as a first-class concept.

**The sharper, more precise version of "the Hindi layer needs fixing" found by reading the actual code:**
when `language: "multi"` is configured (Deepgram's English+auto-detected-other code-switching STT mode),
**STT can already follow the caller across a language switch, but TTS cannot** — Sarvam/ElevenLabs/Cartesia
all speak one fixed language/voice for the entire call (there's no single "auto" TTS voice across
providers). This pass's instruction-block fix tells the LLM to *stay* in whichever language it opened with
rather than trying to switch its own spoken output — a mitigation, not a fix. **The real fix is dynamic
per-response TTS voice/provider selection based on the LLM's actual output language**, which is a genuinely
bigger build (detect output language per turn, maintain a language→voice/provider map per agent, switch TTS
connections mid-call) — this is the single highest-value remaining voice-pipeline gap, and it's the same
shape of problem as Bolna's per-language provider routing above. Not done this pass; flagged as the next
real Hindi-layer build, not a quick patch.

## Vendor feature audit — Cartesia / ElevenLabs / Sarvam

| | In use | Available, not used | Verdict |
|---|---|---|---|
| **Cartesia** | `sonic-3` TTS, word timestamps (now on) | Sonic-3.5 (newer model), Ink-Whisper STT, "Auto" STT endpoint (built-in turn-taking: `turn.start`/`turn.eager_end`/`turn.resume` — effectively Vapi's speculative-inference trick, natively) | Ink-Whisper/Auto-STT genuinely evaluated this pass and **not adopted yet** — the Auto turn-taking endpoint is **English-only today**, so it can't touch Hindi calls, and the alternative Manual endpoint has no built-in VAD (would require building custom endpointing logic, the exact gap already flagged as missing). Track as a strong upgrade for English-only agent lines once Cartesia adds multilingual auto-turn-detection — do not force-fit it in now. |
| **ElevenLabs** | `eleven_flash_v2_5` TTS | Eleven v3, Scribe v2 STT, voice cloning, 12-month startup grant | v3 confirmed **correctly not in use** — ElevenLabs' own docs say v3 isn't suitable for real-time/conversational use, Flash v2.5 is their recommended agent model. Worth checking startup-grant eligibility (free runway on infra already paid for). Voice cloning is a real option if per-client brand-voice becomes a requirement, not needed now. |
| **Sarvam** | `bulbul:v3` TTS, `saaras:v3` STT (both already current) | Sarvam's own LLMs (30B/105B, India-context-trained) | Worth a targeted side-by-side test against the current Groq LLM specifically on Hindi/code-switched calls — real differentiation upside for the India push, not just a cost play. Not implemented this pass (evaluation task, not a code change). |

**Also found, adjacent:** LiveKit (already the presumptive SIP bridge layer for the Exotel path — see India
section below) ships built-in **voice isolation / noise cancellation** as a transport-layer feature. Since
that bridge needs prototyping anyway for India telephony reasons, test specifically for noise-suppression
quality when that prototype happens, instead of treating "no background-noise filtering" as a separate
`stream.ts` build task.

## India telephony — where this stands, and the new ask (Plivo + others)

`india-telephony.md` already covers the core plan in detail (Exotel recommended, SIP-trunk-based, bridged
through something like LiveKit, DLT/PE registration process, 140 vs 160/1600 number series requirement) —
not re-litigated here. **New, from this conversation: Plivo (and possibly others) need the same evaluation
Exotel got, before committing to one telephony vendor.** None of that comparison exists yet. At minimum,
evaluate on: India PSTN licensing/interconnect (same reason Twilio was ruled out), native DLT/TRAI tooling
maturity, published AI-agent/streaming-media reference architecture (Exotel has AgentStream; unclear if
Plivo has an equivalent), and real per-minute pricing at Weeber's expected volume. This is a research task,
not started yet — flagged here so it doesn't get lost, not answered here.

## Priority order, all gaps combined

1. **Fix `calling-window.ts` for `+91` numbers** — blocking, actively wrong today, not just incomplete.
2. **Evaluate Plivo (and any other India-capable telephony vendor) alongside Exotel** before committing —
   new ask, not started.
3. **Prototype the Exotel/Plivo → SIP → LiveKit bridge, one real end-to-end call** — still unbuilt, and
   test LiveKit's noise-isolation feature specifically while doing this (two birds).
4. **Build dynamic per-response TTS voice/provider selection for multilingual calls** — the real fix behind
   this pass's language-instruction-block mitigation; the single highest-value remaining voice-pipeline gap.
5. **Wire the Bolt canvas UI to the now-live workflow-template admin endpoints.**
6. **Billing** (Razorpay integration — still a stub, `gateway: null` in code) — see the India market entry +
   billing plan doc for the full breakdown; not re-covered here.
7. Lower priority / evaluate-don't-build-yet: Cartesia Ink-Whisper/Auto-STT (English-only blocker), Sarvam
   LLM A/B test, ElevenLabs startup grant application, Cartesia Sonic-3.5 upgrade.
