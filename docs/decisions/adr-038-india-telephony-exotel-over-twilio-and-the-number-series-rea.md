---
adr: 38
title: "India telephony: Exotel over Twilio, and the number-series reality"
date: 2026-07-10
status: Accepted
---

## ADR-038 — India telephony: Exotel over Twilio, and the number-series reality

**Date:** 2026-07-10

**Context:** Twilio doesn't serve India well — it routes Indian calls through international interconnect
rather than being a licensed Indian telecom operator, which combined with TRAI's DLT/number-series
requirements means real compliance overhead and unreliable answer rates at volume. Research identified
**Exotel** as the Indian-native alternative purpose-built for AI voice agents (AgentStream real-time
streaming API, sub-20ms media latency, a published LiveKit reference architecture), with **Ozonetel** as a
credible second option. Separately, a test call placed through a competitor (Bolna) showed caller ID as a
normal 10-digit number, prompting the question of whether Weeber's own (non-marketing) agents could use
one too.

**Decision:**
1. **Exotel is the recommended India telephony provider**, full reasoning and integration notes in the new
   `docs/india-telephony.md`. Not yet integrated or tested — this is a research/recommendation round, not
   an implementation.
2. **Real catch, documented not glossed over:** Exotel's AI-agent path is SIP-trunk-based, bridged into
   LiveKit — not a drop-in replacement for the Twilio Media Streams WebSocket protocol
   `packages/api/src/voice/stream.ts` is built against. The realistic integration shape is a self-hosted
   LiveKit SIP bridge fronting the existing compliance/orchestration/agent code for the India telephony
   path specifically — prototype this end-to-end before treating it as a simple provider swap.
3. **TRAI number-series rules apply to transactional/service calls, not just promotional ones** — this is
   the actual finding worth acting on. 140-series is mandatory for promotional calls (Cart Recovery);
   160/1600-series is mandatory for transactional/service calls (COD Confirmation, Feedback). Regulation
   text explicitly bars "any other 10-digit fixed line/mobile number" for **any** of promotional, service,
   or transactional calls. **Weeber likely needs two different registered number types**, not one shared
   number across all three agents. A normal-looking number working in a competitor's test call is not
   evidence of compliance — TRAI regulation and TRAI enforcement run on different timelines in India, and
   building around "it worked once" is a real, cheap-now-expensive-later risk.
4. **"Twilio sub-account for India" is not the same shape of problem.** Twilio sub-account creation is one
   API call; Indian number provisioning requires DLT Principal Entity registration (business KYC, not an
   API call), Sender ID/header registration, per-call-script Template ID pre-approval, and region/city-scoped
   number KYC with real turnaround time (Exotel's own stated SLA: up to 24 working hours to flag a stuck
   approval). Whether Weeber registers as one Principal Entity (merchants as sub-brands underneath) or each
   merchant registers their own PE is a real, undecided business/liability question — not assumed either
   way in this ADR.

**Consequences:** The "zero setup" onboarding pitch needs an honest design accounting for a KYC/approval
step for at least the first merchant and per-agent-script template approval thereafter — not a promise of
instant provisioning. No code changed this round; `docs/india-telephony.md` is the reference for whoever
scopes the actual Exotel/LiveKit integration and the number-provisioning product flow next.
