# UI/UX — Audit Context & Checklist

> **STATUS (2026-07-13, later same day): superseded for items 1, 2, 4, 5, 7 — see the checklist in
> §6 below and `audit/2026-07-13-audit-04-uiux.md` for what actually got fixed/built afterward
> (theme portal fix = ADR-054, agent full-window layout = ADR-055, Settings page shipped, nav-label
> fixed, Workflow Canvas shipped with its own new bugs found+fixed). The narrative sections below
> (§1-§5) describe the *original* bug reports and are kept for historical context/root-cause detail
> — read §6 first for current status before assuming anything below is still true.
>
> **Purpose of this doc**: single entry point for the UI/UX audit pass (to be run in a different
> chat/agent, not this session). Everything below is *verified against the actual codebase* as of
> 2026-07-13, not assumed from memory. Related docs are linked inline instead of duplicated.

---

## 0. How to use this doc

This is a **checklist + root-cause file**, not a build plan. The audit agent should:
1. Read this doc first.
2. Read the linked docs for anything already speced (`AGENT-CONSOLE-UI-PLAN.md`,
   `UI-DESIGN-BRIEF.md`, `docs/workflow-canvas-architecture.md`).
3. Treat "Confirmed root cause" items below as ready to fix directly — no need to re-diagnose.
4. Treat "Needs a design decision" items as open questions for whoever runs the audit to decide,
   not silently pick a default.

---

## 1. Theme system — confirmed root cause (the "crazy theme" bug)

**Symptom reported**: preview drawer and some dialogs open in white/light while the rest of the
app is dark. Some components still show the old orange/ember brand color instead of the new
monochrome black-and-white theme.

**Root cause — one bug causes both symptoms:**

- The app has two theme layers, both applied as CSS classes on a single shell `<div>` in
  `packages/web/src/web/components/shell/app-shell.tsx` (line ~108-112):
  - `.theme-weeber` — the new monochrome black/white brand (`packages/web/src/web/styles.css`,
    defined ~line 283). This is the intended, current brand.
  - `.dark` — light/dark mode, controlled by `packages/web/src/web/lib/theme.ts`'s `useTheme()`.
- **Neither class is on `<html>` or `<body>`** — by design (per `theme.ts`'s own comment, so the
  public marketing/landing pages aren't affected).
- **The bug**: shadcn's `Dialog`, `Sheet` (and therefore the new `PreviewDrawer` from
  `AGENT-CONSOLE-UI-PLAN.md`), and any other Radix-based overlay use `<Portal>` with no `container`
  prop set (`packages/web/src/web/components/ui/dialog.tsx` line ~57,
  `.../ui/sheet.tsx` line ~56). Radix's default Portal target is `document.body` —
  **outside** the shell div that carries `.theme-weeber` and `.dark`.
- Result: every dialog/sheet/drawer in the product silently falls back to `:root`'s *default*
  CSS variables (`packages/web/src/web/styles.css` ~line 68-94) — which is the **old ember/orange
  theme, in light mode** — regardless of what the user picked or what theme the rest of the page
  is using. This is not random — it happens to *every* Radix-portaled overlay, consistently.

**The fix (one place, fixes both symptoms):**
- Give `Dialog`/`Sheet` (and any other Radix `Portal` usage found — audit for more) an explicit
  `container` prop pointing at the shell root div, OR move `.theme-weeber`/`.dark` up to `<body>`
  and scope marketing pages with their own override class instead (the `.marketing` class already
  exists at `packages/web/src/web/styles.css` ~line 456 and could carry an explicit light/ember
  override if needed).
- Second option is structurally simpler (portals just work, no special-casing per component) but
  needs someone to confirm the marketing/landing pages truly never read `.dark`/`.theme-weeber`
  today (spot check first — `EnterpriseDialog.tsx` on the landing page already hardcodes
  `!bg-white dark:!bg-[#0A0A0A]` manually, which is a workaround for exactly this class of problem,
  done locally instead of at the root).
- Whichever fix is picked, sweep the whole app for other Radix `Portal` consumers
  (`DropdownMenu`, `Popover`, `Tooltip`, `Select`, `Toast`/`sonner`) — same bug likely affects all
  of them, just less noticeably since most are small enough that the light/orange flash is easy to
  miss.

