---
adr: 60
title: "Indic-language calls smart-default to Sarvam when no provider is chosen; mid-call spoken-language switching stays rejected (2026-07-19)"
date: 2026-07-19
status: Accepted
---

## ADR-060 — Indic-language calls smart-default to Sarvam when no provider is chosen; mid-call spoken-language switching stays rejected (2026-07-19)

**Context:** a full audit of the language path (agent-frame → agent.ts → stt/tts resolvers →
provider adapters) found that the *capability* for full multi-language support already existed and
was broader than the docs implied — but one real gap and one recurring over-claim remained:

1. **The frame was never English-only.** `agent-frame.ts`'s `language` is open free text
   (`z.string().min(2).max(20)`), and `RECOMMENDED_LANGUAGES` already lists 10 Indian languages
   (en, hi, mr, ta, te, kn, ml, bn, gu, pa) plus `multi`. Sarvam TTS (`toSarvamLanguageCode`) maps
   any language generically via `${lang}-IN` with a language-agnostic speaker, and Sarvam STT
   supports `codemix`. So Marathi/Tamil/Telugu/etc. were already technically reachable end-to-end.
2. **The gap: no language-aware provider default.** The platform defaults are English-first —
   `resolveSttProvider` → Deepgram, `resolveTtsProvider` → Cartesia. Picking, say, Tamil *without
   also* picking a provider left the call on an English-first provider that may fumble Indic speech
   and voices. The India-specialized provider (Sarvam) had to be selected manually to get a good
   result, which nothing prompted the user to do.
3. **The over-claim: "dynamic mid-call language switching."** Repeated in the pitch deck and loosely
   in some notes. `buildLanguageInstructionBlock` (agent.ts) already holds the agent to *one* fixed
   spoken language per call — and that is the correct behavior, not a limitation to fix.

**Decision:**

**(a) Smart Indic provider default.** When no provider is explicitly chosen at any level
(per-agent frame, per-number, session, or a mid-call failover target), a call whose `language` is
one Sarvam handles best now routes to **Sarvam** for both STT and TTS instead of the English-first
platform default. Implemented as a shared `SARVAM_PREFERRED_LANGUAGES` list + `prefersSarvam()`
helper in `agent-frame.ts` (mirrors `RECOMMENDED_LANGUAGES` minus `en` and `multi`), consumed by
`resolveSttProvider(override, language)` and `resolveTtsProvider(override, language)`.

Precedence, deliberately:
- **An explicit provider choice always wins** — per-agent/per-number/session override, or a mid-call
  failover target. The smart default only fills the gap when *nothing* was chosen.
- The smart default **does** beat the global `STT_PROVIDER` / `TTS_PROVIDER` env default, because
  the call's language is a more specific signal than a platform-wide fallback. An Indic language *is*
  the call saying "use something that handles this."
- **Guarded by `SARVAM_API_KEY` being present.** Self-hosted OpenVent setups without a Sarvam key
  fall through cleanly to the existing English-first default — no broken calls, no behavior change
  for them. (Weeber prod has the Sarvam key live, confirmed 2026-07-19, so this is real there, not
  aspirational.)
- **`en` and `multi` are untouched.** `multi` is specifically Deepgram's own code-switching mode and
  must stay on Deepgram; English stays on the platform default.

**(b) Mid-call spoken-language switching stays rejected — one fixed spoken language per call.**
An agent's *spoken output* language is fixed for the duration of a call. This is intentional, not a
missing feature:
- **STT understanding is already multilingual and free** — Deepgram `multi` and Sarvam `codemix`
  auto-handle a caller code-switching mid-sentence (e.g. Hinglish). Understanding the caller in
  multiple languages is solved and is not what "switching" refers to.
- **TTS is multilingual-*capable* but not auto-switching** — you pass a language per synth call. It
  does not detect and flip spoken language on its own.
- Forcing the spoken voice to flip languages mid-call would break **voice identity** (a Sarvam
  Hindi speaker and a Cartesia English voice are different voices — the caller would hear the agent
  become a different person), add **latency** (provider/voice re-init mid-stream), and introduce
  **instability**. The natural, correct behavior for Indian callers is a single agent that *speaks*
  one consistent language while *understanding* code-switching — which is exactly what we do.

**Alternatives considered:**
- *Leave provider selection fully manual (status quo).* Rejected — the capability existed but no
  path surfaced it, so Indic languages worked in theory and under-performed in practice.
- *Make the smart default also override an explicit per-agent provider.* Rejected — an explicit
  choice is an explicit choice; silently overriding it would be surprising and undebuggable.
- *Expand `RECOMMENDED_LANGUAGES` / rework the schema.* Rejected as over-engineering — the frame is
  already open free text and the list already covers the real market. No schema or architecture
  change was warranted; the fix is routing + docs, nothing structural.
- *Build mid-call language switching.* Rejected on the merits above.

**Consequence / scope shipped:**
- `agent-frame.ts`: `SARVAM_PREFERRED_LANGUAGES` + `prefersSarvam()`.
- `stt/index.ts`, `tts/index.ts`: `resolveSttProvider` / `resolveTtsProvider` take an optional
  `language`; `connectStt` / `connectTts` thread it through; smart Indic default applied with the
  precedence above.
- `stream.ts`, `test-call-stream.ts`: all direct resolver call sites now pass the call's
  `languageOverride`.
- Tests: `stt/index.test.ts` (new) + `tts/index.test.ts` (extended) prove routing, the key guard,
  the explicit-override-wins rule, and that `en`/`multi` stay on the platform default. Full suite
  green (498 pass / 0 fail), typecheck + lint clean.
- Docs: `voice-quality/language-support.md` (new) documents which provider handles what and this
  routing; `hindi-hinglish-voice-support.md` cross-links it.
- No DB migration, no schema change, no compliance-package change.

**Related:** supersedes nothing; extends ADR-040 (configurable per-agent language + multi-provider
STT/TTS). The deck's "dynamic mid-call language switching" bullet is a separate pitch-copy fix
(cut it; reframe as native-Hinglish + multilingual-understanding), tracked outside this ADR.
