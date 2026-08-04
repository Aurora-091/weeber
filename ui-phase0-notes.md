# Phase 0 — working notes

Scratchpad for the guardrails phase. Delete or fold into docs/ when Phase 0 closes.

## Committed (branch `ui/phase-0-guardrails`, off `main` @ b5a1fb6)

| step | commit | what |
| --- | --- | --- |
| 0.1 | 8935893 | vendor `tools/ui-guard/contrast.py` |
| 0.2 | 483364a | `tokens.json` — 21 pairs by token name |
| 0.3 | a0bafea | `contrast-gate.ts` — 42 measured, 9 FAIL |
| — | 256647b | fix: every `vite build` was producing a DEV bundle |
| 0.6 | b9571bb | secret-free render harness (`/__harness/*`) |
| 0.4 | 3d63e7c | design-drift ratchet seeded to measured main counts |
| 0.5 | d6347b1 | visual suite, 78 baselines |
| 0.7 | 5a27985 | a11y baseline, 26 routes, 7 violations, report-only |
| 0.9 | 1151a0d | commit the 78 baselines |
| 0.8a | 3103a56 | contrast gate becomes a ratchet (knownFailures) |
| 0.8 | 5303b22 | CI: design-guard, visual, a11y jobs + ci-success needs |
| 0.10 | (this) | exit gate demonstrated; flake driven to 0; a11y motion fix |

## Exit gate — PASSED on the second attempt

First attempt failed and surfaced two real defects. Both are now fixed and the
gate has been demonstrated end to end.

### Defect 1 (fixed) — `button.tsx` was the wrong probe
Probe `px-4` -> `px-5` on the default Button variant produced ZERO diff across
all 78 shots. The build did pick the change up (`dist/assets/button-*.js`
contained `h-9 px-5 py-2`, `.px-5{}` emitted). Cause: almost nothing rendered
uses the `Button` component — the design ratchet's `rawButton: 111` seen from the
other side. The app hand-rolls `<button className=...>`.

Replaced with a probe on something every surface renders: `PageHeader`
`pb-5` -> `pb-6`.

Consequence for **Phase C7** (111 raw buttons -> `Button`) stands: the suite has
almost no baseline coverage of the Button component, so C7's diffs will be large.

### Defect 2 (fixed) — landing @ 768 was unstable by 1174 px
With source restored, `landing @ 768` differed from its own baseline by exactly
1174 px every run. `1174 / (768 x 1024) = 0.001493` vs a configured
`maxDiffPixelRatio: 0.0015` = 1179.6 px allowed. It was passing by **5 pixels**.

Cause: 64 `.hero-wave-bar` spans on a 3.5s infinite loop behind the hero.
Playwright's `reducedMotion: "reduce"` only sets the media query — the CSS has to
answer it, and `styles-marketing.css`'s reduced-motion block had missed the hero.

Fixed in the product, not the test: `.hero-wave-bar` and `.hero-pulse-dot` now
`animation: none` under `prefers-reduced-motion`. This is the largest continuous
motion on the site, above the fold, purely decorative — it should have been in
that block regardless. The baseline stability was the symptom, not the reason.

### Measurements after the fix
- `maxDiffPixels: 0`, clean server, fresh build: **78 passed**. Measured flake is
  genuinely zero, so the shipped `100` is headroom for CI's ubuntu-latest font
  stack, not a flake budget.
- Probe `PageHeader` `pb-5` -> `pb-6` at the shipped tolerance: **42 failed,
  36 passed**.
- Revert: **78 passed**.
- `bun run design:guard` exit 0, all 8 metrics at budget, 585 above target.
- `bun run contrast:gate` exit 0, "33/42 at or above floor", 9 of 9 declared.
- `--strict` exit 1, 9 FAILING (the honest state; informational in CI).

### New finding from the probe — 9 of 23 private surfaces skip `PageHeader`
Only 14 surfaces moved (x3 viewports = 42). These 9 did not:
`app-agents`, `dash-billing`, `dash-calls`, `dash-compliance`, `dash-dnc`,
`dash-flags`, `dash-orgs`, `dash-settings`, `dash-templates`.

The 8 `dash-*` pages have no `PageHeader` import — they hand-roll page headings,
so page title type scale, breadcrumbs and header spacing are inconsistent across
`/dashboard`. Feed this into **Phase C** as a named consistency item; it was not
in `ui-audit.md`.

`app-agents` DOES import `PageHeader` yet did not move — worth 10 minutes before
Phase C to find out whether the harness renders it down an early-return branch
(which would mean that baseline covers less than it appears to).

## Also added
- `.github/workflows/visual-baselines.yml` — manual `workflow_dispatch` baseline
  regeneration on the same runner image CI verifies against. Uploads an artifact
  for a human to eyeball and commit; deliberately does NOT auto-commit or push.
- `playwright.visual.config.ts` no longer honours `PLAYWRIGHT_CHROME_PATH`.
  Measured: system Chrome vs bundled chromium-headless-shell differ on the same
  pages by 192 px best / ~839 px median / 18,671 px worst. Baselines are a
  browser-build artifact; an escape hatch turns a green gate into 78 lies.
  Baselines were regenerated with the bundled build (hence all 78 PNGs modified).

## Still open (carry into Phase B planning)

- `ui-implementation-plan.md` Phase B carries stale `--border`/`--input` line
  numbers. Actual: light `--weeber-border:408`, `--border:444`, `--input:445`,
  `--ring:446`, `--sidebar:447`; dark `--weeber-border:679`, `--border:713`,
  `--input:714`, `--ring:715`, `--sidebar:716`.
- New failure not in `ui-audit.md`: dark `--ring` on card = 2.85:1 (the audit only
  measured ring against the page bg, 3.32:1 pass). Add to §A and the Phase B table.
- Baselines are 22 MB. Each phase that regenerates them adds ~22 MB to git
  history. Decide before Phase B, not after.
- Plan Q4 unanswered: `tooltip.tsx` / `command.tsx` / `checkbox.tsx` have 1 import
  site each — adopt or delete? Needed by Phase C9.
- Plan Q6 unanswered: is there a staging env with real `TWILIO_*` for the Phase G7
  live-call states? Not verifiable in this sandbox at all.
- CI itself is still unverified: the three new jobs have never run on a real PR.
  Local green is not CI green (different runner image, bundled-browser install,
  `ci-success` gating). First push is the actual test.