**Do NOT**: patch this per-dialog with hardcoded `dark:` classes like `EnterpriseDialog.tsx` did —
that's the workaround that let the bug spread. Fix the portal/scoping root cause once.

---

## 2. Agent page layout — redesign not yet built

**What was asked for**: agent config should open as a genuinely full-page/full-window experience —
a small pill/dropdown at the top with the agent name, used to switch between agents, and nothing
else in that top area. The page itself takes the full window. Left sidebar (main app nav) should
still be present but **closable/collapsible**, not a fixed permanent rail.

**What exists today** (`packages/web/src/web/pages/app/agents.tsx`,
`packages/web/src/web/pages/dashboard/agents.tsx`): a single-column accordion form sitting inside
the normal app-shell layout (persistent left sidebar, no collapse). No agent-switcher pill/dropdown
at the top — agent selection today is a `templateKey`-driven set of sections/tabs on the same page,
not a dropdown-driven full-page swap.

**Relationship to `AGENT-CONSOLE-UI-PLAN.md`**: that plan (Phase 1+2 shipped 2026-07-12) covers the
**Preview drawer** (voice test call, orb, text chat) — a *different* piece of work, already built.
It explicitly does **not** touch the page layout ("Not rebuilding the page layout... config form
stays exactly as it is today" — see its §4). So: the Preview drawer work is done and is not what's
being asked for here. The full-page/pill-dropdown/collapsible-sidebar layout is a **separate,
not-yet-scoped redesign** — nothing has been built for it yet.

**Needs a design decision before building**:
- Does "closable left sidebar" mean collapse-to-icons (like most SaaS admin shells) or fully hide
  with a hamburger toggle?
- Does the agent-switcher pill/dropdown replace the current page header entirely, or sit alongside
  a slimmed-down one?
- Confirm this applies to both `/app/agents` (merchant) and `/dashboard/agents` (admin) — the
  shared-schema pattern (`voice/agent-frame.ts`) suggests yes, for consistency, but admin has an
  org-picker today that merchant doesn't — needs to be accounted for in the new layout.

---

## 3. Merchant-side Settings/Profile page — missing

**Confirmed**: `packages/web/src/web/pages/dashboard/settings.tsx` exists (admin-only). There is
**no equivalent page under `pages/app/`** — merchants have no settings/profile page at all today.
Nothing to fix here yet, this is a net-new page to build. Scope needs defining: what should live on
it (org name/branding, notification prefs, password/account, timezone, billing contact info vs. the
existing separate `/app/billing` page, etc.) — audit should define the scope, not assume it.

---

## 4. Integration page naming — confirmed inconsistency

**Symptom reported**: the integrations page is called "Shopify" on the frontend even though the
URL/route is about integrations generally.

**Confirmed**: `packages/web/src/web/lib/verticals.ts` line 49 —
`const SHOPIFY_INTEGRATION_LABEL = "Shopify";` — this is what renders as the **left nav sidebar
label** (line 66) for the route `/app/integrations`. The in-page `<PageHeader>` title on
`integrations.tsx` itself is correctly "Integrations" (line ~481) — it's specifically the **nav
sidebar item label** that says "Shopify".

This was a deliberate per-vertical naming choice (the comment above it explains verticals get their
own integration label, e.g. a future non-Shopify vertical would show a different word) — but as a
UX symptom it reads as "the nav says Shopify, the page says Integrations," which is the exact
inconsistency reported. Fix is either: rename the nav label to match ("Integrations" everywhere,
losing the per-vertical flavor), or keep per-vertical naming but make sure it's used consistently
in both the nav *and* the page header (i.e. page header should read "Shopify" too, not
"Integrations") — a design decision on which direction wins, not a pure bug.

---

## 5. Related docs — don't duplicate, read these

- `AGENT-CONSOLE-UI-PLAN.md` — Preview drawer / voice test call feature. Phase 1+2 **shipped**
  2026-07-12. Phase 3 intentionally not started (documented reasons in its §3). Not the same thing
  as the agent-page layout ask in §2 above — don't conflate the two.
- `UI-DESIGN-BRIEF.md` — general design system rules (elevation, modal/popover treatment, etc.).
  Referenced by `AGENT-CONSOLE-UI-PLAN.md` already; audit should check whether the theme-scoping bug
  in §1 above needs a correction note added to this brief once fixed, so it doesn't regress.
- `docs/workflow-canvas-architecture.md` — the drag-drop workflow canvas (Klaviyo-style trigger/
  wait/call/split graph). Separate initiative, backend data model spec'd, **not built yet**
  (no `workflow_runs` table, no canvas UI). Only mentioned here because "canvas" work was raised —
  confirming there is no canvas UI shipped anywhere yet, this doc is architecture-only so far.
- `changelog.md` / `DECISIONS.md` (ADR-051) — what actually shipped for the Preview drawer, in case
  the audit needs to check exact commit history/dates.

---

## 6. Checklist — status snapshot for the audit to start from

| # | Item | Status |
|---|---|---|
| 1 | Theme bug: dialogs/drawers open in wrong theme + old orange color | **FIXED** (2026-07-13, ADR-054) — `PortalContainerContext` makes Dialog/Sheet/DropdownMenu/Tooltip/Select portal into the themed shell instead of `document.body`; also fixed the dead `[data-radix-dialog-content]` selector (wrong attribute name) found in audit #04 |
| 2 | Agent page: full-page layout, top pill/dropdown agent switcher, collapsible left sidebar | **BUILT** (2026-07-13, ADR-055) — new `AppShell` `fullBleed` prop, always-visible pill switcher, both `/app/agents` and `/dashboard/agents` |
| 3 | Preview drawer (voice test call, orb, text chat) on agent pages | **Shipped** 2026-07-12 (Phase 1+2) — separate from #2, don't redo. Re-verified working after #2's layout change (backend suites 19/19, wiring untouched) |
| 4 | Merchant-side Settings/Profile page | **Shipped** — `pages/app/settings.tsx`, reviewed in audit #04, no action needed |
| 5 | Integration nav label says "Shopify" instead of matching page title "Integrations" | **FIXED** — both nav and page header now read `vertical.integrationLabel`, verified consistent |
| 6 | Old openvent orange/ember theme remnants in components | Root cause was the same as #1, now fixed alongside it — a future audit should spot-check for anything still orange that *isn't* portal-related (would indicate a second, separate source), but no such case is known as of this update |
| 7 | Workflow canvas (drag-drop trigger/wait/call graph) | **BUILT** since this doc was written (`components/canvas/*`, `pages/app/workflows.tsx`, `pages/dashboard/workflow-editor.tsx`) — see `docs/workflow-canvas-architecture.md`'s status note. Audit #04 found and fixed 2 new P1 bugs in it (stale "Saved" state, fetch errors masked as empty/not-found) — never audited before that pass |

---

## 7. Explicit non-scope (per earlier conversation)

- Don't rebuild the Preview drawer — it's done, working, and separate from the agent-page layout
  ask.
- Don't start building the workflow canvas as part of this UI/UX pass unless the audit explicitly
  decides to pull it in — it's a bigger, separately-scoped initiative.

---

## 8. Audit pass — 2026-07-16 (merchant app: toasts, sidebar, "some pages refresh", duplication)

**Symptom reported**: toasts render "below the cards and frame" instead of floating over everything;
sidebar feels visually "weightless" with no real animation; some `/app` pages transition smoothly on
navigation while others feel like "the whole site refreshes"; icon spacing inconsistent in the
sidebar; general UI duplication.

### 8.1 Toast positioning — confirmed root cause, FIXED

Same bug class as §1's theme-portal issue, just never caught for this specific element.
`<Toaster>` (sonner) is **not a real DOM portal** — it renders exactly where it's placed in the
React tree, which in `app-shell.tsx` is a direct child of the `.theme-weeber` div. The blanket
`.theme-weeber > * { position: relative; z-index: 1; }` rule (added for the grain-texture
z-index scheme) was winning a same-specificity, later-source-order tie against sonner's own
`[data-sonner-toaster] { position: fixed }` rule — so every toast laid out in normal document flow
(pushed below the sidebar/page content) instead of floating fixed at the viewport corner.

**Fix**: added `.theme-weeber > [data-sonner-toaster]` to the existing higher-specificity
`position: fixed` exception list (the same list that already carries Dialog/Sheet/Popover/Tooltip
overlays for exactly this reason) — `styles.css`. Verified against the real compiled CSS output in
a real browser (not just reasoning about specificity): `getComputedStyle(toaster).position ===
"fixed"` after the fix, confirmed source-order after the generic rule.

### 8.2 "Some pages refresh, others load smoothly" — investigated, real cause found (not a routing bug)

Checked for actual hard-navigation bugs first (the literal complaint): every internal link in
`/app` uses wouter's `<Link>` correctly (`grep` for raw `<a href>`/`window.location.href` pointing
at internal routes found none — the only hits are legitimate `mailto:`, an external recording URL,
and OAuth `installUrl`/sign-out redirects, all correctly hard-navigations by design). `UserShell` is
rendered once at the top of the route tree wrapping a `<Switch>` — confirmed the sidebar does NOT
remount between pages architecturally. Nav item hrefs in `verticals.ts` all match a registered
`<Route>`.

