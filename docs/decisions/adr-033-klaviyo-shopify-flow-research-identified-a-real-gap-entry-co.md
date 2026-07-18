---
adr: 33
title: "Klaviyo/Shopify Flow research: identified a real gap (entry-condition branching), generalized beyond Shopify"
date: 2026-07-09
status: Accepted
---

## ADR-033 — Klaviyo/Shopify Flow research: identified a real gap (entry-condition branching), generalized beyond Shopify

**Date:** 2026-07-09

**Context:** Request was to study how Shopify-ecosystem email marketing tools (Klaviyo, Shopify Flow) let
merchants build if/else + retry automation for abandoned-cart flows, and whether that pattern should extend
to every Weeber agent, not just cart recovery. Researched both:

- **Klaviyo's flow model:** trigger (event) → **trigger split** (branches on event-level data, e.g. cart
  value, only available on event-triggered flows) and/or **conditional split** (branches on profile/history
  data, e.g. first-time vs. repeat customer, usable anywhere) → time delays (placement before/after a split
  changes the semantics) → messages. Splits produce parallel YES/NO paths on a visual canvas.
- **Shopify Flow's model:** the same shape, more generic — Trigger → Condition → Action, 100+ built-in
  triggers, a "Wait" action for delays, drag-and-drop canvas.

Mapped both against what already exists in this repo's workflow engine (`voice/workflows/`):

| Concept | Status here |
|---|---|
| Time delay | `scheduledCalls.runAt` — exists |
| Retry with a cap | `WorkflowAction`'s `retry` — exists |
| Give-up-after-N-tries action | `onExhausted` (ADR-030) — exists, already generic, not Shopify-specific |
| Action (webhook/DNC/SMS) | exists |
| Branch on how a call **ended** | `onOutcome` — exists |
| **Branch on conditions at flow entry** (Klaviyo's "trigger split" — e.g. cart value, customer segment, before the first action even happens) | **Does not exist** |
| Merchant-visual editing of any of this | **Does not exist** — env-var JSON, code-first |

**Decision:** The gap is real and worth closing — entry-condition branching, generalized across every
agent/vertical, not hardcoded Shopify cart-value logic. This does **not** reopen the earlier form-vs-canvas
decision (ADR-030/031's "form-based agent config, not a visual builder" was about *persona/tone/tools*
config, which stays a form) — it refines it: Klaviyo itself keeps email *content* in an ordinary editor while
the flow *logic* (trigger/condition/delay/action graph) is the visual canvas. The automation-trigger layer is
inherently graph-shaped in a way a flat form represents poorly; the persona-content layer isn't.
**Sequencing, not scope, was the call made here:** build the branching capability itself first (config-
driven, same pattern as today's `WORKFLOWS` env var or wherever the config-storage migration lands), and
treat a visual canvas (React Flow — MIT-licensed, the standard library underlying most n8n/Zapier-style
builders) as a legitimate, separate follow-up once the underlying engine capability actually works. Sized in
`WEEBER-PLAN.md`'s Phase 2 list, not built this round — explicitly flagged as a decision for the user to
confirm before starting (config-only vs. visual-canvas-from-day-one), not decided unilaterally here.

**Consequences:** No code changed this round — this ADR and the `WEEBER-PLAN.md` entry are the spec for a
future workstream. The generalization point matters for `agentTemplates` (ADR-031): whatever
`entryConditions` shape gets built should read from that same vertical-agnostic seam, not a Shopify-specific
one, so Clinic/Hotel agents get the same branching capability without a second implementation later.
