---
adr: 7
title: "National DNC Registry integration deferred; internal list is the enforced mechanism today"
date: 2026-07-04
status: Accepted
---

## ADR-007 — National DNC Registry integration deferred; internal list is the enforced mechanism today
**Date:** 2026-07-04

**Context:** Research confirmed there is no free public API for the FTC's National Do-Not-Call Registry —
real-time or bulk lookups require a paid Subscription Account Number (SAN) obtained through
telemarketing.donotcall.gov. This is a purchasing decision for the operator, not something the codebase can
resolve unilaterally.

**Decision:** Build and fully enforce an internal DNC list (`voice/compliance/dnc.ts`,
`doNotCall` table) automatically on every outbound call today. Design the check function and schema
(`source: "manual" | "agent" | "national-registry"`) so that syncing the national registry in later is a
pure data-population problem, not a code change — the enforcement path already treats all three sources
identically.

**Consequences:** Out of the box, Vent only blocks numbers the operator has explicitly added (manually, or
automatically via a workflow's `addToDnc` action). It does **not** currently prevent calling numbers
registered on the national registry unless the operator manually adds them — this is a known gap,
documented in the README's "Known limitations," not silently glossed over.
