import { defineConfig, devices } from "@playwright/test";

/**
 * Visual-regression + accessibility config (Phase 0.5 / 0.7).
 *
 * SEPARATE from playwright.config.ts on purpose, for two reasons.
 *
 * 1. Different server. This suite needs `VITE_UI_HARNESS=1` in the build so the
 *    /__harness routes exist. playwright.config.ts documents itself as the
 *    secret-free public-marketing suite and that property is worth keeping
 *    intact.
 * 2. Different testDir. ui-implementation-plan.md put visual.spec.ts in
 *    `e2e/`, but that is playwright.config.ts's testDir — `bun run test:e2e`
 *    would then run the visual specs against a build WITHOUT the harness flag,
 *    every /__harness route would render the SPA fallback, and the suite would
 *    go red for a reason that has nothing to do with a design regression. Hence
 *    `e2e-visual/`.
 *
 * Still secret-free: no SUPABASE_JWT_SECRET, no admin key, no database. The
 * harness supplies mock context (see src/web/pages/__harness/index.tsx).
 *
 * Baselines are Linux + headless Chromium artifacts. They will NOT match a run
 * on macOS — font rasterisation differs. Update them from CI, or from a Linux
 * container, never from a laptop.
 */
const PORT = 4174;

export default defineConfig({
  testDir: "./e2e-visual",
  // Run-scoped, main-process hooks. The a11y artifact CANNOT be assembled in an
  // `afterAll` — that fires per worker and each worker would overwrite the file.
  globalSetup: "./e2e-visual/_global-setup.ts",
  globalTeardown: "./e2e-visual/_global-teardown.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // No retries. A screenshot comparison is deterministic by construction here;
  // if it only passes on the second attempt then the page is not settled and
  // that is the bug, not something to paper over.
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [["line"], ["json", { outputFile: "a11y-report.json" }]] : "list",
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
    // Kills CSS transitions/animations at the browser level, on top of the
    // per-screenshot `animations: "disabled"`. Belt and braces: the former also
    // short-circuits the data-reveal IntersectionObserver work on public pages.
    reducedMotion: "reduce",
    colorScheme: "light",
  },
  expect: {
    toHaveScreenshot: {
      // Deliberate, not the default, and measured rather than guessed.
      //
      // `threshold: 0.15` is per-pixel: a pixel only counts as different when
      // it exceeds 15% YIQ distance, which is what absorbs font antialiasing.
      //
      // `maxDiffPixels` is ABSOLUTE, deliberately not `maxDiffPixelRatio`. A
      // ratio scales the allowance with image area, so the tall `fullPage`
      // dashboard shots (1440 x ~2500) were being handed ~5,400 forgiven
      // pixels — enough to hide a genuine 1px border or radius change on a
      // small component, which is precisely the class of change Phase B makes.
      //
      // The number: with the hero waveform respecting prefers-reduced-motion
      // (styles-marketing.css), measured flake across all 78 baselines is 0
      // differing pixels on two consecutive local runs at `maxDiffPixels: 0`.
      // 100 is therefore pure headroom, not a measured flake budget. It is kept
      // for exactly one unmeasurable risk: the baselines were generated on Debian
      // trixie and CI runs ubuntu-latest, so freetype/fontconfig may rasterise
      // glyph edges slightly differently even though the browser build is now
      // identical on both sides. That term cannot be measured from here.
      // A 4px padding change moves far more than 100 px. Measured, Phase 0 exit
      // gate: `PageHeader` `pb-5` -> `pb-6` reddened 42 of 78 shots (every one of
      // the 14 surfaces that render the shared header, at all three viewports);
      // reverting returned all 78 to green. Nothing real hides under 100.
      // If CI reports diffs in the low hundreds on a PR that changed no styling,
      // the fix is to regenerate the baselines FROM CI
      // (.github/workflows/visual-baselines.yml), never to raise this number.
      threshold: 0.15,
      maxDiffPixels: 100,
      animations: "disabled",
      caret: "hide",
      scale: "css",
    },
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          // No `executablePath` escape hatch, deliberately. An earlier revision
          // honoured PLAYWRIGHT_CHROME_PATH so the suite could run against the
          // system Chrome. That was measured and it is not equivalent: the same
          // 78 pages rendered by the system Chrome vs Playwright's bundled
          // chromium-headless-shell differ by 192 px at best, ~839 px median and
          // 18,671 px at worst. Baselines are a browser-build artifact. Every
          // committed PNG here comes from the bundled build that CI installs
          // (`bunx playwright install --with-deps chromium`, resolved through
          // --frozen-lockfile), so pointing this at anything else turns a green
          // gate into 78 lies. If the browser is missing, failing loudly with
          // "run playwright install" is the correct outcome.
          //
          // srgb + no hinting remove two further sources of machine drift.
          args: ["--force-color-profile=srgb", "--font-render-hinting=none", "--no-sandbox"],
        },
      },
    },
  ],
  webServer: {
    // VITE_UI_HARNESS=1 is set HERE and nowhere else — vite.config.ts pins it to
    // "0" otherwise so the harness folds out of every real build.
    command: `VITE_UI_HARNESS=1 bun run build && bunx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