**Actual cause**: `pages/app/settings.tsx`'s root element was a bare `<>...</>` fragment — the only
page under `/app` missing the `page-enter` (or `content-fade-in`) animation class every other page
has. Every other page fades/slides in (`page-enter`, 0.35s cubic-bezier); Settings just snapped into
view with zero transition, which reads as "the page refreshed" by contrast when navigating from an
animated page. **Fixed** — wrapped in `<div className="page-enter">`, matching the exact convention
used by `numbers.tsx`/`knowledge-base.tsx`/etc.

### 8.3 Sidebar weight + animation — improved

- Collapse/expand width transition used a plain `ease-out` — a different motion feel from every
  other animated surface in the app (`page-enter`/`content-fade-in` both use
  `cubic-bezier(0.16,1,0.3,1)`). Now uses the same curve for consistency.
- `--weeber-shadow-sidebar` (light + dark) was a single soft, low-opacity blur — bumped to a crisp
  1px edge + a deeper ambient shadow for more visual "weight" without becoming heavy-handed.
- Nav items: icon size `15px` → `16px`, icon-to-label gap `2.5` → `3`, vertical padding `py-2` →
  `py-2.5`, item-to-item gap `1` → `1.5`, active item now also gets `font-semibold` (previously only
  a background color change) — slightly more visual presence for the active state and a bit more
  breathing room throughout, addressing the "icon spacing" note directly.

