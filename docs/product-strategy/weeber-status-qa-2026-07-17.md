# Weeber status Q&A — 2026-07-17

Answers to a due-diligence-style question set (tech stack, agents, insurance/clinics, compliance,
integrations, performance, deployment/cost, website/roadmap). Every claim below was verified
directly against the codebase and live infra this session (Railway/Supabase queries, `/api/health`,
the live weeber.ai site, actual DB rows) — not recalled from memory or assumed. Where something is
marketed but not built, or built but not live, that's called out explicitly rather than smoothed over.

## 1. Tech stack & base

Forked from Rushikesh's own OpenVent (`openvent.dev`) open-core project, now living as the private
`Aurora-091/openvent` repo. Bun + Vite + React + Hono + Drizzle ORM, Postgres via Supabase, deployed
on Railway (Singapore).

**Live production defaults** (confirmed via `/api/health`): STT = Deepgram, TTS = Cartesia, LLM =
Gemini 3.1 Flash-Lite via Vercel AI Gateway, Telephony = Twilio. All four are swappable per-agent,
with real alternates already wired and tested: STT also supports Sarvam and ElevenLabs Scribe; TTS
also supports ElevenLabs and Sarvam; LLM also supports Groq (Llama 3.3 70B); telephony also supports
Plivo and Exotel for India.

**What's custom vs. the open-source base:** the multi-tenant vertical architecture (orgs, per-vertical
dashboards/terminology), the entire compliance engine (see #4), cross-provider failover for
STT/TTS/LLM (shipped this week), the Shopify integration, the insurance vertical's 5 agent templates
+ regulatory gates, and the adaptive/wind noise filters are all additions on top of the open-source
orchestration core.

## 2. Current agents — Shopify (3 built, 2 active)

All three are real, seeded, tested templates with actual conversation scripts
(`docs/agent-prompts/01-03`):

- **Cart Recovery** (active): calls after an abandoned checkout, offers a discount via
  `offerCartRecoveryDiscount`, captures outcome.
- **COD Confirmation** (active): calls to confirm a Cash-on-Delivery order before shipping, to cut
  RTO — confirms or cancels via `confirmCodOrder`.
- **Post-Delivery Feedback** (built, **currently inactive** — not turned on): collects feedback
  after fulfillment.

**No WooCommerce integration exists.** Only Shopify (`packages/api/src/integrations/shopify/`). The
live weeber.ai site lists WordPress/WooCommerce as "on the roadmap," not shipped.

## 3. Insurance & clinics

**Insurance: code-complete, 5 templates, not yet live** — Policy Renewal Reminder, Lead Follow-Up,
Appointment Setter/Warm-Transfer, Post-Sale Welcome, Feedback/NPS. All route anything beyond
confirm/decline to a licensed human (`transferToHuman`) — never quotes, advises, or underwrites.
**Blocked on external paperwork, not engineering:** India requires a real TRAI 1600-series
DLT-registered number before any insurance call can dial (hard-coded check, deadline already passed
Feb 15 2026), and US requires real licensed-advisor records per state before a transfer/booking is
allowed. Both gates exist and work — there's just no real number/advisor data behind them yet.

**Clinics: marketed, not built.** The live site markets "clinics, plumbers, salons" as a use case,
but there is no clinic-specific agent template or vertical in the codebase — only two real verticals
exist right now, `shopify` and `insurance`. This is a gap between the site copy and actual product
state worth knowing about.

## 4. Compliance engine

Own package (`@weeber-compliance`), not a bolt-on: DNC list + national DNC registry check
(hard-blocking, no override), purpose-scoped consent grants, India TRAI calling-window enforcement
(9am-9pm IST hard gate) + a US pack, versioned recording/AI disclosure text (persisted per-call so
you know exactly what was said, not just that disclosure happened), a GDPR erasure module (retention
+ right-to-erasure against `calls`/`transcripts`), a HIPAA preflight guardrail (won't silently assume
BAAs are signed), and a full audit-trail export (`GET /calls/:id/audit`, per-call or
per-phone-number, JSON or lawyer-readable plain text). This is the actual product claim on the site
("you cannot dial a number that hasn't passed our consent gate") and it's real, enforced code, not
messaging.

## 5. Integrations

**Live:** Shopify (OAuth app, cart/order webhooks), Google Calendar (booking), Salesforce/HubSpot/
GoHighLevel (CRM sync tool), SMS via Twilio. Telephony: Twilio (primary), Plivo and Exotel
(India-specific, wired but "no live prototype call yet for either" per the code's own comment).

**Not built despite being marketed:** the live site advertises WhatsApp as "launching with" — there
is no WhatsApp code anywhere in this repo. Same gap as clinics above.

## 6. Performance & limitations

Real numbers pulled from production this week: pickup-to-first-word ~1.7-2.9s (STT connect ~550-
600ms concurrent, LLM TTFT ~1000-1600ms is the dominant cost, TTS adds ~350-470ms). Just shipped:
cross-provider failover (if a provider errors mid-call, automatically retries the next one) and two
noise filters (steady background noise + a new wind-specific high-pass filter, both flag-gated and
off by default pending real testing). Known gaps: Hindi/Hinglish code-switching required real
fixing this month (ElevenLabs Scribe + pronunciation dictionary, live-verified) — Deepgram's own
multilingual mode has a documented bug misdetecting Hindi as Spanish. No accent-specific testing
done yet beyond that.

## 7. Deployment & cost

Railway Pro (Singapore, 1 replica, auto-scales vertically to 24 vCPU/24GB), Supabase Small (Mumbai)
— both confirmed live. **Real measured COGS: ~$0.05/min** on the default US stack (Deepgram +
Cartesia + Gemini + Twilio), **~$0.02/min** on an India-optimized stack (Sarvam + Sarvam + Twilio
India). Switching TTS to ElevenLabs pushes that to ~$0.13-0.14/min (2.5-3x) — a real, current
unit-economics risk since it's just a cosmetic dropdown today with no cost warning. No rate-limit or
reliability incidents yet, but that's honestly because real volume is still ~14 calls total (see
below), not a tested-at-scale claim.

## 8. Website & roadmap

weeber.ai is live: waitlist (43 signups), 3 use-case sections (Local/Service, D2C/Shopify,
Insurance) with real audio demo players, a "compliance built-in, not bolted on" explainer, and a
founder-story section. No public beta yet — copy says "onboarding in small batches soon."

**No written 4-8 week roadmap doc exists in the repo** — being straight about that rather than
inventing one. What the actual state points at as next: (a) resolving the insurance vertical's
external blockers (DLT number, advisor licensing) since the code side is done, (b) building the
WhatsApp/clinic pieces the site already markets but the codebase doesn't have, (c) validating the
failover/noise-filter work just shipped with real test calls, (d) the "Advanced Cascaded" prosody
layer discussed as the next latency/quality lever (see
`docs/voice-quality/voice-ai-breakthrough-leverage-study-2026-07-17.md`).

**Real internal test metrics:** 14 total calls in production, all outbound-completed or
inbound-completed, 3 booked, 2 not-interested. This is internal testing scale, not a beta cohort
yet — worth being precise about that distinction if this goes into anything external-facing.
