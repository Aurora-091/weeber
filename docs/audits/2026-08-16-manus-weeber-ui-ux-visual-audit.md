# Weeber UI/UX Visual Audit — Working Findings

**Date:** 2026-08-16
**Auditor:** Manus AI — external, AI-authored visual/UX assessment (not a Weeber-team internal audit)
**Scope:** Public landing page (desktop + mobile), authenticated Agents/Workflows/Home pages (desktop + mobile), waitlist form, pricing page. Visual-regression snapshot review plus source-level verification, not a full live-product test pass.
**Repo state at audit:** `main`, same session as `2026-08-16-manus-weeber-vs-sota-voice-architecture.md`.
**Method:** Reviewed rendered visual-regression snapshots, then cross-checked the flagged findings against actual page source (`app/agents.tsx`, `app/workflows.tsx`, `dashboard/agents.tsx`, `MarketingNav.tsx`, `WaitlistForm.tsx`, `marketing-config.ts`, the shared `EmptyState` component) to separate confirmed source-level defects from screenshot-only inference.
**Verification:** Spot-checked before archiving. The `EmptyState` component (`packages/web/src/web/components/shell/empty-state.tsx`) does accept an optional `action` slot exactly as claimed — confirming the "error-recovery inconsistency" finding (Conversations/billing/knowledge-base pass a retry action, Agents/Workflows did not) is a real, source-verified defect, not a snapshot artifact.

---

> **Note on provenance and status:** This assessment was produced externally (Manus AI) and imported as-is after fact-checking its central technical claim against the live repo. **Unlike a typical newly-imported audit, fixes for most of its findings are already applied in the working tree as of this archiving pass** (uncommitted at the time of import) — see *Fix status* below. Treat the remaining open items (navigation overload, landing-page trust gap, pricing decision gap) as backlog candidates, not committed decisions.

## Fix status as of archiving (2026-08-16)

Cross-checked against uncommitted working-tree changes present at the time this document was archived:

| Finding | Status | Where |
|---|---|---|
| Error-state recovery gap (Agents) | **Fixed** — icon + Retry action added, calls `configs.refetch()` | `pages/app/agents.tsx` (list + detail) |
| Repeated primary-flow error dead end (Workflows) | **Fixed** — same pattern applied | `pages/app/workflows.tsx` (list + detail) |
| Error-recovery inconsistency (dashboard Agents) | **Fixed** — same pattern applied | `pages/dashboard/agents.tsx` |
| Mobile email-field compression | **Fixed** — email/CTA row now stacks (`flex-col sm:flex-row`) below `sm` | `components/marketing/WaitlistForm.tsx` |
| Waitlist error/validation live-region gap | **Fixed** — `role="alert" aria-live="polite"` added to inline errors | `components/marketing/WaitlistForm.tsx` |
| Navigation has no visible sign-in route | **Fixed** — "Sign in" link added to desktop nav and mobile sheet | `components/marketing/MarketingNav.tsx` |
| Pricing decision gap (non-quantified limits) | **Fixed** — tiers now state concrete call/month caps | `lib/marketing-config.ts` |
| Empty-dashboard orientation gap (date selector competes with onboarding) | **Fixed** — date-range selector now hidden until `hasData` | `pages/app/home.tsx` |
| Navigation overload (9 top-level destinations) | **Open** — not addressed in this pass | — |
| Landing-page trust gap (contact-first hero, no product tour) | **Open** — not addressed in this pass | — |

These working-tree changes were not made by this document's author — they were already present in the repo at archiving time and are noted here only to keep this document's findings from going stale on arrival.

## Evidence reviewed

The audit reviewed the visual-regression snapshots for the public landing page at desktop width and the authenticated Agents page at desktop width. These snapshots provide rendered-state evidence rather than an end-to-end live product test.

## Initial observations

The public landing page has a clean, high-contrast visual hierarchy: the core sales claim is immediately visible, waitlist fields are placed in the hero, and the primary conversion action is clear. However, the hero uses a large amount of vertical space for one conversion task, the navigation has no visible product-tour or sign-in route, and the supporting claims are visually subordinate enough that they may not resolve trust, onboarding expectations, or use-case fit before the visitor is asked for contact details.

The authenticated Agents page shows a left navigation rail with nine primary destinations before a user has reached the main task content. In the recorded error state, a large card contains only "Couldn't load your agents" and a text instruction to refresh. The screen lacks a contextual action, retry control, recovery expectation, support path, or preserved view of the last-known agent configuration. This makes a transient data failure look like a dead end and leaves most of the available page area blank.

The mobile version preserves the same non-actionable error state. The navigation collapses to a hamburger control, which avoids horizontal crowding, but the content area still becomes a mostly empty viewport with no visible retry affordance. On a phone, this is more severe because the user must infer that a browser-level refresh is the only recovery route.

