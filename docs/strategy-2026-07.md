# Strategy synthesis — July 2026 feedback round

**Not a public doc — internal reasoning artifact.** Written after four rounds of real Reddit/LinkedIn
feedback plus direct competitive research (Voximplant). Purpose: turn accumulated signal into concrete
roadmap decisions instead of reacting to each comment individually. See `reddit-feedback.md` (gitignored,
not in this repo) for the raw comments this synthesizes.

## What we now know, in priority order

### 1. "Self-hosted" needed precision — fixed (ADR-016)
Multiple independent commenters correctly pushed back that Twilio/Deepgram/PSTN can't be self-hosted.
Resolved: OpenVent now describes itself as **self-hosted orchestration, bring-your-own AI providers** — a
three-tier spectrum (fully local ↔ OpenVent ↔ fully managed), not a binary claim. Shipped in docs, landing
page, and the agent's own persona. Closed.

### 2. Vendor lock-in is real architecture, wrong headline
Three independent sources (one neutral commenter, one self-disclosed adjacent-space builder, one
competitor co-founder) converged on the same point without prompting each other: **lock-in anxiety is
retroactive, not proactive.** Nobody shops for "no lock-in" before they've been burned by a price hike or
a breaking API change. This means:
- The architecture bet (swappable providers, own database) stays correct and valuable.
- It should stop being messaged as the headline pitch. It's the thing that makes migration a week instead
  of a rewrite when the bill spikes or the API breaks — insurance, not a hook.
- **Action:** when v2 launch copy is eventually written (still paused), lead with something else. Lock-in
  resistance becomes a supporting proof point, documented and real, not the opening line.

### 3. Compliance should ship as an audit trail, not more warnings
The single most concrete, buildable idea from any feedback round: produce, on demand, exactly who was
called, when, under what consent basis, what disposition, and what the agent said — assembled from data
OpenVent already collects (`calls`, `transcripts`, `doNotCall` tables) but never packaged as an exportable
artifact. Confirmed independently: "the people who've been close to a TCPA/DNC problem usually don't post
about it... produce that log on demand and you've handled most of the actual fear."
- **This is now the highest-priority concrete build item**, ahead of the integrations work that was
  previously "in progress." It's cheap (data already exists), differentiated (nobody else in the OSS
  conversation ships this), and directly answers the #1 fear identified in the original market research.
- **STATUS (verified 2026-07-17): already shipped, this doc was stale.** `baf170d "Compliance
  audit-trail export (ADR-017)"` — `GET /calls/:id/audit` and `GET /callers/:phoneNumber/audit`
  (per-call and per-recipient, respectively), both JSON and `?format=text` (lawyer/compliance-
  officer-ready plain text), assembled via `buildCallAuditRecord`/`buildPhoneNumberAuditTrail` +
  `renderAuditTrailText`. This section is left in place as the original reasoning for *why* it was
  prioritized, not as an open item.

### 4. State engine — strongly, independently validated
Two separate people described nearly the identical design ("transcript as event log, separate canonical
state") without reading each other's comments or OpenVent's code. This is the strongest validation any single
piece of work has received. No action needed — already shipped (ADR-012) — but worth knowing this is a
genuinely defensible, not just internally-convinced-ourselves, design decision.

### 5. Latency visibility is a real, cheap, currently-unaddressed gap
From Talkif.ai (weighted as an interested party, but the technical claims check out against our own code):
OpenVent has exactly one latency measurement (LLM time-to-first-token, console-logged only) and nothing for
STT connect time, TTS first-byte time, or end-to-end round-trip. Cold-start doesn't apply to us (PM2 runs
persistent instances). Region-aware telephony is real but a much bigger, separate infra decision — not
scoping that now.
- **Action:** per-call latency breakdown (STT connect, first STT result, LLM TTFT, TTS first byte, total
  round-trip), surfaced on the dashboard's call detail page — not just console logs. Concrete, scoped,
  cheap relative to its diagnostic value.
- **STATUS (verified 2026-07-17): already shipped, this doc was stale.** `GET /calls/:id/latency`
  (call-level: STT connect/LLM TTFT/TTS first byte) is rendered as a "Latency breakdown" section on
  `dashboard/call-detail.tsx`; per-turn p50/p90 distributions (voice-to-voice, LLM TTFT, TTS first
  byte) are on `dashboard/analytics.tsx` via `turnLatencyPercentiles`. This section is left in place
  as the original reasoning for *why* it was prioritized, not as an open item.

