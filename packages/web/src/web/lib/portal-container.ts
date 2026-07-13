import { createContext, useContext } from "react";

/**
 * Fixes the "dialogs/sheets/dropdowns render in the wrong theme" bug
 * (audit #04 §1 / docs/UI-UX-AUDIT-CONTEXT.md §1): Radix's Portal-based
 * components (Dialog, Sheet, DropdownMenu, Tooltip) default to portaling
 * into `document.body`, which sits *outside* the shell `<div>` that carries
 * the `.theme-weeber`/`.dark` CSS classes (see app-shell.tsx). That made
 * every overlay silently fall back to `:root`'s default (old ember/light)
 * theme regardless of what the user picked.
 *
 * AppShell provides the shell root DOM node here once mounted; the ui/
 * primitives (dialog.tsx, sheet.tsx, dropdown-menu.tsx, tooltip.tsx) read it
 * and pass it as the Portal's `container`, so overlays render *inside* the
 * themed shell instead of escaping it.
 *
 * Deliberately a standalone module (not exported from app-shell.tsx itself)
 * to avoid a circular import — app-shell.tsx already imports Sheet/Tooltip
 * from those same ui/ files.
 *
 * Pages rendered outside any AppShell (marketing/landing pages) get `null`
 * here, so their Portal-based components fall back to Radix's own default
 * (`document.body`) exactly as before — unaffected by this fix.
 */
export const PortalContainerContext = createContext<HTMLElement | null>(null);

export function usePortalContainer(): HTMLElement | null {
  return useContext(PortalContainerContext);
}