### 8.4 UI duplication found

- **Fixed**: `.theme-weeber .card-elevated` — a second, "legacy" card-elevation CSS class alongside
  the actual live one (`.card-weeber`) — had **zero usages** anywhere in the codebase (confirmed via
  `grep -rl card-elevated **/*.tsx` → no results). Dead duplicate system, removed.
- **Noted, not fixed (low-impact, deliberately deferred)**: `pages/app/numbers.tsx` hand-copies the
  input styling string (`"rounded-md border border-border bg-background px-3 py-2 text-sm outline-
  none focus:ring-2 focus:ring-ring/40 h-9"`) instead of importing the shared `fieldCls` constant
  already exported from `lib/agent-config.ts` for this exact purpose. One line, cosmetic, left as a
  quick-fix note rather than churning a working page for a single class string.
- **Found, needs a decision (not fixed)**: ADR-055's `fullBleed` full-window agent-console layout
  is now **dead code**. `AppShell`/`UserShell`/`DashboardShell` all still carry the `fullBleed?:
  boolean` prop plumbing, but `UserAppRoutes()` in `app.tsx` renders a single persistent `<UserShell>`
  wrapping the whole `<Switch>` (the "shell stays mounted across navigations" refactor) and never
  passes `fullBleed` — so the prop is permanently `false` for every merchant page today, unreachable.
  This session's separate agent-page rebuild (dedicated `/app/agents/:agentKey` route, tabs, commit
  `308c22d`) supersedes ADR-055's pill-switcher approach anyway per the user's explicit direction in
  this session, but the dead `fullBleed` plumbing itself is still sitting in three files unused. Left
  as-is rather than guessing whether to delete it or wire it back up — that's a real product decision
  (does anything still want a full-window/no-padding page mode?), not a pure bug fix.

### 8.5 Verified

Typecheck (api+web), oxlint, and `bun run build` all green after every change in this section.
Toast fix additionally verified empirically in a real browser against the actual compiled CSS
output (not just specificity reasoning). Full backend test suite unaffected (260 pass, same
pre-existing baseline — this pass touched no backend code). Could not click through the live
merchant app with real auth in this sandbox (no production session available here) — the sidebar/
icon-spacing changes are CSS/class-level only and low-risk, but worth a quick visual look after
deploy.
