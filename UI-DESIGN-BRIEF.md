# UI-DESIGN-BRIEF.md — Weeber Product Design System

> **Status: reconciled with code on 2026-08-27** (previous reconciliation: 2026-07-30). This
> document is rewritten directly from `packages/web/src/web/styles.css`, `styles-marketing.css`,
> and `lib/verticals.ts`. **The code is the source of truth; if this doc and the code ever
> disagree again, trust the code and fix this file.**
>
> **2026-08-27 — design unification.** Marketing and the product (`/app` + `/dashboard`) were
> both already monochrome (ADR-039) but disagreed on *how*: two different display fonts despite
> this doc claiming one shared face, no shared radius scale on marketing, and any shadcn `ui/`
> primitive rendered on a marketing page fell back to a leftover `:root` ember accent instead of
> the actual brand color (confirmed live in the demo-call widget's CTA button, which rendered
> orange instead of matching the rest of the page). Fixed at the token level — see "The one
> shared display font," "Component shape & surfaces," and "Navigation" below for what changed.
>
> **What changed from the pre-ADR-039 fossil (2026-07-30 note, kept for history):**
> | Was (fossil) | Now (code reality) |
> |---|---|
> | Accent = indigo/violet `oklch(0.53 0.19 275)` | Accent = **monochrome near-black** `oklch(0.14 0 0)` (light) / near-white `oklch(0.93 0 0)` (dark) — ADR-039 |
> | Radius = 10px (`0.625rem`) | **12px** (`--radius: 0.75rem`) — ADR-043 |
> | One design identity | Two intentionally-scoped token sets (product `.theme-weeber`, marketing `.marketing`) sharing one design language and, as of 2026-08-27, one display font and one component-primitive contract |
> | Verticals: clinic, hotel (implied) | **`shopify` + `insurance` only** — the two that exist in code |
> | Background `oklch(0.98 0.012 85)` | `--weeber-paper: oklch(0.985 0.003 80)` (near-white, faint warm tint) |
> | Light/dark parity (unspecified structure) | ADR-044: `.theme-weeber` = light-monochrome, `.theme-weeber.dark` = dark-monochrome (warm hue 80, not steel-blue) |

Confirmed design direction for everything under `/dashboard` (admin panel) and `/app` (user dashboard).
Read alongside `architecture/README.md` / `architecture/user-flow.md` (page structure/scope). See
`docs/decisions/` ADR-032 (original direction) and ADR-039/043/044 (the corrections that made the old brief
stale).

## The reference point

**Arc browser** was the original touchstone — soft paper-like surfaces, warm neutral grays, calm but not
sterile. That warmth survives in the *surfaces* (warm-tinted paper, hue 80). But the **accent is now
monochrome, not colored** (ADR-039): the product deliberately dropped the indigo brand hue in favor of a
near-black/near-white accent so the only saturated colors on screen are semantic status colors (success /
warning / error). This is closer to Linear's restraint than the old "playful indigo" direction — a
deliberate reversal, documented here so nobody "restores" the indigo thinking it was lost by accident.

## The two visual identities — do not mix them

The codebase ships **two distinct surface-level token sets**, each scoped to its own root class.
Applying the wrong one to a surface is the single most common drift. They are:

1. **`.theme-weeber` (+ `.theme-weeber.dark`)** in `styles.css` — **the product.** Apply at the root
   layout element of every `/app` and `/dashboard` route. Monochrome, warm-paper, 12px radius. This is
   what 99% of feature work touches.
2. **`.marketing`** in `styles-marketing.css` — **the marketing site** (`landing.tsx` and everything
   under `MarketingPageShell`). Hex-based (`--m-bg: #FCFCFB`, `--m-accent-bg: #0B0B0C`, plus a
   `--m-accent-blue: #4E9FE8` used sparingly for decorative accents only), its own light/dark. Scoped
   to marketing pages only.

