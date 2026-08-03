import { test, expect } from "@playwright/test";
import { blockApi, presetTheme, settle, settleHarness } from "./_settle";

/**
 * Visual-regression baselines (Phase 0.5).
 *
 * WHAT THIS PROTECTS
 * Phases B-G rewrite tokens, card primitives, spacing and the type scale across
 * ~50 files. Without a pixel baseline, "I only changed the border colour" is an
 * unverifiable claim. This suite makes every such change produce a reviewable
 * artifact and makes an unintended one impossible to merge quietly.
 *
 * WHAT IT DOES NOT PROTECT (yet)
 * Harness pages currently render EMPTY states — no per-page query seeds. So
 * these baselines lock the shell, navigation, page header, type scale and
 * empty-state design, but NOT populated tables, charts or list rows. Seeding is
 * the extension point in src/web/pages/__harness/index.tsx; add seeds and the
 * matching baselines appear on the next --update-snapshots.
 *
 * MATRIX — 78 baselines, chosen rather than generated
 * A full 23 x 3 viewports x 2 themes grid is 138 images of mostly redundant
 * information and tens of MB in git. Instead:
 *   - every private page at 1440 light   (the surface changes get reviewed on)
 *   - every private page at 390 light    (where the audit found layout breakage)
 *   - every private page at 1440 dark    (dark has its own failing token set)
 *   - three public pages, fold only      (marketing is out of scope until Phase H)
 * 768 is omitted deliberately: no audit finding was unique to it, and every
 * container query that governs it is already exercised at 390 and 1440.
 */

// The key list is imported, never restated, so a page added to the harness
// cannot be silently left without a baseline. keys.ts is React-free precisely so
// this import resolves inside the Playwright node process.
import { HARNESS_KEYS } from "../src/web/pages/__harness/keys";

const PUBLIC_ROUTES = [
  { name: "landing", path: "/" },
  { name: "pricing", path: "/pricing" },
  { name: "app-login", path: "/app/login" },
];

const PUBLIC_VIEWPORTS = [
  { w: 390, h: 844 },
  { w: 768, h: 1024 },
  { w: 1440, h: 900 },
];

/** The private-surface matrix. */
const PRIVATE_SHOTS = [
  { label: "1440-light", w: 1440, h: 900, theme: "light" as const },
  { label: "390-light", w: 390, h: 844, theme: "light" as const },
  { label: "1440-dark", w: 1440, h: 900, theme: "dark" as const },
];

test.describe("private surfaces", () => {
  for (const key of HARNESS_KEYS) {
    for (const shot of PRIVATE_SHOTS) {
      test(`${key} @ ${shot.label}`, async ({ page }) => {
        await blockApi(page);
        await presetTheme(page, shot.theme);
        await page.setViewportSize({ width: shot.w, height: shot.h });
        await page.goto(`/__harness/${key}`);
        await settleHarness(page, key);

        // Fail loudly rather than screenshot a broken page — a captured error
        // page becomes a "passing" baseline and the gate stops protecting
        // anything.
        await expect(page.locator("[data-harness-error]")).toHaveCount(0);

        await expect(page).toHaveScreenshot(`${key}--${shot.label}.png`, { fullPage: true });
      });
    }
  }
});

test.describe("public surfaces", () => {
  for (const route of PUBLIC_ROUTES) {
    for (const vp of PUBLIC_VIEWPORTS) {
      test(`${route.name} @ ${vp.w}`, async ({ page }) => {
        await blockApi(page);
        await page.setViewportSize({ width: vp.w, height: vp.h });
        await page.goto(route.path);
        await settle(page);

        // Fold only, not fullPage. These pages are long, their height moves with
        // copy edits that are out of scope, and marketing is not touched until a
        // future Phase H — a fullPage baseline here would mostly generate noise.
        await expect(page).toHaveScreenshot(`public-${route.name}--${vp.w}.png`, {
          fullPage: false,
        });
      });
    }
  }
});
