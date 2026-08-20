import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { blockApi, blockOffOrigin, presetTheme, settleHarness } from "./_settle";
import { PUBLIC_ROUTES, gotoPublic } from "./_public-routes";
import { writeRouteResult, type RouteResult } from "./_a11y-report";
import { HARNESS_KEYS } from "../src/web/pages/__harness/keys";

/**
 * Accessibility audit (Phase 0.7) — REPORT-ONLY, on purpose.
 *
 * WHY IT DOES NOT FAIL THE BUILD YET
 * audit/2026-08-03-audit-ui-ux-full-surface.md §A found real violations across every private surface. A gate that
 * fails on day one has to be disabled on day one, and a disabled gate protects
 * nothing — the same reason the design ratchet is a ratchet and not a lint rule.
 * So this suite records a baseline count per route and always passes. Phase G
 * converts it to a ratchet against that baseline, at which point a NEW violation
 * fails CI while the known backlog does not.
 *
 * WHAT IT DOES ASSERT
 * One thing only: that axe actually ran and returned a result for every route. A
 * silent zero — because a page never mounted, or axe threw — would look exactly
 * like perfect accessibility and would be the most dangerous outcome here.
 *
 * WCAG SCOPE
 * wcag2a + wcag2aa + wcag21a + wcag21aa. Colour-contrast is INCLUDED even though
 * tools/ui-guard/contrast-gate.ts already measures tokens, because they catch
 * different things: the gate proves the declared token pairs are legal, axe
 * catches the places where the rendered combination is not one of those pairs.
 *
 * The artifact is written to a11y-baseline.json and uploaded by CI, so the
 * violation count per route is reviewable in a PR without reading logs.
 */

/**
 * Floor for `rulesApplied`. Every route here renders a full page, and the lowest
 * value MEASURED across all 26 was 17 — axe counts applicable RULES, not nodes,
 * and a page with no images/tables/iframes simply puts fewer rules in scope. A
 * blank or crashed page lands in single digits. 12 sits between the two with
 * room to spare: a smoke floor, not a metric.
 */
const MIN_RULES_APPLIED = 12;


function analyzer(page: import("@playwright/test").Page) {
  return new AxeBuilder({ page }).withTags([
    "wcag2a",
    "wcag2aa",
    "wcag21a",
    "wcag21aa",
  ]);
}

type AxeResults = Awaited<ReturnType<AxeBuilder["analyze"]>>;

function record(route: string, res: AxeResults): number {
  const { violations } = res;
  const count = (impact: string) => violations.filter((v) => v.impact === impact).length;
  const result: RouteResult = {
    route,
    violations: violations.length,
    critical: count("critical"),
    serious: count("serious"),
    moderate: count("moderate"),
    minor: count("minor"),
    rulesApplied: res.passes.length + violations.length + res.incomplete.length,
    rules: violations.map((v) => v.id).sort(),
  };
  writeRouteResult(result);
  return result.rulesApplied;
}

test.describe("a11y — private surfaces (report-only)", () => {
  for (const key of HARNESS_KEYS) {
    test(`${key}`, async ({ page }) => {
      await blockApi(page);
      await blockOffOrigin(page);
      await presetTheme(page, "light");
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`/__harness/${key}`);
      await settleHarness(page, key);

      const res = await analyzer(page).analyze();
      const rulesApplied = record(key, res);

      // The hard assertions: the page mounted, and axe found enough of a DOM to
      // apply real rules to. Without the second one, a route that renders an
      // empty div reports "0 violations" and looks like a win.
      await expect(page.locator("[data-harness-error]")).toHaveCount(0);
      expect(rulesApplied).toBeGreaterThanOrEqual(MIN_RULES_APPLIED);
    });
  }
});

test.describe("a11y — public surfaces (report-only)", () => {
  for (const route of PUBLIC_ROUTES) {
    test(`${route.name}`, async ({ page }) => {
      await blockApi(page);
      await blockOffOrigin(page);
      await page.setViewportSize({ width: 1440, height: 900 });
      await gotoPublic(page, route);

      const res = await analyzer(page).analyze();
      const rulesApplied = record(`public-${route.name}`, res);
      expect(rulesApplied).toBeGreaterThanOrEqual(MIN_RULES_APPLIED);
    });
  }
});
