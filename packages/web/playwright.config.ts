import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end config for the PUBLIC marketing surface only.
 *
 * Why this shape (see docs/reference/testing.md → "End-to-end"):
 * - It builds the real Vite bundle and serves it with `vite preview`, so the
 *   test exercises the shipped artifact, not the dev server.
 * - It targets the SECRET-FREE static path: the landing page renders and the
 *   waitlist form's client-side validation runs entirely in the browser with
 *   no backend. The API is same-origin by default (lib/api.ts), so the count
 *   fetch/WebSocket just fail gracefully against the static preview — the page
 *   is unaffected. That keeps this suite deterministic (no live backend, no
 *   secrets), so it can't go false-red in CI.
 * - It is intentionally NOT part of `bun run test`; run it via `test:e2e`.
 */
const PORT = 4173;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "line" : "list",
  timeout: 30_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Build the real bundle, then serve it exactly as production would.
    command: `bun run build && bunx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
