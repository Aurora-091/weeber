---
adr: 6
title: "Workflows as code-first JSON config, not a visual builder"
date: 2026-07-04
status: Accepted
---

## ADR-006 — Workflows as code-first JSON config, not a visual builder
**Date:** 2026-07-04

**Context:** The user asked for Shopify-flow-style call automation (trigger → branch on outcome → action).
Competitor platforms (Retell, ElevenLabs Agents) increasingly offer visual graph-based workflow builders,
but Vent has no dashboard/UI by explicit earlier product decision.

**Decision:** Define workflows as a JSON array (`WORKFLOWS` env var) mapping call outcomes to actions
(retry/webhook/addToDnc/sendSms-stub), executed by a small engine (`voice/workflows/engine.ts`) and a
background scheduler for delayed retries (`scheduler.ts`).

**Consequences:** No visual editing — changing a workflow means editing an env var and restarting. This
matches the rest of Vent's "edit code/config, not a dashboard" philosophy, but is a real limitation for a
non-technical operator. A visual workflow builder is flagged as a natural v3 direction if the product ever
needs to serve non-developer users directly.