Bare `:root` (+ `.dark`) in `styles.css` is **not a third surface** — despite older versions of this
doc describing it as "the public marketing/waitlist landing page," nothing actually renders unscoped;
it's shadcn's own fallback default (an old *ember* palette, `--ember: oklch(0.53 0.19 35)`, warm
orange-red), read only by a `components/ui/*` primitive that ends up outside BOTH scoped classes
above. That was a real, shipped bug (2026-08-27) — the demo-call widget's `Button` rendered ember-
orange instead of the marketing page's actual black/white accent, because it was correct `.marketing`
markup but the ember fallback still won for any *unstyled* shadcn variable it read. Fixed by giving
`.marketing` its own scoped override of the same standard variable names (`--primary`, `--background`,
`--border`, etc. — see `styles-marketing.css`) mirroring `.theme-weeber`'s pattern 1:1, so any `ui/`
primitive is correct by construction on either surface now, no per-component color override needed.
**Do not reintroduce a component that reads a bare `:root` value directly** — go through the
standard variable names (`--primary`, `--background`, …), which resolve correctly inside whichever
scope the component actually renders in.

If you're building a feature, you want **#1** and nothing else. If you're building marketing-site
work, you want **#2** — and any `ui/` primitive you use there now works without extra styling.

## Product theme tokens (`.theme-weeber`) — as implemented

Light mode (`.theme-weeber`):

- **Radius:** `--radius: 0.75rem` (**12px**). Derived steps: `--radius-sm` 8px, `--radius-md` 10px,
  `--radius-lg` 12px, `--radius-xl` 16px.
- **Surfaces (warm, hue 80, very low chroma):**
  - `--weeber-paper` `oklch(0.985 0.003 80)` → `--background` (warm near-white).
  - `--weeber-paper-2` `oklch(0.995 0.001 80)` → `--card` / `--popover` (elevated, brighter than bg).
  - `--sidebar` `oklch(0.955 0.004 80)` — deliberately recessed vs paper and cards.
- **Ink:** `--weeber-ink` `oklch(0.14 0 0)` (near-black, full-strength text); `--weeber-ink-soft`
  `oklch(0.46 0 0)` → `--muted-foreground` (secondary text).
- **Accent (monochrome):** `--weeber-accent` `oklch(0.14 0 0)` → `--primary`; `--weeber-accent-soft`
  `oklch(0.92 0 0)` → `--accent` (hover/active fills); `--weeber-accent-foreground` `oklch(0.99 0 0)`.
- **Border:** `--weeber-border` `oklch(0.88 0.004 80)` → `--border` / `--input`.
- **Focus ring:** `--ring` `oklch(0.55 0 0)`.
- **Semantic set** (each with a `-soft` tint for backgrounds — banners use `*-soft` bg + full-strength
  text/icon, never a saturated fill):
  - success `oklch(0.52 0.14 150)` / soft `oklch(0.93 0.05 150)`
  - warning `oklch(0.62 0.15 80)` / soft `oklch(0.93 0.07 80)`
  - error `oklch(0.55 0.2 25)` / soft `oklch(0.93 0.06 25)` (→ `--destructive`)
- **Elevation:** four shadow tokens (`--weeber-shadow-card`, `-card-hover`, `-sidebar`, `-elevated`) —
  see "Component shape & surfaces."

Dark mode (`.theme-weeber.dark`, corrected 2026-07-18 per the ADR-044 readability fix):

- Warm hue 80 (not steel-blue 240): `--weeber-paper` `oklch(0.14 0.006 80)`, `--weeber-paper-2`
  `oklch(0.225 0.007 80)` — the paper/card gap was widened so cards visibly lift off the page.
- `--weeber-ink` `oklch(0.93 0 0)`; `--weeber-ink-soft` `oklch(0.71 0.004 80)` (lightened from 0.62 so
  secondary text reads against near-black). Border `oklch(0.32 0.006 80)`. Accent inverts to
  near-white `oklch(0.93 0 0)`.

**Structure rule (ADR-044):** `.theme-weeber` is light-monochrome, `.theme-weeber.dark` is
dark-monochrome. Older docs/comments that describe this inverted are wrong — this is the current shape.

## Typography

Fonts are loaded in `:root` and shared across surfaces — **one shared display font as of 2026-08-27**
(previously Fraunces on the product vs. an unused-fallback mismatch with marketing's own override;
see the reconciliation note at the top of this doc):

- **Sans — Inter Tight** (`--font-sans`): all UI text — labels, body, buttons, table content.
- **Display — Bricolage Grotesque** (`--font-display`): headings/section titles only — page titles,
  card section headers, empty-state headlines, marketing hero/section headlines. The one display
  face across marketing, `/app`, and `/dashboard` — a confident grotesque-sans, not a serif; closer
  to the Vercel/ElevenLabs reference point this unification pass was aiming for.
