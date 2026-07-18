---
adr: 3
title: "Compliance is enforced by default, not left as an integration step"
date: 2026-07-04
status: Accepted
---

## ADR-003 — Compliance is enforced by default, not left as an integration step
**Date:** 2026-07-04

**Context:** The user explicitly asked for compliance (TCPA, DNC, consent, HIPAA, GDPR) that "runs itself"
— the developer adopting this repo shouldn't have to remember to wire in a DNC check or a recording
disclosure; those are exactly the kind of steps that get skipped under deadline pressure and turn into
real legal exposure once calls are actually placed at volume.

**Decision:** Every outbound call automatically passes through a Do-Not-Call check and a TCPA
calling-window check before dialing (`voice/compliance/`, wired directly into
`POST /calls/outbound`) — a call that fails either check is rejected with a clear reason and never reaches
Twilio. The recording/AI disclosure is spoken at the start of every call by default
(`RECORDING_DISCLOSURE_ENABLED=true` is the default, not opt-in).

**Consequences:** A developer who does nothing beyond setting up API keys still gets baseline TCPA/consent
behavior. The tradeoff is that these checks add a small amount of unavoidable overhead/latency to every
outbound call, and the calling-window timezone inference is best-effort (area-code-based), not perfectly
precise — documented as such rather than presented as legally airtight.
