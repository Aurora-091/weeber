---
adr: 68
title: "Product layout responds to the content column, not the viewport — @container in AppShell, container variants in every product route"
date: 2026-08-01
status: Accepted
---

## ADR-068 — Product layout responds to the content column, not the viewport
**Date:** 2026-08-01

**Context:** Every product route renders inside `AppShell`'s `<main>`. The desktop sidebar is
`hidden md:flex` at `w-56` (`web/components/shell/app-shell.tsx:307,315`) — it appears at the `md`
breakpoint, 768px, and takes 224px. `--shell-page-px` is `2rem` in spacious density
(`styles.css:478`), so another 64px goes to padding.

Grid columns throughout the product were written with **viewport** breakpoints — 28 occurrences of
`sm:grid-cols-*` across `pages/app/`. `sm` is 640px. So from 640px to 767px the layout was reasoning
about a content column that really was ~576px wide, and then at exactly 768px the sidebar appeared and
the content column **dropped by 223px to ~480px** while every breakpoint reported that the screen had
just got *bigger*.

Measured at 768px against the preview harness, `sm:grid-cols-3` produced three 149px cards. The result
on `/app/integrations`:

- Telephony cards rendered **"Not connected" one letter per line**, as vertical text.
- The "Download as Excel" button in the Export Data cards **escaped its card**.
- `/app/agents` truncated an agent's name to `"COD co…"`.

None of this was a page-level horizontal scrollbar, which is why it had never been caught — the
document `scrollWidth` was correct on every page at every width. The damage was entirely inside
correctly-sized containers.

A second, quieter symptom sat underneath the same cause. The sidebar is collapsible (`w-56` →
`w-[3.25rem]`, `app-shell.tsx:315`), which hands the content column another 170px. Nothing reflowed,
because the viewport had not changed and viewport breakpoints are the only thing the layout could see.
Collapsing the sidebar bought whitespace, not density.

**Alternatives considered:**

1. **Shift each breakpoint up one step** — `sm:grid-cols-3` → `lg:grid-cols-3`, and so on. Smallest
   diff, no new CSS concepts. Rejected: it re-encodes the current sidebar width into ~28 class strings.
   Change `w-56`, change the `md` threshold, add a second rail, or collapse the sidebar, and every one of
   them is silently wrong again. It also cannot fix the collapse case at all — no viewport breakpoint
   can, by construction.
2. **A JS width observer feeding a layout context.** Rejected: a `ResizeObserver` and re-render for
   something CSS does natively and synchronously, and it would fire on every animation frame of the
   sidebar's 200ms width transition.
3. **Container queries.** Tailwind v4.2 supports `@container` and `@`-prefixed variants natively, no
   plugin. The breakpoint then describes the thing it actually governs.

**Decision:** Both `<main>` elements in `AppShell` — the default padded one and the full-bleed one —
carry `@container`. Grid columns in product routes use container variants sized against the content
column, not the viewport:

| Old | New | Container width needed |
|---|---|---|
| `sm:grid-cols-2` | `@xl:grid-cols-2` | 36rem |
| `sm:grid-cols-3` | `@xl:grid-cols-2 @4xl:grid-cols-3` | 36rem / 56rem |
| `sm:grid-cols-4` | `@md:grid-cols-2 @4xl:grid-cols-4` | 28rem / 56rem |
| `sm:grid-cols-2 xl:grid-cols-3` | `@xl:grid-cols-2 @4xl:grid-cols-3` | 36rem / 56rem |

The floor those numbers protect is roughly **280px per card**, which is the width below which the
Integrations and Agents cards start clipping their own contents.

**Scope — what deliberately did not change.** Marketing pages have no sidebar; their viewport
breakpoints are honest and are untouched. Dialogs and Sheets portal **outside** `<main>`, so they have
no query container and container variants would silently never match — `pages/app/leads.tsx:725` and
`components/app/setup-modal.tsx:257` keep `sm:` for that reason, and `leads.tsx` is the one entry in
the regression test's allowlist.

**Consequences:**

- Some layouts are now more conservative than before at a given viewport, because they are being honest
  about the room they have. `/app/agents` at 1280px is two columns rather than three; the content column
  there is 992px, and three cards would be 320px each with the sidebar open. **Collapse the sidebar and
  it becomes three columns** — verified: at a 1180px viewport the agents grid goes 2 → 3 columns on
  collapse, which it could not have done before.
- `container-type: inline-size` makes the element a containing block for `position: fixed` descendants.
  Checked before landing: there are no `fixed` elements inside `pages/app/`, `components/app/`,
  `components/shell/`, or `components/agent-preview/`. Anything added later that needs viewport-fixed
  positioning must portal out, the same rule dialogs already follow.
- **The convention is enforced, not documented-and-hoped.** `pages/app/responsive-grid.test.ts` fails on
  any bare `(sm|md|lg|xl|2xl):grid-cols-*` in `pages/app/` or `components/shell/`, and asserts both
  `<main>` elements still carry `@container`.

**Verification:** a Playwright sweep of 8 product pages × 10 viewport widths (390 → 1440), measuring
document overflow plus every element extending past the viewport or clipping its own content, went from
**3 of 40 combos flagged** to **0 of 80**. Light and dark confirmed by screenshot at 768/1024/1280.

**Not verified:** `/app/home`'s metric strips are data-driven and render empty against the preview
harness (no auth), so the `sm:grid-cols-4` → `@md`/`@4xl` change there passed the automated sweep
without any tiles present. Mechanical change, but it has not been seen with real data.
