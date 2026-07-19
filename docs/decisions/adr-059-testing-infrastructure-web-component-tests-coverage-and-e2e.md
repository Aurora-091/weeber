---
adr: 59
title: "Testing infrastructure: web component tests (happy-dom), opt-in coverage, and a secret-free Playwright E2E"
date: 2026-07-19
status: Accepted
---

## ADR-059 — Testing infrastructure: web component tests (happy-dom), opt-in coverage, and a secret-free Playwright E2E (2026-07-19)

**Context:** the suite was solid on the backend (api + openvent-compliance) but `packages/web` had only
pure-logic unit tests (`theme`, `verticals`) — the React components, including the marketing **waitlist form**
(the site's single conversion surface), had no coverage at all. There was also no coverage reporting and no
end-to-end test of any kind. With an "agents + me" team where agents author most changes, the gaps that
matter are the ones an agent can't see: an untested conversion form, and the two verification foot-guns from
[ADR-056](./adr-056-correction-the-38-pre-existing-test-failures-baseline-cited-.md) (bare `bun test` and
missing-deps false-greens) that had already burned many sessions.

**Decision:**

1. **Web component tests run under happy-dom, colocated.** Added `@testing-library/react` +
   `@happy-dom/global-registrator`, registered once via `packages/web/test-setup.ts` and preloaded through
   `packages/web/bunfig.toml` (`[test] preload`). New tests: `components/ui/button.test.tsx` and
   `components/marketing/WaitlistForm.test.tsx` (render + client-side validation gating of the waitlist CTA).
   Tests stay **colocated** next to source — no `testing/` folder (rejected; Bun convention + agent-navigable).
2. **Coverage is an opt-in `test:coverage` script**, not part of the canonical `test`. Bun's built-in
   `--coverage`, wired per package + a root `turbo test:coverage` task. The fast `test` gate stays lean for
   CI; **no enforced threshold** (coverage is a lens, not a gate).
3. **One secret-free Playwright E2E** for the public landing page (`packages/web/e2e/`,
   `playwright.config.ts`, `test:e2e` script). It builds the real bundle and serves it via `vite preview`,
   and asserts only client-side behavior (landing renders + waitlist validation). No live backend, no
   secrets → deterministic, can't go false-red. It is **not** part of `bun run test`; it has its own script
   and its own CI job, added to `ci-success`'s `needs`.
4. **CI hardening + docs.** Every CI job already installs `bun install --frozen-lockfile` first; documented
   the deps-first false-green rule and the ADR-056 `bun run test` (never bare `bun test`) rule explicitly in
   `docs/reference/testing.md`, and linked that doc from `AGENTS.md`.

**Consequences / tradeoffs:**
- happy-dom registers `localStorage`/`window`/`fetch`/`WebSocket` as **read-only** globals. Test files must
  not reassign them at top level (`global.localStorage = {...}` throws once another file registered happy-dom
  first — passes in isolation, fails in the full run). Stub globals via
  `Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })` instead. This bit
  the pre-existing `theme.test.ts`, which was adapted to rely on happy-dom's implementations. Documented.
- The E2E deliberately covers only the landing/waitlist path. Auth/dashboard/`/app` flows stay in manual/curl
  regression checks — pulling a live backend or secrets into CI E2E would trade determinism for coverage,
  which we explicitly don't want.
- `e2e/` and `playwright.config.ts` sit outside `tsc --noEmit` scope (`tsconfig.app.json` includes only
  `src/web`); Playwright type-checks them at run time, and the `e2e` CI job is their real gate.
- Baseline after this round: **564 pass / 0 fail** across the three packages (api 486, openvent-compliance 62,
  web 16) plus 2 Playwright E2E specs. Verify with `bun run test` (+ `bun run test:e2e`), never a hardcoded
  count.

No product/runtime behavior changed — this is test-infra only.
