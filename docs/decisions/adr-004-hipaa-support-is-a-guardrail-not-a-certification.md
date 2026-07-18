---
adr: 4
title: "HIPAA support is a guardrail, not a certification"
date: 2026-07-04
status: Accepted
---

## ADR-004 — HIPAA support is a guardrail, not a certification
**Date:** 2026-07-04

**Context:** HIPAA compliance legally requires a signed Business Associate Agreement (BAA) between the
covered entity and every vendor that touches PHI — Twilio, Deepgram, the TTS provider, the LLM provider.
No code running in this repo can verify that a BAA actually exists; that's a contract, not a technical
state.

**Decision:** Rather than silently assume compliance or omit HIPAA support entirely, add a
`COMPLIANCE_MODE=hipaa` flag that makes the server **refuse to boot** unless the operator also sets
`HIPAA_BAA_CONFIRMED=true` — a deliberate human checkpoint. This is documented explicitly, in both the
README and the code comments, as a guardrail against the failure mode of "nobody actually checked," not a
claim that setting the flag makes the deployment HIPAA-compliant.

**Consequences:** This adds friction (a mode that won't start without an extra flag) by design. It does
not, and cannot, replace actually signing BAAs or a real compliance review — that responsibility stays with
the operator. The same honesty principle applies to GDPR: only the concretely codeable pieces (retention
limits, right-to-erasure) are automated; a legal basis for processing is still the operator's
responsibility.
