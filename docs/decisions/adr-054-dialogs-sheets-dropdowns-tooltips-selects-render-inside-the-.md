---
adr: 54
title: "Dialogs/sheets/dropdowns/tooltips/selects render inside the themed shell via a portal-container context (2026-07-13)"
date: 2026-07-13
status: Accepted
---

## ADR-054 — Dialogs/sheets/dropdowns/tooltips/selects render inside the themed shell via a portal-container context (2026-07-13)

**Context:** Audit #04 (`docs/audits/2026-07-13-audit-04-uiux.md`) reconfirmed a bug first documented in
`docs/UI-UX-AUDIT-CONTEXT.md` §1: every Radix Portal-based overlay (Dialog, Sheet, DropdownMenu, Tooltip)
defaulted to portaling into `document.body`, outside the shell `<div>` carrying the
`.theme-weeber`/`.dark` classes (`app-shell.tsx`). Overlays silently fell back to `:root`'s default
(old ember/light) theme regardless of the user's actual theme. The audit also found a second, stacked bug:
the mobile nav Sheet's custom slide animation targeted `[data-radix-dialog-content]` — an attribute Radix
never actually emits — so it was dead on arrival even before the portal issue.

**Decision:** rather than promoting `.theme-weeber`/`.dark` to `<body>` (the audit doc's alternative
option — simpler in principle, but risks touching the marketing/landing pages, which deliberately never
read those classes today), added a small `PortalContainerContext`
(`packages/web/src/web/lib/portal-container.ts`) that `AppShell` provides via a ref to its own themed
root div. `Dialog`, `Sheet`, `DropdownMenu`, `Tooltip`, and `Select` (shadcn ui/ primitives) all read it
and pass the DOM node as their Radix `Portal`'s `container`. An explicit `container` prop, if ever passed
manually by a caller, still wins over the context default. Pages rendered outside any `AppShell`
(marketing/landing) get `null` from the hook and keep Radix's default `document.body` behavior unchanged
— `EnterpriseDialog.tsx`'s existing hardcoded `dark:` workaround for exactly this class of bug is
untouched, by design, since it never sits inside a themed shell to begin with.

Also fixed the dead CSS alongside this: `[data-radix-dialog-content]` → `[data-slot="sheet-content"]`
(the sheet's real DOM attribute), plus added `data-side={side}` to `SheetContent` so the
`[data-side="left"]` qualifier has something to match too — both the portal-escape bug and the wrong-
attribute-name bug are now genuinely fixed, not just one of the two.

`portal-container.ts` is deliberately a standalone module, not exported from `app-shell.tsx` — the ui/
primitives it's imported into (`sheet.tsx`, `tooltip.tsx`) are themselves imported by `app-shell.tsx`,
so putting the context there would create a circular import.

**Consequence:** every overlay in the authenticated product (`/app/*`, `/dashboard/*`) now correctly
inherits whatever theme the shell is in, including any future theme changes — no more per-component
`dark:` hardcoding needed as a workaround (don't reintroduce that pattern; fix at the shell if a new
one-off appears). No visual change for anyone already on the correct theme in a non-portaled context;
this only changes where portaled overlays *render into*, not their content or styling.