The authenticated home snapshot is a zero-data/first-run state. It presents a Dashboard title, a 7/14/30-day period selector, and a prominent onboarding card showing 0% setup completion with a "Resume" button. This creates a plausible next step, but the view provides no explanation of the specific setup outcome, no visible checklist preview, and no useful empty-state guidance for the large unused dashboard area. The date-range selector has no meaningful outcome in the same state and competes subtly with the onboarding action.

The Workflow desktop snapshot uses the same large, non-actionable server-error pattern as the Agents page. This affects another primary setup flow and suggests the issue is a repeated page-level implementation pattern rather than an isolated screen defect. A workflow is presented as something users can toggle and customize, yet the failure surface offers no retry, no status cue, no way to continue with cached content, and no safe path toward support or related prerequisites.

The public mobile landing page maintains the visual hierarchy well: brand, social-proof pill, value proposition, supporting message, and waitlist form remain readable and appropriately stacked. However, the small-screen email field and the CTA share a horizontal row. At the observed width, the email placeholder truncates to "you@yourbran", while the CTA occupies nearly half the available row. This increases input ambiguity and creates a likely failure point for email entry on the most conversion-sensitive view. The mobile header also collapses navigation to an unlabeled hamburger with no immediately visible secondary route such as Help or sign-in.

The public pricing mobile snapshot has a coherent hierarchy and readable card treatment. The page clearly states that public pricing is deferred until launch, but the visible plan card begins with non-quantified promises such as "Capped calls/minutes." For a buyer comparing operational tooling, the absence of even indicative limits, usage logic, or a concrete next action makes the page informative but not decision-ready. This is a positioning and conversion issue rather than a visual defect.

The Conversations error snapshot provides a useful counterexample: it includes a descriptive error, an icon, and an explicit Retry action. This confirms that the design system and shared `EmptyState` primitive support recoverable error states. The missing retry controls on Agents and Workflows are therefore an inconsistency in product implementation, not a component limitation.

## Preliminary risk candidates

| Candidate | Why it matters | Evidence state |
|---|---|---|
| Error-state recovery gap | Agent operations are central to the product; a non-actionable failed load blocks the principal task. | Direct snapshot evidence |
| Navigation overload | The app exposes many destinations at the same hierarchy level, raising orientation and discoverability costs. | Direct snapshot evidence |
| Landing-page trust gap | A contact-first hero may ask for commitment before explaining enough of the system's value and usage boundaries. | Direct snapshot evidence |
| Empty-dashboard orientation gap | A zero-data dashboard exposes controls before it explains how to become operational or what data will appear later. | Direct snapshot evidence |
| Mobile recovery friction | The narrow error state omits an explicit retry and turns a server problem into an ambiguous manual-refresh task. | Direct snapshot evidence |
| Repeated primary-flow error dead end | Both Agents and Workflows implement a principal-task outage without an in-product recovery action. | Direct snapshot and source evidence |
| Mobile email-field compression | The horizontal email + CTA treatment truncates the input affordance at 390 px. | Direct snapshot evidence |
| Error-recovery inconsistency | Conversations provides an in-context retry, while Agents and Workflows do not despite the same reusable empty-state API. | Direct snapshot and source evidence |
| Pricing decision gap | Plan messaging appears before concrete usage boundaries or an unambiguous buyer next step. | Direct snapshot evidence |

These findings remain provisional until route code, tests, mobile screenshots, and other product states are reviewed.

## Source-level verification

The repeated failure-state issue is confirmed in production page code. Both the agent list/editor and workflow list/detail branches call `EmptyState` with a title and description but no action. The shared `EmptyState` component explicitly accepts an optional action slot. By contrast, the billing, conversations, and knowledge-base pages invoke the same primitive with a `Retry` button and a query refetch handler. This is a concrete interaction-consistency defect, not an inference from the preview screenshots.

The shared application shell has several positive accessibility and usability patterns. It provides a labelled primary navigation landmark, `aria-current` for the active destination, visible keyboard focus styling for navigation links, a labelled mobile navigation trigger, a screen-reader title for the mobile sheet, and a reduced-motion fallback in the global stylesheet. The layout also contains accidental-horizontal-overflow protection and stable same-origin font loading for visual regression consistency.

The waitlist form uses native email inputs, autocomplete hints, input modes, focus-on-error behavior, `aria-invalid`, and descriptive error linkage. Its field height is 48 px, which is appropriate for touch use. However, the responsive layout deliberately keeps the email field and submit button in one horizontal flex row at all widths, which matches the observed truncated mobile input. Validation and server-error copy are rendered as plain paragraphs without a live-region role, so asynchronous feedback may not be announced reliably to screen-reader users.

## Evidence limitations

Most authenticated visual snapshots are generated through a development-only structural preview harness with backend data intentionally failing fast. They are valid evidence for shell, responsive layout, loading/error treatment, and visual consistency, but they do not establish how populated production tables, charts, or editor states behave. The final report distinguishes direct code evidence from snapshot evidence and recommends a seeded, authenticated test pass before implementation work begins.
