# Weeber — Language Capability (deck / pitch copy)

Corrected 2026-07-19 per ADR-060. Use this everywhere the deck, site, or grant application
talks about languages. It replaces the old "dynamic mid-call language switching" bullet, which
was aspirational and is now **rejected by design** — do not ship or say it.

---

## The one-liner (use this)

> **Weeber speaks India natively — real Hinglish, not translated Hindi.** Callers can mix Hindi and
> English in the same sentence and the agent understands and answers naturally, in one clean voice.

---

## Slide bullet (short form)

- **Native Hinglish, not "Hindi mode."** The agent understands code-mixed speech —
  *"mujhe ek flight book karni hai"* — and keeps `flight` and `book` in English where a real person
  would, instead of mangling them.
- **One voice per call, no robotic language flips.** The agent picks the caller's language and stays
  in it — consistent identity, no mid-sentence voice change.
- **Right engine, automatically.** Indic-language calls route to the best-in-class Indic speech model
  under the hood; operators never have to guess which provider to pick.

---

## Talk-track (60 seconds, for a live Q&A)

Most "multilingual" voice bots do one of two bad things: they translate everything into stiff
textbook Hindi, or they try to *switch voices* mid-call and end up sounding like three different
people. We rejected both.

Indian callers don't speak Hindi *or* English — they speak both in the same sentence. Weeber is
built for exactly that. Our speech layer keeps English loanwords (`flight`, `book`, `COD`, `order`)
in English, the way a real Mumbai or Pune support agent would, and answers back in the caller's
natural register. We verified this on real Hinglish audio, not a demo script.

Under the hood, when a call comes in on an Indic language, we automatically route it to the
best-in-class Indic speech model — the operator setting up the agent doesn't have to know which
vendor is strongest for Hindi. It just works, and they can still override it if they want.

We deliberately do **not** flip the spoken voice mid-call. That breaks the agent's identity, adds
latency, and destabilizes the conversation. One consistent voice per call is the right product
decision, not a limitation.

---

## What NOT to say (killed claims)

- ❌ "Dynamic mid-call language switching" / "detects and switches language on the fly"
  → **Rejected.** Breaks voice identity, adds latency, destabilizes calls. Never claim it.
- ❌ "Speaks 20+ languages" as a headline number → we don't lead on a language count; we lead on
  *native Hinglish quality*, which is the actual differentiator vs Bolna/HuskyVoice.
- ❌ "English and Hindi only" → outdated framing; understated. We handle code-mixed Indic speech.

---

## Honest status (for grant / diligence — do not overclaim)

- **Shipped & live-verified:** code-mixed Hindi/English understanding (STT), English-loanword
  preservation, pronunciation dictionary for domain terms (e.g. `COD`), automatic Indic-language
  routing to the strongest speech provider, per-agent provider override.
- **By design (not a gap):** one fixed spoken language per call.
- **Open / not built yet:** localized system messages (silence prompt, hangup line, tool-wait
  filler) per language. Small, honest to list as roadmap.

Source of truth: `docs/voice-quality/language-support.md`, `docs/voice-quality/hindi-hinglish-voice-support.md`,
and ADR-060.
