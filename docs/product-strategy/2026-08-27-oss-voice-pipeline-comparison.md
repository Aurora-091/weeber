# Open-source voice AI pipeline comparison — LiveKit Agents, Pipecat, Vocode, Bolna

- **Date:** 2026-08-27
- **Trigger:** user asked to look at open-source pipelines "like LiveKit or etc that does all things we
  do" and inspect them, to see whether Weeber's own `packages/api/src/voice/` pipeline is missing
  anything a comparable OSS project has already solved.
- **Class:** dated point-in-time artifact (ADR-118 class 2) — a snapshot of these projects and this
  codebase as of today. If a finding here is stale, both sides have likely moved; treat as a starting
  point for the next investigation, not a permanent verdict.
- **Method:** WebSearch/WebFetch research against each project's actual repo/docs (not marketing copy),
  compared against what Weeber's pipeline already does — `stream.ts`'s per-call TTS session reuse with
  lazy-connect (ADR-083), the provider-agnostic STT/TTS/LLM registries (`voice/stt/`, `voice/tts/`,
  `voice/llm/`) each with a resolve+failover-chain pattern, `decideBargeIn`, and Twilio Media Streams as
  the sole telephony integration.

## LiveKit Agents (`livekit/agents`)

- **License:** Apache-2.0, except the semantic turn-detection *model* itself, which ships under a
  separate "LiveKit Model License" — not fully Apache for that one component.
- **Architecture:** `AgentSession`/`Agent` objects running inside a WebRTC "room," coordinated by an
  `AgentServer`. STT→LLM→TTS pipeline with each stage swappable via a very broad provider matrix
  (Deepgram, Cartesia, ElevenLabs, Azure, Google, AWS, OpenAI Realtime, and more).
- **Interruption/turn detection:** two modes — VAD-only (any speech interrupts), or an "adaptive"
  semantic model (default on LiveKit Cloud) that reasons over raw audio + words together to
  distinguish real barge-ins from backchannels, rather than waiting for a transcript. Has
  **false-interruption recovery**: if a suspected interruption produces no real transcript within
  `false_interruption_timeout`, the agent resumes speaking where it left off
  (`resume_false_interruption`, on by default). Weeber's `decideBargeIn` has no equivalent — it's a
  one-shot decision, no "was that actually nothing, resume" path.
- **Provider failover (`FallbackAdapter`, on STT/LLM/TTS all):** marks a failed provider unhealthy,
  routes to the next, and **periodically background-probes the failed one and restores it
  automatically once healthy again**. Weeber's failover is sticky for the whole call with no automatic
  recovery once a provider comes back healthy.
- **Convergent validation of a Weeber design call:** LiveKit's `FallbackAdapter` also refuses to switch
  providers mid-utterance once audio has already reached the speaker — *"the adapter does not switch to
  a backup provider mid-utterance. Fallback is skipped and the partial audio plays through."* This is
  the identical rule `stream.ts` independently landed on via ADR-083 (no failover after
  `turnTtsFirstByteMs` is set), for the identical reason (avoid a mid-sentence voice switch). LiveKit
  does not appear to speak a recovery line after a mid-utterance drop either — it just lets the partial
  audio stand. The mid-speech recovery line built into Weeber this session (2026-08-27, speaks a short
  "sorry, I got cut off" line and truncates history to what was actually said) goes further than
  LiveKit's shipped behavior here.
- **Telephony:** SIP-first, not Twilio-Media-Stream-first. A Twilio (or Telnyx/Pivo/Wavix/etc.) number
  is just a SIP trunk provider; LiveKit runs its own SIP gateway that bridges the call into a WebRTC
  room, and the agent joins as a room participant. Adopting LiveKit's telephony layer means adopting
  LiveKit's own server/SIP infrastructure (self-hosted or LiveKit Cloud), not a drop-in replacement for
  Weeber's direct Twilio Media Stream WebSocket handler. Real-world friction exists here too — e.g.
  GitHub issue `agents#3605`, "Twilio SIP call connects to LiveKit Agent — only introduction audio
  plays, then silence," the same *class* of dead-air bug Weeber has hit.
- **Tool calling:** first-class, but there's an open bug (`agents#1207`, "`llm.FallbackAdapter` doesn't
  call tools") showing tool-calling + failover interaction is an unsolved edge in their own stack too.
- **Maintenance:** very active — 3,889+ commits, backed by a funded company plus community.

## Pipecat (`pipecat-ai/pipecat`)

- **License:** BSD-2-Clause.
- **Architecture:** genuinely frame-based — composable processors pass typed frames
  (`UserStartedSpeakingFrame`, etc.) through a bus, locally or distributed. This is architecturally the
  closest of the four to Weeber's own `stream.ts` shape: a single-process, event/frame-driven pipeline
  over a raw audio transport, not a WebRTC-room abstraction.
- **Telephony:** the standout feature — genuine multi-provider *serializers* for Twilio, Vonage, Exotel,
  Genesys, Plivo, Telnyx, plus WebRTC transports (Daily, LiveKit, WhatsApp). Twilio Media Streams is a
  first-class, directly-supported transport here, not SIP-abstracted away — much closer to what Weeber
  already built by hand.
