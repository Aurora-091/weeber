# UI-DESIGN-BRIEF.md — Weeber Product Design System

Confirmed design direction for everything under `/dashboard` (admin panel) and `/app` (user dashboard).
Read alongside `architecture/README.md`/`architecture/user-flow.md` — those cover page structure/scope,
this one covers how it should look and feel. See ADR-032 in `DECISIONS.md` for the reasoning. (The
original pre-build page-structure spec, `CLAUDE-BUILD-BRIEF.md`, is archived at `docs/archive/` —
superseded by the real build.)

## The reference point

**Arc browser** was the confirmed touchstone — soft paper-like surfaces, warm neutral grays, calm but not
sterile, playful in small doses without being loud. Explicitly *not* Linear's stark monochrome density —
that was my initial suggestion and was correctly overridden in favor of something warmer.

## Theme tokens — already implemented

`packages/web/src/web/styles.css` now has a `.theme-weeber` (+ `.theme-weeber.dark`) CSS class with a full
token set — apply it at the root layout element of every `/dashboard` and `/app` route (e.g. the top-level
layout component's wrapper div). **Do not** touch or reuse the bare `:root`/`.dark` tokens — those belong to
the public OpenVent landing page (editorial serif/ember palette), which is a different, unrelated surface
and is left as-is.

- **Background:** warm off-white paper (`oklch(0.98 0.012 85)` ≈ `#FAFAF8`-ish), not stark white. Full dark
  mode counterpart included (warm near-black, not pure black — matches the "calm, not sterile" direction).
- **Text:** warm near-black ink, not pure black.
- **Brand accent:** one indigo/violet accent (`oklch(0.53 0.19 275)`), deliberately a different hue from
  every semantic status color so "this is clickable/primary" never gets visually confused with "this is an
  error."
- **Semantic set:** red (error), green (success), amber (warning) — each with a `-soft` tint variant for
  backgrounds (e.g. a success banner uses `--weeber-success-soft` background + `--weeber-success` text/icon,
  not a saturated fill).
- **Radius:** `0.625rem` (10px) — moderate rounding, not sharp/technical, not pill-shaped.
- **Full light/dark parity** — both variants are filled in, not just the light mode with dark as an
  afterthought, per the confirmed "build both together" direction.

## Typography

- **Sans (Inter Tight)** for all UI text — labels, body, buttons, table content. Already loaded (same
  `@import` as the landing page, no new font request needed).
- **Serif (Fraunces)** for headings/section titles only — page titles, card section headers, empty-state
  headlines. This is the one place the user/admin product deliberately echoes the landing page's
  editorial identity, confirmed explicitly over an all-sans direction.
- **Mono (JetBrains Mono)** for anything technical — API keys, webhook URLs, org IDs, code/JSON previews.
  Already the existing convention (`.font-mono-label` class exists in `styles.css`), just carries over.

## Component shape & surfaces

- **Moderate rounding** (10px, set via `--radius` above) — reads as modern SaaS, not stark/technical, not
  soft/pill-shaped.
- **Mixed surface treatment, not one rule everywhere:**
  - Inline content (table rows, list items, inline cards) — flat, thin 1px borders (`--border`), no shadow.
  - Modals, popovers, dropdowns, command palette — soft elevation shadow, since these need to visually
    separate from the page behind them; a border alone doesn't read as "floating above."
- Use shadcn's `new-york` style conventions here (already the `components.json` style setting) — it already
  leans toward this flatter-with-selective-elevation approach by default.

## Density — different per audience, same component system

- **Admin panel (`/dashboard`):** dense. Ops staff live here all day — tighter row heights, more columns
  visible, less whitespace between elements. Think a data-grid-first feel for the calls/orgs/compliance
  list views.
- **User dashboard (`/app`):** spacious. Users visit less often and need more guidance — generous
  whitespace, larger touch targets, fewer things on screen at once, more room for empty-state/onboarding
  copy to breathe.
- Same underlying shadcn components and `.theme-weeber` tokens power both — density is a spacing/sizing
  variant (e.g. table row padding, card gap), not a second design system.

## Animation

**Tasteful micro-interactions — noticeable but restrained, 200-400ms.** Not Linear's near-invisible
utilitarian snap, not the landing page's bold scroll-driven motion. Concretely:
- Hover/focus states: color/border transitions, ~150-200ms ease.
- Dropdown/popover/modal open-close: scale + fade, ~200-250ms.
- Toasts/notifications: slide + fade in, ~300ms.
- Skeleton-to-content swap: a brief crossfade (~200ms), not an abrupt pop.
- `prefers-reduced-motion: reduce` already handled globally in `styles.css` — any new animation should
  respect it automatically via the existing blanket rule, no per-component opt-out needed.
- **Route/page transitions: none.** Instant navigation, no animated transition between pages — this was
  confirmed explicitly despite the "tasteful micro-interactions" answer elsewhere; the two aren't
  contradictory — within-page interactions get polish, page-to-page navigation stays instant.

## Loading, empty, and error states

- **Loading:** skeleton screens shaped like the actual content that's about to appear (a table skeleton has
  the right number of columns/rows, a card skeleton has the right internal layout) — not generic spinners,
  not blank screens.
