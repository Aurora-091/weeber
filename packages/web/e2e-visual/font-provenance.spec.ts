import { test, expect } from "@playwright/test";
import { blockApi, blockOffOrigin, fontProvenance, presetTheme, settle, settleHarness } from "./_settle";
import { HARNESS_KEYS } from "../src/web/pages/__harness/keys";

/**
 * Font provenance gate.
 *
 * WHAT IT ASSERTS
 * That every glyph on every screenshotted route is rasterised from a WEBFONT this
 * repo controls — not from a family fontconfig picked off the operating system.
 *
 * WHY IT EXISTS
 * The first CI run failed 51 of 78 visual baselines. 36 of those came from one
 * className: dashboard-shell.tsx used Tailwind's stock `font-serif`
 * (ui-serif, Georgia, Cambria, "Times New Roman", Times, serif — no webfont in
 * it), so the admin "Weeber" wordmark rendered in whatever serif the distro
 * supplies: Caladea on Debian, something else on ubuntu-24.04. Two separate
 * defects hid inside that, and NEITHER was visible to a human reviewer:
 *   1. the pixel baselines silently became an artifact of the build machine
 *   2. the admin panel was not using the brand typeface at all
 * A screenshot diff cannot tell you this — it only says "290 pixels changed".
 * CDP's CSS.getPlatformFontsForNode can, so the suite now asserts it directly
 * instead of waiting to be surprised by the next runner image.
 *
 * WHY AN ALLOWLIST RATHER THAN ZERO
 * Same reason the design budget is a ratchet: a handful of real escapes exist
 * today (mostly single symbol glyphs absent from Inter Tight, which fall back
 * per-glyph). Demanding zero on day one means switching the gate off on day one.
 * Every entry below is MEASURED, and each one has to name the glyph and the
 * reason. New escapes fail.
 */

/**
 * Known, measured system-font escapes. `glyphs` is the ceiling — this ratchets
 * DOWN like design-budget.json, so an escape that grows fails the gate.
 */
const ALLOWED: Array<{ family: string; maxGlyphs: number; why: string }> = [];

const PUBLIC_ROUTES = [
  { name: "landing", path: "/" },
  { name: "pricing", path: "/pricing" },
  { name: "app-login", path: "/app/login" },
];

type Escape = { route: string; family: string; glyphs: number; sampleText: string; cssFamily: string };
const escapes: Escape[] = [];

function check(route: string, prov: Awaited<ReturnType<typeof fontProvenance>>) {
  const undeclared = prov.systemFonts.filter((s) => {
    const allowed = ALLOWED.find((a) => a.family === s.family);
    return !allowed || s.glyphs > allowed.maxGlyphs;
  });
  // Record BEFORE any assertion: a gate that throws before it reports what it saw
  // makes you run it a second time to find out. The afterAll summary is the
  // measurement tool for filling in ALLOWED, so it must always get the data.
  for (const s of undeclared) escapes.push({ route, ...s });

  // A route that rasterised NO webfont at all means the font CDN did not answer
  // and every glyph is a fallback. That is a broken run, not a passing one.
  expect(
    prov.webFonts.length,
    `${route}: no webfont was rasterised at all. system fonts seen: ` +
      (prov.systemFonts.length === 0
        ? "(none either — the probe found no rendered text, so the page is blank or did not mount)"
        : prov.systemFonts
            .map((s) => `${s.family} x${s.glyphs} via [${s.cssFamily}] on "${s.sampleText}"`)
            .join(" | ")),
  ).toBeGreaterThan(0);

  // Assert per route so the failing test names the surface, not a summary hook.
  expect(
    undeclared.map((s) => `${s.family} x${s.glyphs} via [${s.cssFamily}] on "${s.sampleText}"`),
    `${route}: glyphs rasterised from an OS font instead of a webfont — these render ` +
      `differently on a different machine and will move the visual baselines`,
  ).toEqual([]);
}

test.describe("font provenance", () => {
  for (const key of HARNESS_KEYS) {
    test(`${key}`, async ({ page }) => {
      await blockApi(page);
      await blockOffOrigin(page);
      await presetTheme(page, "light");
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`/__harness/${key}`);
      await settleHarness(page, key);
      check(key, await fontProvenance(page));
    });
  }

  for (const route of PUBLIC_ROUTES) {
    test(`public-${route.name}`, async ({ page }) => {
      await blockApi(page);
      await blockOffOrigin(page);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(route.path);
      await settle(page);
      check(`public-${route.name}`, await fontProvenance(page));
    });
  }
});

test.afterAll(() => {
  if (escapes.length === 0) {
    console.log("\nfont provenance: every glyph on every route came from a webfont.\n");
    return;
  }
  console.log("\nfont provenance — UNDECLARED SYSTEM FONTS:\n");
  for (const e of escapes) {
    console.log(`  ${e.route}`);
    console.log(`    rasterised : ${e.family}  (${e.glyphs} glyph${e.glyphs === 1 ? "" : "s"})`);
    console.log(`    css stack  : ${e.cssFamily}`);
    console.log(`    text       : "${e.sampleText}"`);
  }
  console.log(
    "\n  Each of these renders differently on a different operating system, so it\n" +
      "  moves the visual baselines. Fix the font stack, or declare it in ALLOWED\n" +
      "  in font-provenance.spec.ts with the glyph and the reason.\n",
  );
});
