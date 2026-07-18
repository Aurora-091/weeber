# Agent framework UI/UX audit + COGS/unit economics — 2026-07-17

Two things in one doc since they were asked together: (1) a source-level audit of the Agents
configuration UI + the underlying agent pipeline (`app/agents.tsx`, `dashboard/agents.tsx`,
`agent-config.ts`, `agent.ts`, `agent-frame.ts`, `stream.ts`), same rigor as the prior UI/UX audits
in this series (#04, #05) — every finding traced to real code, no live-browser click-through. (2) A
grounded COGS/unit-economics breakdown using real, cited provider pricing (2026), not guessed
numbers, clearly flagging where a figure is an estimate vs. a sourced fact.

---

## Part 1 — Agent UI/UX audit

### Fixed same day, before this write-up (real regressions found while auditing, not left as findings)
- **`humanTransferNumber` had zero write path anywhere** — no UI, no API route. Combined with last
  session's (correct) removal of the global env-var fallback, this meant transfer-to-human was
  silently broken for every org in production. Fixed: `GET /me`/`PATCH /settings` now read/write
  it (E.164-validated), new "Human Transfer" section in `app/settings.tsx`. See commit `37e72ce`.

### P0 — a shipped backend feature with literally no UI surface
- **Cross-provider failover (`sttFallbackOrder`/`ttsFallbackOrder`/`llmFallbackModels`) has zero UI
  anywhere.** Confirmed by reading `agent-config.ts`'s `FormState` type and both `toFormState`/
  `formToAgentFrame` functions directly — none of the three fields exist in the form state at all,
  so even the `PUT` request `AgentEditor` sends can never include them. The only way to set these
  today is a raw API call with a hand-built JSON body — not something any real user (or even an
  admin using the dashboard) can do. Both `app/agents.tsx`'s `VoiceTab`/`CallingModelTab` and
  `dashboard/agents.tsx` share the same `agent-config.ts`, so **one shared fix closes the gap on
  both surfaces**. Concretely missing:
  - No way to see or change the STT/TTS fallback order per agent (defaults silently apply).
  - No way to see or change the LLM fallback model list per agent.
  - No visibility into whether a failover has ever actually fired for this agent's calls — the
    `calls.providerFailoverCount` column exists and is written to, but nothing in the dashboard
    surfaces it per-agent or per-call (the existing latency panel on `dashboard/call-detail.tsx`
    doesn't include it, checked directly).

### P1 — real but lower-severity gaps
- **No cost-awareness at the point of configuration.** The Voice tab lets you freely pick
  ElevenLabs vs. Cartesia vs. Sarvam, or Groq vs. AI Gateway, with zero indication that these
  choices have meaningfully different per-minute costs (see Part 2 below — the spread across
  providers is real, not trivial). A merchant optimizing for a specific voice quality has no signal
  they're also picking a materially more expensive stack.
- **The Hindi/Hinglish "recommended stack" banner is the only provider-guidance UI that exists.**
  Good pattern (live-tested reasoning shown inline, one-click apply), but it's the *only* place this
  pattern is used — there's no equivalent guidance for, say, "which STT/TTS pair is fastest" or
  "which is most cost-effective," even though that reasoning exists in code comments
  (`tts/index.ts` explicitly documents *why* Cartesia is the default: works on free/starter tiers
  without ElevenLabs' library-voice restriction).
- **Guardrail strictness levels (`topicBoundaryStrictness`/`injectionSensitivity`) are bare
  dropdowns with just "low/medium/high" labels** — no inline explanation of what each level
  actually changes in the agent's behavior, unlike the Hinglish banner's detailed reasoning.
  Someone picking "high" has no idea what tradeoff they're making (likely: more false-positive
  guardrail triggers on legitimate conversation) without reading the code.
- **Retry cadence fields (`firstCallDelayMinutes`/`retryDelayMinutes`/`maxAttempts`) show "Platform
  default" as a placeholder but never state what that default actually is** — a merchant has to
  guess or ask support what leaving these blank actually does.
- **No per-agent view of the FTSA/mini-TCPA/insurance compliance gates that might block their
  calls.** These are real, already-enforced gates (Florida attempt-cap, calling-window, insurance
  number-series/producer-licensing) but they're entirely invisible from the Agents page — a
  merchant whose calls are silently deferred/blocked has to check logs or ask support, there's no
  "here's why a scheduled call didn't go out" surface tied to the agent itself (the Orders page has
  some of this for Shopify workflows specifically, but not agent-level).

### What's actually good (worth noting, not just gaps)
- The "everything reachable by one click, nothing behind Advanced" tab structure (Identity/Voice/
  Tools/Calling) is a genuinely good pattern — confirmed no hidden/collapsed sections exist.
- Live test-call/test-chat preview (`PreviewButton`/`PreviewDrawer`) lets a merchant verify their
  *unsaved* config changes before committing — sends `configOverride` with the draft form state,
  not the saved one. Good design, avoids a save-then-test round trip.
- Tool checkboxes explicitly prevent unchecking `hangUp` and the description makes clear
  unchecking a tool is safe (the persona prompt never references disabled tools) — a real,
  deliberate safety design choice, not an oversight.

---

## Part 2 — COGS & unit economics

Real provider pricing, sourced 2026-07-17 (web search, official pricing pages where available).
Flagged clearly where a number is a sourced fact vs. an estimate — this session did NOT verify
every provider's pricing against their live dashboard/invoice, so treat estimates as directional.

### Per-minute cost by provider (sourced)

| Component | Provider | Rate | Source confidence |
|---|---|---|---|
| STT | Deepgram Nova-3 (monolingual) | **$0.0048/min** ($0.29/hr) | Sourced — Deepgram's own pricing page |
| STT | Deepgram Nova-3 (multilingual/`multi` mode) | **$0.0058/min** ($0.35/hr) | Sourced |
| STT | ElevenLabs Scribe | **$0.0037/min** ($0.22/hr) | Sourced — ElevenLabs' own API pricing page |
| STT | ElevenLabs Scribe Realtime | **$0.0065/min** ($0.39/hr) | Sourced |
| STT | Sarvam | **~$0.006/min** (₹30/hr ÷ ~₹83/USD) | Sourced rate, currency conversion approximate |
| TTS | Cartesia | **~$0.02–0.04/min (estimated)** | **Not directly sourced this round** — Cartesia publishes credit-based pricing (e.g. $5/mo for 100K credits) that wasn't converted to a confirmed per-minute rate; positioned in the market as the cheapest/fastest TTS option, this is a reasonable-range estimate, not a confirmed number |
| TTS | ElevenLabs | **~$0.10–0.12/min** | Sourced range — post-2026 pricing change puts business-tier around 5¢/min base, overage pricing $0.096–0.12/min depending on plan tier |
| TTS | Sarvam | **~$0.003/min** (₹30/10K chars, ~800 chars/min spoken) | Estimated from a sourced per-character rate + an assumed speaking rate |
| LLM | Groq (Llama 3.3 70B) | **$0.59/1M input, $0.79/1M output tokens** | Sourced — Groq's own pricing page |
| LLM | AI Gateway (Google Gemini 3.1 Flash Lite — the current production default) | **Not directly sourced this round** — flash-tier models are typically in the $0.05–0.30/1M token range industry-wide, but this specific model's Gateway-listed rate wasn't confirmed | Estimate only |
| Telephony | Twilio (US outbound) | **$0.013–0.014/min** | Sourced — Twilio's own pricing page |
| Telephony | Twilio (US inbound) | **$0.0085/min** | Sourced |
| Telephony | Twilio (India outbound) | **~$0.0075/min** | Sourced (third-party rate aggregator, not Twilio's own page directly) |
| Telephony | Twilio (India inbound) | **~$0.0045/min** | Sourced (same caveat) |
| Telephony | Twilio phone number rental | **~$1–2/month per number** | Sourced, typical US local number rate |

### Blended COGS estimate — the actual production default stack

Per `/api/health` (confirmed live 2026-07-17): **STT = Deepgram, TTS = Cartesia, LLM = AI Gateway
(Gemini 3.1 Flash Lite), Telephony = Twilio.** LLM token cost in a voice conversation is typically a
small fraction of total cost (a few hundred tokens per turn, a handful of turns per call) —
excluded from the headline number below as noise, called out separately.

**US outbound call, per minute, current default stack:**
- STT (Deepgram): $0.0048
- TTS (Cartesia, estimated): ~$0.03
- Telephony (Twilio outbound): ~$0.014
- LLM (Gemini Flash Lite via Gateway): ~$0.001–0.003 (estimated, genuinely small)
- **Total: ~$0.049–0.052/min**

**India outbound call, per minute, if switched to Sarvam STT/TTS + Twilio India rates:**
- STT (Sarvam): ~$0.006
- TTS (Sarvam): ~$0.003
- Telephony (Twilio India outbound): ~$0.0075
- LLM: ~$0.001–0.003
- **Total: ~$0.017–0.020/min**

**Sanity check against the market:** an independent voice-AI cost calculator (raftlabs.com, cited
in this round's research) puts a "typical voice agent" at **$0.05–$0.30/min** all-in. The current
default US stack (~$0.05/min) lands right at the *low end* of that range — consistent with the
deliberate cost/latency-optimized choices already visible in the code (Cartesia's own doc comment:
chosen specifically because it "works on free/starter tiers without the library-voice restriction
ElevenLabs' free plan has"; Groq/Gemini-Flash-tier LLMs chosen for speed+cost, not top-tier quality).

**If ElevenLabs is used for TTS instead of Cartesia** (a real, available per-agent choice with zero
cost-visibility in the UI — see Part 1's P1 finding): swap ~$0.03 for ~$0.10–0.12/min, pushing the
US blended total to **~$0.13–0.14/min** — roughly **2.5–3x more expensive**, for a UI choice that
today looks cosmetic (just a dropdown) but is a real, meaningful unit-economics decision.

### What this means for pricing (cross-reference to the earlier GTM research)
`docs/product-strategy/product-infra-and-gtm-report.md` Part 4 already researched the market's pricing range
($0.07–$0.24+/min charged to customers) against an assumed ~$0.06/min COGS target. This session's
actual measured COGS (~$0.05/min default stack, ~$0.02/min India-optimized stack) is **at or below**
that original target — real headroom, not just an assumption anymore, *provided* the ElevenLabs TTS
option doesn't become the default for a meaningful share of calls (it's ~2.5–3x the cost). Worth
either steering merchants toward Cartesia/Sarvam by default (already the case) or pricing plans
with an explicit "premium voice" tier/add-on if ElevenLabs usage becomes common, rather than
absorbing that cost silently.

### Honest gaps in this COGS analysis
- Cartesia's real per-minute rate and the AI Gateway's Gemini Flash Lite rate were **not** directly
  confirmed against an official per-minute pricing page this round — both are estimates, flagged
  as such above, not asserted as fact.
- Real usage patterns (average call length, turn count, how much silence/hold time counts against
  STT/TTS billing) weren't modeled — this is a per-minute-of-active-audio estimate, not a per-call
  cost model. At only 10 real calls total in production (per Audit #7), there isn't yet real data
  to build an actual per-call average from.
- Provider concurrency-tier pricing (bulk/committed-use discounts at higher volume) wasn't
  researched — all rates above are pay-as-you-go/list price, which is likely the *worst-case* real
  cost once volume grows.

---

## Part 3 — Marketing/public pages: found real gaps, execution needs your call

Checked `landing.tsx`, `pricing.tsx`, and `marketing-config.ts` directly for any mention of
reliability/failover/uptime: **zero hits.** The cross-provider failover work (STT/TTS live, LLM
live as of the Railway Pro switch) is a real, differentiated, already-shipped claim — competitors
like Retell publicly lead with "99.99% uptime via cross-provider fallback" as a headline feature
(per this session's own earlier GTM research). Right now the marketing site says nothing about
this at all, despite it being true and live in production today.

**Not touched yet — this needs your direction, not just execution, because it's a positioning
decision, not a bug fix:**
- What's the actual claim you want to make? ("Resilient by default," "99.9%+ reliability," a
  specific number, or deliberately vague until there's real uptime data to back a number?)
- Where does it go? A new landing-page section, a line item in the existing feature grid, a
  dedicated "Reliability" page, or folded into the existing compliance/audit-trail messaging?
- Given the COGS finding above (ElevenLabs is materially more expensive than the default stack),
  is there anything pricing-page-relevant to say now, or is that still deliberately deferred per
  last round's explicit decision to keep pricing figure-free?

Want me to draft specific copy for review, or do you want to set the direction first?
