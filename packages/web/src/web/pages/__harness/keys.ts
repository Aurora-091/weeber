/**
 * The screenshot inventory, as data only.
 *
 * Deliberately free of React, CSS and page imports so that e2e-visual/ can
 * import it directly. Importing it from __harness/index.tsx instead would drag
 * every private page and the stylesheet into the Playwright node process, where
 * they cannot resolve.
 *
 * Keys appear verbatim in baseline filenames, so renaming one orphans its
 * baseline. Add; do not rename.
 *
 * __harness/index.tsx asserts at type level that this list and its page map
 * have exactly the same members, so a page cannot be added to one and forgotten
 * in the other.
 */
export const HARNESS_KEYS = [
  "app-agents",
  "app-billing",
  "app-calls",
  "app-home",
  "app-integrations",
  "app-knowledge-base",
  "app-leads",
  "app-numbers",
  "app-orders",
  "app-settings",
  "app-workflows",
  "dash-agents",
  "dash-analytics",
  "dash-billing",
  "dash-calls",
  "dash-compliance",
  "dash-dnc",
  "dash-flags",
  "dash-orgs",
  "dash-settings",
  "dash-templates",
  "dash-users",
  "dash-waitlist",
] as const;

export type HarnessKey = (typeof HARNESS_KEYS)[number];
