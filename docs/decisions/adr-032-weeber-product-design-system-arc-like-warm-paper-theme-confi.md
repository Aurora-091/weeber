---
adr: 32
title: "Weeber product design system: Arc-like warm paper theme, confirmed by explicit UI/UX round"
date: 2026-07-09
status: Accepted
---

## ADR-032 — Weeber product design system: Arc-like warm paper theme, confirmed by explicit UI/UX round

**Date:** 2026-07-09

**Context:** Before Claude/the team start building the admin panel and merchant dashboard pages (scoped in
ADR-031/`CLAUDE-BUILD-BRIEF.md`), a dedicated round of visual-direction questions was needed — the request
was specifically for a "paper-like, black and grey" SOTA look, which is vague enough to mean several very
different things (Linear's stark monochrome density vs. Arc's warm calm paper vs. a literal textured-paper
skeuomorphism). Sixteen explicit questions were answered covering reference point, exact color rules, theme
parity, typography, component shape, density, animation, loading/empty states, navigation, onboarding
pattern, responsiveness, and accessibility bar — several answers overrode my initial recommendation, and
those overrides are followed exactly, not softened.

**Decision:** Full spec lives in `UI-DESIGN-BRIEF.md` — summarized:
- **Arc browser** is the confirmed reference (warm, calm, paper-like), not Linear's stark monochrome density
  (my initial suggestion, correctly overridden).
- **Grayscale + a full semantic set** (red/green/amber) **+ one brand accent** (indigo/violet, `oklch(0.53
  0.19 275)`) — not the stricter "grayscale + one accent only" I'd suggested; the semantic trio was judged
  necessary for scanning status at a glance in a compliance-driven ops tool, which was actually my own
  original reasoning for suggesting an accent at all — the answer just extended that reasoning further than
  I initially proposed.
- **Full light/dark parity from day one**, not light-first-with-dark-later.
- **Serif (Fraunces) for headings, sans (Inter Tight) for everything else** — keeping one deliberate echo of
  the landing page's editorial identity, rather than an all-sans direction.
- **Moderate rounding (10px)**, not the sharper 2-4px I'd suggested.
- **Mixed surface treatment** — flat bordered inline content, shadow-elevated overlays (modals/popovers) —
  not "flat everywhere."
- **Different density per audience** (dense admin panel, spacious merchant dashboard) sharing one component
  system — this one matched my recommendation exactly.
- **Tasteful 200-400ms micro-interactions**, not the near-invisible utilitarian timing I'd suggested — but
  **instant page/route transitions** either way, which isn't a contradiction: within-page polish, zero
  between-page latency.
- **Skeleton loading, minimal text-only empty/error states, left sidebar + command palette navigation,
  multi-step onboarding wizard with progress indicator, desktop-first responsiveness** — all matched my
  recommendation.
- **WCAG AA compliance required for v1**, upgraded from my initial "best-effort" suggestion to an actual
  build requirement.

Implemented this round: a `.theme-weeber`/`.theme-weeber.dark` CSS class in `packages/web/src/web/
styles.css` with the full token set (background, ink, border, brand accent, semantic colors, radius) for
both light and dark modes — additive, scoped, and deliberately separate from the existing `:root`/`.dark`
tokens that belong to the public OpenVent landing page (untouched, unrelated surface). Every `/dashboard`
and `/app` route should apply `.theme-weeber` at its root layout element.

**Consequences:** Verified via `vite build` (clean, CSS output grew from 41.50kB to 44.49kB as expected for
the new token block, no errors). No components or pages were built this round — this ADR and
`UI-DESIGN-BRIEF.md` are the spec Claude/the team builds against, matching the same "decide the seam now,
build the feature later" pattern as ADR-030/031's schema work. Exact spacing-scale values, the logo/wordmark,
and the command palette's action list remain open, flagged explicitly in `UI-DESIGN-BRIEF.md`'s closing
section rather than guessed at.
