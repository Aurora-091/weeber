import type { Page } from "@playwright/test";

/**
 * Everything a page must have finished doing before a screenshot is allowed to
 * be taken. Each step here exists because of a specific way a screenshot goes
 * non-deterministic — none of them are decoration.
 */

/**
 * Block the API before the first navigation.
 *
 * The harness seeds react-query with staleTime:Infinity, but unseeded queries
 * still fire. Against `vite preview` those requests hit a static file server
 * which answers the SPA index.html with a 200 — so a fetch that should fail
 * instead resolves with HTML, and the page renders whatever a JSON parse error
 * produces. Aborting makes the failure honest and identical every run.
 */
export async function blockApi(page: Page) {
  await page.route("**/api/**", (route) => route.abort());
  await page.route("**/*.{woff,woff2,ttf}", (route) => route.continue());
}

/** Pin the product theme. Read from localStorage by lib/theme.ts. */
export async function presetTheme(page: Page, theme: "light" | "dark") {
  await page.addInitScript(
    ([key, value]) => window.localStorage.setItem(key, value),
    ["weeber_theme", theme] as const,
  );
}

/**
 * Wait for fonts, layout and animation to be finished.
 *
 * `document.fonts.ready` is the important one: web fonts land after first paint,
 * and a screenshot taken before they do captures fallback metrics — different
 * glyph widths, different line wrapping, different element heights. That alone
 * produces a diff on every second run.
 */
export async function settle(page: Page) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => document.fonts.status === "loaded", null, { timeout: 15_000 });
  // Two frames: one for the layout the fonts just changed, one for it to paint.
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
  await page.waitForTimeout(150);
}

/** Wait for a harness page to report that it mounted, then settle. */
export async function settleHarness(page: Page, key: string) {
  await page.waitForSelector(`[data-harness="${key}"]`, { timeout: 20_000 });
  await settle(page);
}