- **Mono — JetBrains Mono** (`--font-mono`): technical strings — API keys, webhook URLs, org IDs,
  code/JSON previews. `.font-mono-label` utility exists for this.

## Component shape & surfaces

- **12px rounding** (`--radius`) — modern SaaS, not stark/technical, not pill-shaped. Marketing
  mirrors the same scale via `--m-radius-sm/md/lg` (`styles-marketing.css`, 2026-08-27 — was a
  grab-bag of literal `rounded-[Npx]` values with no shared token before).
- **Mixed surface treatment, not one rule everywhere:**
  - Inline content (table rows, list items, inline cards) — flat, thin 1px `--border`, no shadow.
  - Modals, popovers, dropdowns, command palette, toasts — soft elevation shadow (`--weeber-shadow-*`),
    since these float above the page and a border alone won't read as "above."
- Shared classes exist and should be reused rather than re-rolled: `.card-weeber` (base card,
  `--weeber-shadow-card` + hover lift), `.card-weeber--editor`, `.row-hover`, `.card-lift`,
  `.card-action`. shadcn `new-york` style (`components.json`) is the component baseline.
- **Known debt (do not copy, being paid down):** `tools/ui-guard/design-budget.json`'s `rawButton`/
  `inlineCardClone` ratchets track this precisely — ~half of `/dashboard` pages and most of the
  marketing site hand-roll raw `<h1>` + `border/bg-card` + raw `<button>` instead of `PageHeader` /
  `card-weeber` / `Button`. New work must use the shared primitives so the system has one
  enforcement level, not two. The ratchet only ever moves down when a real migration lands
  (`design:guard --update` after, never before) — see `WaitlistForm.tsx`, `MarketingNav.tsx`, and
  `EnterpriseDialog.tsx` (2026-08-27) for the pattern: swap the tag, drop now-redundant color
  overrides once the surface's tokens are unified, keep custom sizing via `className`.

## Density — different per audience, same component system

- **Admin panel (`/dashboard`):** dense. Ops staff live here all day — tighter rows, more columns, less
  whitespace. Data-grid-first for list views (calls/orgs/compliance).
- **User dashboard (`/app`):** spacious. Users visit less often and need guidance — generous whitespace,
  larger targets, fewer things on screen, room for empty-state/onboarding copy.
- Same `.theme-weeber` tokens and shadcn components power both; density is a spacing/sizing variant, not
  a second design system.

## Verticals — the product adapts per vertical (`lib/verticals.ts`)

**Exactly two verticals ship today: `shopify` and `insurance`.** (`VERTICALS = { shopify, insurance }`;
default fallback = `shopify`.) There is **no clinic or hotel vertical** — any doc, comment, or note that
says otherwise is stale.

After signup the user's vertical drives, via a `VerticalDefinition`:

- **`glossary`** — e.g. Shopify "Customer/Customers" vs insurance "Policyholder/Policyholders".
- **`copy`** — hero labels, sublabels, empty-state language.
- **`dashboard`** — which metrics/funnel stages the Home dashboard renders (Shopify: carts abandoned →
  recovery calls → carts recovered → revenue recovered → AOV, plus COD-confirmation metrics; insurance:
  its own metric set).

Build vertical-aware surfaces by reading the active `VerticalDefinition`, never by hardcoding
Shopify-specific terms into shared components.

## Animation

**Tasteful micro-interactions — 200–400ms, restrained.** Within-page interactions get polish;
page-to-page navigation is **instant (no route transitions)**.

- Hover/focus: color/border transitions ~150–200ms ease.
- Dropdown/popover/modal open-close: scale + fade ~200–250ms.
- Toasts: slide + fade ~300ms.
- Skeleton→content: brief crossfade ~200ms, not an abrupt pop.
- `prefers-reduced-motion: reduce` is handled globally in `styles.css` — new animation inherits this, no
  per-component opt-out needed.

## Loading, empty, and error states

- **Loading:** content-shaped skeletons (a table skeleton has the right columns/rows), not spinners, not
  blank screens.