### 6. Cross-call memory is a real, separate feature — not a competing solution
Voximplant (managed voice-AI orchestration platform, CPaaS) ships `ApplicationStorage` for cross-call
history: caller dials back next week, agent recalls roughly what was discussed last time via a rolling
raw-message-history array fed back into LLM context. Read carefully (docs reviewed directly, not just the
comment): this solves a **different problem** than OpenVent's state engine — it's fuzzy cross-call recall, not
deterministic within-call state, and its actual mechanism (raw chat-message history) is the same
"transcript as memory" pattern ADR-012 already identified as unreliable. Not a competing fix; a
complementary, currently-missing feature.
- **Action (lower priority, later):** cross-call memory (keyed by phone number, not caller-ID-as-identity
  since that's spoofable) as a genuinely separate addition on top of, not instead of, `capturedState`.
- **STATUS (verified 2026-07-17): already shipped, this doc was stale — built 2 days after this doc was
  written.** ADR-023 (2026-07-08), `voice/caller-memory.ts` — flat per-phone-number key/value overlay,
  merged not replaced, exactly the shape recommended above (keyed by phone number via
  `resolveHumanNumber`'s inbound/outbound direction logic, not caller-ID). Landing page and
  `docs/state-engine.md` were synced to this in ADR-027. This section is left in place as the original
  reasoning for *why* it was recommended, not as an open item.

## Competitive positioning — what Voximplant's model tells us

Direct research into Voximplant (docs, pricing, architecture) confirms where OpenVent sits and sharpens the
"three-tier spectrum" framing from ADR-016:

- **Voximplant is a proprietary managed CPaaS + orchestration platform.** Scenarios (`VoxEngine`, their
  serverless JS runtime) execute on Voximplant's own cloud, not the customer's infrastructure. Their own
  FAQ explicitly discourages self-hosting their client library ("we don't recommend this... it is
  important to use the latest version"). This is a real, useful data point: even a technically sophisticated
  competitor with a real orchestration story is architecturally on the *fully-managed* end of our spectrum,
  not the middle. It validates that "self-hosted orchestration" is a genuinely distinct, non-trivial
  position — not a marketing spin on the same thing everyone else offers.
- **Their strength (worth taking seriously, not dismissing):** broad, well-documented multi-provider
  connectors (OpenAI, Gemini, Grok, Ultravox, Cartesia, Deepgram, ElevenLabs all wired in with example
  code), multi-network telephony (PSTN, SIP, WhatsApp, WebRTC, native mobile), and a real cross-call memory
  primitive shipped as a documented pattern, not a stub. Their breadth of pre-built connectors is larger
  than OpenVent's today.
- **What they don't and structurally can't offer:** your own database owning the data, code you can read
  end-to-end and audit, compliance logic (DNC/TCPA/HIPAA/GDPR) built into the platform rather than left to
  the integrator, or the ability to self-host the orchestration layer itself. Their pricing ($0.004/min
  cited, plus whatever the underlying AI/telephony providers cost on top) is also a recurring per-minute
  fee with no self-hosted escape hatch — exactly the "vendor lock-in becomes a cost problem eventually"
  pattern three separate feedback sources flagged independently.

**Positioning conclusion:** OpenVent shouldn't compete with Voximplant on connector breadth (they have more
resources and a head start there) or on ease-of-setup (managed will always win that). OpenVent's differentiated
ground is: self-hosted orchestration + compliance-as-shipped-feature + auditability — none of which a
managed CPaaS can offer by definition, no matter how many connectors they add.

## Revised priority order for actual next work

Previously "in progress"/"next" items (integrations, resilience layer) are done. Revised order based on
this round's synthesis, replacing the stale "not started" section of `ROADMAP.md`:

1. **Compliance audit-trail export** (new, highest priority — concrete, cheap, most differentiated, most
   requested)
2. **Per-call latency breakdown on the dashboard** (concrete, cheap, closes a real diagnostic gap)
3. **Cross-call memory** (real, but lower priority — complements the state engine, not urgent)
4. **v2 messaging pass** — demote lock-in from headline to supporting proof point, once ready to write
   launch copy (still paused pending more signal, per user's original "accumulate before concluding" call)
5. **Continued community feedback loop** — keep accumulating; four rounds in and every single one has
   produced at least one concrete, buildable idea. No sign this is diminishing yet.

## What this round did NOT change
- Open-core model (ADR-015) — unaffected, still the direction.
- Self-hosted-orchestration positioning (ADR-016) — reinforced, not revised, by the Voximplant research.
- npm publish of `@openvent/compliance` — still deferred, now arguably even more clearly the right call, since
  the audit-trail feature (below) will likely live in or alongside that package and should ship as part of
  a more complete compliance story, not before it.

## Addendum — speech-to-speech (S2S) architecture, considered and rejected for now

Researched whether OpenVent should move from its current cascaded architecture (audio → STT → text → LLM →
text → TTS → audio) to a fused speech-to-speech model (OpenAI Realtime API, Gemini Live, Hume EVI 3 —
one model, audio in, audio out, no text intermediate). Conclusion: **stay cascade, no action.**

- S2S fuses STT+LLM+TTS into one opaque model — no inspectable text intermediate — which directly
  conflicts with the compliance-audit-trail feature just made the #1 roadmap priority. Cascade produces
  text artifacts as a natural byproduct; S2S needs a bolted-on parallel transcription layer to recover
  equivalent auditability, and that parallel transcript can diverge from what was actually said
  (documented cases exist).
- S2S locks you into one vendor's fused model — no swapping STT/LLM/TTS independently — which conflicts
  with OpenVent's provider-swappability bet (the "insurance, not headline" architecture from point 2 above).
- Tool/function calling works on S2S models, but reliability is measurably weaker and much harder to debug
  than cascade's inspectable text-based tool-call step — a real cost for an agent whose tools (crmSync,
  bookAppointment, captureField) are core to the product.
- Source note: primary research pulled from a Deepgram article — Deepgram is OpenVent's own STT provider and
  has a direct incentive to favor cascade. Weighted the technical substance independently of that bias; the
  compliance/swappability/debuggability tradeoffs are structural properties of the two architectures, not
  vendor spin, and hold up on their own.

No roadmap or ADR change from this — confirms the existing architecture is correct, doesn't introduce new
work.
