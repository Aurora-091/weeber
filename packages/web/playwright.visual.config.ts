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
      // Deliberate, not the default. Per-pixel `threshold` absorbs font
      // antialiasing noise; `maxDiffPixelRatio` is tight enough that a 4px
      // padding change (thousands of shifted pixels) cannot slip through.
      // Verified by the Phase 0 exit-gate probe.
      threshold: 0.15,
      maxDiffPixelRatio: 0.0015,
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
          // The bundled Playwright browser is not installed in this sandbox and
          // the srgb/hinting flags remove two sources of cross-machine pixel
          // drift.
          executablePath: process.env.PLAYWRIGHT_CHROME_PATH || undefined,
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
