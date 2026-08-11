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
 * Baselines are Linux + headless Chromium artifacts. Playwright suffixes them
 * `-chromium-linux`, so a macOS run does not compare against them at all — it
 * writes a new `-chromium-darwin` set. Do not commit one.
 *
 * ANY LINUX MACHINE MAY NOW REGENERATE THEM, and this is a deliberate change from
 * the original "regenerate only from CI" rule. That rule existed because the
 * baselines were an artifact of the OS as well as of the browser, and it was
 * dropped only once that stopped being true and the claim was tested:
 *   - the browser build is pinned (bundled chromium via --frozen-lockfile, no
 *     executablePath escape hatch)
 *   - the build inputs are pinned (.env.visual via `vite build --mode visual`)
 *   - the three OS-level rasteriser knobs are pinned (srgb, no hinting, no LCD
 *     text — see launchOptions.args)
 *   - the font FILES are pinned — self-hosted @fontsource-variable packages at a
 *     version recorded in bun.lock, bundled same-origin by Vite (ADR-099). This
 *     was the ASPIRATIONAL pin until 2026-08-11: the fonts came off the Google
 *     Fonts CDN at render time, so "pinned to webfonts" was all
 *     font-provenance.spec.ts could prove — that a glyph came from *a* webfont,
 *     not from the *same* one as last week. Upstream Fraunces moved and took
 *     main red for four commits with no change under packages/web. The spec
 *     still enforces "a webfont, never an OS font"; ALLOWED_OFF_ORIGIN being
 *     empty in _settle.ts is what now enforces "and it is ours"
 * Proof: 36 baselines regenerated on Debian trixie passed unmodified on
 * ubuntu-24.04 in CI (run 3 of PR #2, all 13 checks green). Before that flag was
 * added, 12 shots differed between the two machines on antialiasing mode alone.
 *
 * CI remains the authority. If it disagrees with a locally regenerated baseline,
 * believe CI and find out which of the four pins above has sprung — do not raise
 * maxDiffPixels.
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
      // 100 is therefore pure headroom, not a measured flake budget.
      //
      // It used to be justified here as cover for "one unmeasurable risk":
      // Debian-trixie-vs-ubuntu freetype/fontconfig glyph-edge differences, with
      // the note "that term cannot be measured from here". That was wrong on both
      // counts. It WAS measurable — CI measured it — and the answer was 3-134 px
      // across 12 shots, caused by antialiasing MODE (fontconfig `rgba`), now
      // pinned away with --disable-lcd-text. So this headroom no longer covers a
      // known risk at all.
      //
      // FOLLOW-UP, not done here: with that term eliminated the honest value is
      // probably 0, which is what the local flake measurement already supports.
      // Lowering it needs one clean CI run at 0 as evidence, and this commit is
      // already the commit that turned the gate green — do not bundle a
      // tightening into it.
      //
      // A 4px padding change moves far more than 100 px. Measured, Phase 0 exit
      // gate: `PageHeader` `pb-5` -> `pb-6` reddened 42 of 78 shots (every one of
      // the 14 surfaces that render the shared header, at all three viewports);
      // reverting returned all 78 to green. Nothing real hides under 100.
      // If CI reports diffs in the low hundreds on a PR that changed no styling,
      // regenerate the baselines and check the four pins listed in the file
      // header — never raise this number.
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
          // srgb + no hinting + no LCD text remove three further sources of
          // machine drift. Each is an OS-level setting Chromium inherits, so
          // leaving any of them unpinned makes the baselines a function of the
          // machine no matter how well the browser build is pinned.
          //
          // --disable-lcd-text was added after measuring the SECOND CI run. 12 of
          // the 48 remaining failures (app-agents, app-billing, app-settings and
          // pricing, x3 viewports) were pure antialiasing MODE: the committed
          // baseline rendered "RECOMMENDED", "Couldn't load your agents" etc. with
          // greyscale AA, and the runner rendered the identical glyphs at the
          // identical positions with subpixel AA — visible as blue/orange fringes
          // on the glyph edges. Layout was pixel-identical; only the fringe colour
          // differed. That is fontconfig's `rgba` setting, which ubuntu-24.04 and
          // Debian trixie do not agree on.
          //
          // It is only ever SOME elements because Blink already drops to greyscale
          // on any layer whose background it cannot prove opaque, so the two modes
          // coexist on one page and the drift looks arbitrary. Forcing greyscale
          // everywhere makes it uniform, and cheaper to rasterise.
          //
          // Regenerating the baselines would NOT have fixed this — it would only
          // have moved the 12 failures from CI to every local run.
          args: [
            "--force-color-profile=srgb",
            "--font-render-hinting=none",
            "--disable-lcd-text",
            "--no-sandbox",
          ],
        },
      },
    },
  ],
  webServer: {
    // VITE_UI_HARNESS=1 is set HERE and nowhere else — vite.config.ts pins it to
    // "0" otherwise so the harness folds out of every real build.
    //
    // build:visual = `vite build --mode visual`, which loads the committed
    // /.env.visual on top of any local .env. Without it this build inherited the
    // developer's environment and the baselines became a function of it: CI has
    // no .env, so VITE_SUPABASE_* were unset and /app/login screenshotted its
    // "not configured" notice instead of the sign-in form. Baselines must not
    // depend on who ran the build.
    command: `VITE_UI_HARNESS=1 bun run build:visual && bunx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
