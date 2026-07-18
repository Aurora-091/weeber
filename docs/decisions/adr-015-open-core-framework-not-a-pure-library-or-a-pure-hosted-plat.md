---
adr: 15
title: "Open-core framework, not a pure library or a pure hosted platform"
date: 2026-07-05
status: Accepted
---

## ADR-015 — Open-core framework, not a pure library or a pure hosted platform
**Date:** 2026-07-05

**Context:** Early community feedback (Reddit, pre-launch research round) raised a concrete gap:
"lack of good integrations... their ability to listen to me and understand what I want to do" — i.e. Vent
doesn't fit into the tools people already run, and the one CRM integration that exists (`crmSync`,
HubSpot-only) is a hardcoded stub. Answering that well required deciding what Vent actually *is* as a
product, not just what to build next — because "add more integrations" implies very different things
depending on whether this is a library, a framework, or a platform.

Three shapes were considered:
- **Pure library** (just `@openvent/compliance` and friends on npm): low switching cost for adopters, but our
  own market research showed this doesn't monetize directly — GitHub Sponsors plus a hosted convenience
  layer is the standard pattern for OSS infra, not download counts alone. Also weak as something to pitch —
  "we maintain an npm package" isn't a fundable story.
- **Pure hosted platform** (compete directly with Vapi/Retell/LiveKit Cloud): would abandon Vent's actual
  edge. The single most-repeated complaint surfaced in the market research was "the biggest issue isn't the
  tech, it's the lock-in" — going head-to-head with well-funded managed platforms puts Vent in the one lane
  where it has no advantage.
- **Open-core framework** (chosen): the self-hosted pipeline (Twilio/Deepgram/LLM/TTS, the state engine,
  the compliance module, the dashboard) stays free and fully open — this is the trust mechanism for the
  self-hosted/OSS audience the research validated, and every claim about "your keys, your data" stays
  independently verifiable by reading the code. A paid layer ("Vent Cloud") sits on top: managed hosting so
  people don't have to hand-roll tunnels/PM2/Twilio wiring, a hosted multi-tenant dashboard, premium
  pre-built integrations (see the GoHighLevel/Salesforce/Google Calendar work started this round), and —
  directly solving today's stub — a paid, hosted national DNC registry sync (Vent holds the FTC SAN
  subscription once, amortized across many customers, instead of each self-hoster needing their own).

**Decision:** Vent is an open-core framework. Free/open forever: the core pipeline, state engine,
compliance primitives (DNC list, calling-window enforcement, GDPR erasure), and dashboard. Paid, later:
managed hosting, premium integrations, hosted national DNC sync, enterprise/HIPAA support. This is the
model used by comparable OSS infra companies (Supabase, n8n, PostHog) and is a recognizable, fundable shape
if this is ever pitched: "self-hosted and free to verify, or pay us to host it and handle the regulatory
parts you don't want to own yourself."

**Consequences:** Near-term work (integration resilience wrapper, GoHighLevel/Salesforce/Google Calendar
integrations) is unchanged in scope but is now understood as the seed of the future paid tier, not just
"more open-source features" — worth keeping in mind when deciding what ships free vs. gated later. Bigger
follow-on work this implies but does not require yet: multi-tenancy, billing, a hosted deploy path — none
of that is being built now, only decided as the direction. No code changes this round.

---