- **Empty/error states: minimal, text-only, no illustrations.** A clear headline (serif, per the typography
  rule above), one line of plain-language explanation, and a single clear action if one exists. No custom
  illustration work needed — deliberately kept simple.

## Navigation

**Left sidebar + command palette (Cmd+K), both together** — the confirmed standard, matching Linear/Vercel/
Raycast. Sidebar for primary navigation between sections (orgs, templates, calls, compliance, etc. in the
admin panel; onboarding, agents, calls, analytics, billing, Shopify in the user app). Command palette for
quick jump-to-page and quick actions (e.g. "create agent template," "view org X") without requiring the
sidebar click path — build this once (a shared component), reuse in both dashboards.

## Onboarding

**Multi-step wizard with a visible progress indicator.** Each step should be small enough to feel
low-effort — e.g. "Connect Shopify" → "Pick your agents" → "Review & activate," not one long form. The
progress bar itself is part of the "zero setup" pitch: showing 2 of 3 steps done reduces perceived remaining
effort more than an unlabeled form ever does.

## Responsiveness

**Desktop-first.** Must not visibly break on mobile (no horizontal scroll, no unusably cramped tap targets),
but mobile is not a polish target for v1 — both users and ops staff are expected to use this on a laptop.
Don't spend build time on a dedicated mobile layout; do make sure Tailwind's responsive utilities keep things
usable if someone does open it on a phone.

## Accessibility — WCAG AA, not best-effort

This was upgraded from my initial "best-effort" suggestion to a real requirement — build to it from the
start, not as a retrofit:
- Color contrast ratios meet AA (4.5:1 normal text, 3:1 large text/UI components) — worth explicitly
  checking the `.theme-weeber` token pairs above against this before shipping, especially the `-soft`
  semantic background + foreground combinations.
- Full keyboard navigation — every interactive element reachable and operable via keyboard, visible focus
  states (the `--ring` token already exists for this).
- Semantic HTML and ARIA where shadcn's primitives don't already handle it (most of shadcn/Radix's
  primitives are AA-conscious by default — verify, don't assume, for anything custom-built).
- Screen reader support — labels on icon-only buttons, live regions for toast notifications, proper heading
  hierarchy (this pairs naturally with the serif-headings-only typography rule above).

## What's NOT decided here — flag before building

- Exact spacing scale values (the specific Tailwind spacing tokens for "dense" vs "spacious" density) — size
  this when the first admin-panel and user-dashboard pages are actually being laid out, not in the
  abstract.
- Logo/wordmark — still just a text wordmark placeholder (final brand assets still not decided, per
  `CLAUDE.md`'s STOP-AND-ASK list item 2), unchanged by this round.
- Command palette's exact action list — depends on which pages/actions exist first; don't over-build this
  before there's enough to search/act on.