- **Interruption handling:** modeled as a cancel event — user speech confirmed → interrupt fires →
  in-flight TTS torn down → the LLM generation feeding it is also cancelled. Real, documented production
  friction exists: an open issue (`#2460`) about interruption not firing reliably over a
  `FastAPIWebsocket` transport, and a noted architectural problem where audio-send work can starve the
  thread doing server-side VAD, pushing barge-in latency past 3s until re-architected. Confirms barge-in
  over a raw WebSocket is a genuinely hard, still-imperfect problem generally, not a Weeber-specific
  rough edge.
- **Provider failover:** no documented equivalent to LiveKit's `FallbackAdapter` found — appears to be
  left to the integrator.
- **Maintenance:** the most actively maintained of the four by a clear margin — 14.8k stars, 12,166+
  commits, 88 open issues / 148 open PRs, maintained by Daily plus a large community.

## Vocode (`vocodedev/vocode-core`) — ruled out

MIT-licensed, modular STT/LLM/TTS pipeline, but effectively stalled: last commit November 2024, the
maintainers are "actively looking for community maintainers," and multiple 2026 sources flag it as
maintenance-only while the team focuses on a hosted product instead. Not a credible option to build on
or migrate to right now.

## Bolna (`bolna-ai/bolna`)

- **License:** MIT.
- **Notable because it's India-focused:** Twilio + Plivo supported now, Exotel + Vonage listed as
  "coming soon" — Exotel specifically is relevant given Weeber's India/TRAI compliance surface.
- **Architecture:** async streaming pipeline over WebSockets, similar shape to Pipecat/Weeber. ASR
  (Deepgram, Azure), LLM (OpenAI, DeepSeek, Llama, Cohere, Mistral), TTS (Polly, ElevenLabs, Deepgram,
  OpenAI, Azure, Cartesia). Interruption handling and failover behavior weren't documented in what was
  reachable during this research pass.
- **Maintenance:** much smaller (744 stars, 2,836 commits) and — same red flag as Vocode — the repo
  itself says it's actively looking for maintainers. Bus-factor risk.

## Synthesis

**What Weeber already has that these projects independently converged on** (validates existing design,
not a novel gap):

- **No failover after the first audio byte** — LiveKit's `FallbackAdapter` has the identical rule, for
  the identical reason. Weeber arrived at this independently via ADR-083; it's the field-tested right
  answer, not a workaround.
- **Frame/event-driven single pipeline over a raw telephony transport** — Pipecat's and Bolna's
  architecture is structurally the same shape as `stream.ts`, not the WebRTC-room abstraction LiveKit
  uses. Direct Twilio Media Stream handling is a legitimate, common architecture, not a homegrown
  oddity.
- **Barge-in over a raw WebSocket is a genuinely hard, still-imperfect problem everywhere** — Pipecat
  has an open bug about it, LiveKit needed a whole semantic model to get past naive VAD's false
  positives. Weeber's `decideBargeIn` isn't unusually crude for the field.

**What these projects have that Weeber's pipeline is missing or does more crudely:**

1. **Active provider-failover with background health-probing and auto-restore** (LiveKit) — Weeber's
   failover is sticky-for-the-whole-call with no automatic recovery once a provider comes back healthy.
   Concrete, adoptable idea independent of adopting LiveKit itself.
2. **False-interruption resume** (LiveKit's `resume_false_interruption`) — if noise/a backchannel
   briefly triggers barge-in with no real transcript following, resume the agent's original speech
   instead of treating it as a real interruption. Weeber has no equivalent.
3. **Semantic/acoustic turn detection** beyond raw VAD, reducing false barge-ins from
   backchannel-style utterances. Weeber's current barge-in logic is comparatively simple.
4. Broader out-of-the-box provider catalogs (mostly a convenience difference, not architectural).

**Migration cost/risk:** Weeber's `placeOutboundCall` compliance chokepoint (DNC/TCPA/FTSA), the
insurance producer-licensing gate, and org-scoped everything are not things any of these frameworks
understand or would enforce — that logic sits *above* the STT/LLM/TTS pipeline layer today and would
still need to sit there regardless of which pipeline framework runs underneath. None of these projects
have a compliance layer; adopting one doesn't remove that engineering, it just changes what's under it.
A full migration to LiveKit specifically would also mean adopting its WebRTC/room/SIP infrastructure — a
materially bigger operational dependency than a WebSocket handler in the same Bun process — for benefits
that are real but not obviously worth that infrastructure shift given Weeber's pipeline already works in
production.

## Recommendation

Keep building in-house on the current architecture — it's structurally the same shape as the most
actively-maintained comparable (Pipecat), and the compliance coupling makes a wholesale framework swap
low-value relative to its cost. Two concrete, cheap improvements are worth building directly into
Weeber's existing failover/barge-in code rather than adopting a library for:

1. Background health-probing + auto-restore for a burned failover link, instead of sticky-for-the-call
   (extends `voice/failover.ts`).
2. A false-interruption grace window before honoring a barge-in, mirroring LiveKit's
   `resume_false_interruption` (extends `decideBargeIn`/`barge-in.ts`).

Neither requires new infrastructure. Not yet built — flagged here for a future session.