- **Empty/error:** minimal, text-only, no illustrations. `--font-display` headline + one plain-language
  line + a single clear action if one exists. `EmptyState` / `PageHeader` components exist for this.

## Navigation

**Left sidebar + command palette (Cmd+K), both together.** Sidebar for primary navigation; command
palette for quick jump-to-page and quick actions. One shared command-palette component, reused in both
dashboards. The `/app` sidebar is vertical-aware (labels come from `verticals.ts`). The `/dashboard`
admin nav is **grouped** (2026-08-27 — was a flat 18-item list, long named as a pending
recommendation): **Ops** (Calls, Demo Calls, Agents, Analytics, Workflows), **Compliance**
(Compliance, Do Not Call), **Accounts** (Orgs, Users, Waitlist, Billing, Revenue, Marketing),
**Config** (Templates, Flags, Broadcasts, Support, Logs, Keys) — `app-shell.tsx`'s `NavItem` gained
an optional `group` field for this; items sharing an adjacent `group` value render under one label,
ungrouped items (e.g. the `/app` sidebar) render exactly as before.

- **Nav-intent chunk prefetch (why nav feels instant).** Every in-shell page is `lazy()`-loaded, so a
  first click used to blank the content area behind `PageFallback` while the chunk downloaded — read as a
  "full page reload." `NavLink` now warms the target chunk on hover/focus/touch via
  `lib/route-prefetch.ts` (registered from `app.tsx`, keyed by nav href), so by click time the module is
  cached and `<Suspense>` never falls back. Best-effort and additive — a missing entry just skips the
  warm-up, no correctness impact. Keep the registry in sync when adding a route.

## Shell layout — one container contract

The shell (`components/shell/app-shell.tsx`) owns the page container so pages don't re-roll it:

- **Standard (default):** `<main>` is centered, `max-width`-clamped, and padded via the density tokens
  (`--shell-page-max-w/-px/-py`). Natural document scroll; sticky page headers work. Every page is
  standard unless it opts out.
- **Full-bleed (opt-in):** a page that needs the whole viewport (the workflow canvas) calls
  `useShellFullBleed()`. The shell then drops the max-width/padding and makes the content area a
  fixed-height flex column (`h-[100dvh]`, no document scroll) so the page can fill edge-to-edge with an
  internal `flex-1 overflow-hidden` region. The hook cleans up on unmount, so navigating away restores the
  standard container automatically. Do **not** hand-roll `h-[calc(100vh-Nrem)]` inside a padded `<main>` —
  that fights the container and overflows.

## Onboarding

**Multi-step wizard with a visible progress indicator** (the setup modal). Small steps to feel
low-effort. The progress indicator is part of the "zero setup" pitch. First step is **vertical
selection** — this choice cascades into glossary/copy/dashboard for the whole session.

## Responsiveness

**Desktop-first.** Must not visibly break on mobile (no horizontal scroll, no unusably cramped targets),
but mobile is not a v1 polish target — both users and ops staff are expected on a laptop.

## Accessibility — WCAG AA (real requirement, not best-effort)

Build to AA from the start. **Verify against code, don't assume — the current audit found real gaps:**

- **Contrast:** body ink on paper passes comfortably. **The known failures are small colored text on
  `-soft` tints** (status-color-on-soft badges) and any product text below 12px. Fix: no product text
  below 12px, lift `muted-foreground` secondary text toward 13–14px, and re-check the status-on-soft
  pairs with axe/Lighthouse.
- **Keyboard:** every interactive element reachable/operable; visible focus via `--ring`.
- **Semantic HTML + ARIA** where shadcn/Radix primitives don't already cover it — verify custom-built
  components (icon-only buttons need labels; toasts need live regions; charts need a data-table or
  `aria` summary fallback since they're currently color-only).
- **Heading hierarchy** pairs naturally with the serif-headings-only rule.

## What's still NOT decided — flag before building

- Exact "dense" vs "spacious" spacing scale values — size these when laying out real pages, not in the
  abstract.
- Logo/wordmark — still a text wordmark placeholder; final brand assets undecided.
- Command-palette action list — grows with the pages/actions that exist; don't over-build ahead of need.
- Billing checkout — there is **no payment gateway wired** (`gateway: null`, plan CTAs are `mailto:`).
  Until one exists, tiers should read "contact us to upgrade," not checkout-style "Upgrade" CTAs.
