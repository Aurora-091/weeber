# CI triage — PR #2, first-ever CI run (commit c2015c0, merge 6f58976)

> **HISTORICAL — do not read as current CI state.** This is the write-up of the *first* CI run
> (2026-07), kept because its four root causes are still the failure modes worth knowing. Since then
> the package was renamed (`openvent-compliance` → `@weeber/compliance`, ADR-078), `ci-success` was
> changed to allow-list `result == "success"` instead of asserting failure (ADR-075), and a
> `dead-code` reachability ratchet was added (ADR-090) — CI is now twelve jobs plus the aggregate.
> The live definition is [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml); the pre-PR command
> chain is in [`AGENTS.md`](../../AGENTS.md).

Poll command:
`TOKEN=$(git remote get-url origin | sed -E 's|.*x-access-token:([^@]+)@.*|\1|')`
`curl -s -H "Authorization: token $TOKEN" ".../commits/<sha>/check-runs"`
Logs: `.../actions/jobs/<id>/logs`

## Final conclusions (all 12 checks in)

| check | result |
|---|---|
| Lint | success |
| Typecheck (api, web, openvent-compliance) | success |
| Test (api, web, openvent-compliance) | success |
| Build (web) | success |
| Drizzle migrations match schema.ts | success |
| E2E (public landing, Playwright) | success |
| Vercel Agent Review / Preview Comments | success |
| **Design drift ratchet + contrast gate** | **failure** |
| **Accessibility baseline (axe, report-only)** | **failure** |
| **Visual regression (78 baselines)** | **failure** |
| CI success | failure (aggregate) |

Every failure is in a gate **I** built in Phase 0. Zero product regressions.
Phase 0's exit gate was declared PASSED on local evidence only — the gates had
never run on a clean machine. That was the mistake.

## F1 — design:guard: `rg` is not in the GitHub runner image
Log: `design-guard: rg failed for /<button/: exit undefined`
`design-guard.ts:51` does `spawnSync("rg", ...)`. Missing binary => `status: null`,
so the diagnostic prints `exit undefined` instead of ENOENT. ubuntu-24.04 runner
images do not ship ripgrep. The ratchet could never have passed in CI.
Local rg is 14.1.1.

NOT a bug (initially misread): the `contrast:gate --strict` exit-1 in the same log
is the `if: always()` + `continue-on-error: true` informational step. It only ran
because the ratchet step failed first and the real `contrast:gate` step was
skipped. Ratchet mode is correctly wired.

Fix direction: reimplement `count()` in pure Bun (no external binary). Patterns are
all single-line literals/simple regex, so parity is achievable. MUST match
line-by-line semantics: rg searches per line, so `[^"]*` in `inlineCardClone`
cannot span newlines, but a naive JS whole-file regex would let it.
Target counts to reproduce exactly: rawButton 111, rawSelect 32, arbitraryPx 365,
rawHex 25, cardLift 15, cardAction 2, transitionAll 20, inlineCardClone 50.

## F2 — a11y: `/app/login` applied 6 rules in CI, floor is 12
Local: 22 rules, passes. CI: 6.
Root cause: `src/web/lib/supabase.ts` reads build-time `VITE_SUPABASE_URL` +
`VITE_SUPABASE_ANON_KEY`. Unset => `supabaseConfigured === false` => the user app
renders a "not configured" notice by design. That stub is a tiny DOM => 6 rules.
Locally the repo-root `.env` supplies both keys (vite.config.ts loads env from the
repo root with an empty prefix), so the real login form renders.
No `VITE_*` is set in any workflow — `rg -n "VITE_" .github/workflows/*.yml` = no match.

## F3 — visual: 51 of 78 baselines failed, 27 passed
Diffs are 115–292 px, ratio 0.01, against `maxDiffPixels: 100`. Small, spread over
many shots => environment rendering delta, not a layout change.
Failed: all dash-* (33), app-agents/app-billing/app-settings (9), app-login (3),
pricing (2)... Passed: landing, app-calls, app-home, app-integrations,
app-knowledge-base, app-leads, app-numbers, app-orders, app-workflows.
Diff artifact: run 30888304542, artifact 8884070951 (visual-diffs.zip, 34 MB).

Baselines were committed as `*-chromium-linux.png` from THIS Debian Trixie sandbox,
not from `.github/workflows/visual-baselines.yml` on ubuntu-24.04 — so the
documented rule ("regenerate only via the workflow") was violated by the very
commit that wrote the rule. Suspect font stack / fontconfig differences.

## Shared root cause behind F2 and F3
The visual + a11y builds consume whatever `.env` is on the machine. That makes both
suites environment-dependent, which is fatal for a pixel gate: any local `.env`
edit silently moves baselines. Needs a committed, secret-free, pinned env file used
by the visual/a11y builds AND by visual-baselines.yml.

## F4 — `settle()` returned before React had painted (found while fixing F2/F3)
Not in the original triage; found by probing, and it invalidates part of the F2
story above.

`settle()` used to poll `document.fonts.status === "loaded"` as its only gate.
That is a race, not a wait: `status` is `"loaded"` whenever nothing is *currently*
pending, which includes the moment after `domcontentloaded` and before the
stylesheet has been parsed and the first `@font-face` requested. So `settle()`
could — and did — return against an empty `#root`.

Measured: three consecutive `font-provenance` runs on the same build of
`/app/login` saw **0, 0 and 10** text-owning elements. Standalone probes with a
flat 2500 ms wait always saw 10 and the full sign-in form (`bodyChars: 140`).

Why it hid in `visual.spec.ts`: `toHaveScreenshot` re-shoots until two consecutive
frames match, so it *accidentally* waits for React. The single-shot suites (a11y,
font-provenance) read the DOM exactly once and had no such luck. So part of the
"CI applied only 6 rules" in F2 is this race, not only the unset `VITE_*` — both
were real, and the env fix alone would have left a flaky gate behind.

Fix: `settle()` now waits for `#root` to have children AND `document.body.innerText`
to be non-empty (20 s), then awaits the `document.fonts.ready` **promise** (which,
unlike `.status`, cannot report done early), then two frames + 150 ms.

## F5 — `blockApi` was dead in every suite that also called `blockOffOrigin`
Found while wiring `blockOffOrigin` into the visual + a11y suites, i.e. this is a
defect in the F3 fix itself, caught before it shipped.

Playwright matches route handlers **last-registered-first**, and `route.continue()`
performs the request immediately without consulting any earlier handler. The new
`blockOffOrigin` registered a `**/*` handler that called `continue()` for
same-origin URLs — so it shadowed `blockApi`'s `**/api/**` abort completely.

Measured against a static server that answers `/api/*` with the SPA index, exactly
as `vite preview` does:

```
mode=continue   /api/ping => 200 (SPA index HTML)   <- blockApi bypassed
mode=fallback   /api/ping => THREW (aborted)        <- blockApi honoured
```

`fonts.googleapis.com` reached the network in both, so the allowlist still works.
Fix: `blockOffOrigin` uses `route.fallback()` for everything it permits, and the
call order (`blockApi` first, then `blockOffOrigin`) is now load-bearing and
documented at the function.

## Fixes as landed
- **F1** — `4b3eaed`. `tools/ui-guard/design-guard.ts` counts in pure Bun
  (`listTsx()` + line-by-line regex, no `spawnSync`), so the ratchet has no
  external binary dependency. All 8 metrics reproduce their target counts.
- **F2 + F3 env** — committed `.env.visual` (secret-free `VITE_*` fixtures) plus
  `build:visual` = `vite build --mode visual`. `playwright.visual.config.ts` builds
  through it, so the visual, a11y and font suites — and
  `visual-baselines.yml` — all test a byte-identical bundle regardless of the
  machine's local `.env`.
- **F3 font stack** — `dashboard-shell.tsx` wordmark `font-serif` -> `font-display`.
  Measured via CDP as rasterising from **Caladea** on Debian; it was the only
  `font-serif` in `packages/web/src`.
- **F3 glyph fallback** — the 3 text `→` in `landing.tsx` (`:269`, `:366`, `:369`)
  replaced with the already-imported lucide `ArrowRight`. `→` is absent from Inter
  Tight and fell back per-glyph to Liberation Sans (`x5`). 19 other text `→` remain
  across 13 files; none are on a screenshotted route (plan item added).
- **F4** — mount-aware `settle()` (above).
- **F5** — `route.fallback()` (above).
- **New gate** — `font-provenance.spec.ts` + a `fonts` job appended to
  `ci-success.needs`. It asserts every glyph on all 26 routes came from a webfont,
  so the next `font-serif`-class defect fails with the className instead of with 78
  moved images. `ALLOWED` is empty, and ratchets like the design budget.

## Deferred, with reason
- **Self-hosting the 4 Google webfonts.** `styles.css:1` still `@import`s the CSS2
  endpoint, so the fonts (and therefore the pixels) are fetched from a third-party
  CDN at test time — an input this repo does not version. `fonts.googleapis.com` +
  `fonts.gstatic.com` are on `ALLOWED_OFF_ORIGIN` under protest. Not fixed now
  because the 51 failures were caused by stock `font-serif` + unset `VITE_*`, not by
  CDN drift, and self-hosting is a separate change with its own perf upside. It is
  already a finding at `ui-audit.md:381`.

## Local verification of this change set
- `bun run test:fonts` — **26/26 passed**, "every glyph on every route came from a
  webfont", 0 undeclared escapes.
- `bun run test:a11y` — **26/26 passed**. Lowest `rulesApplied` on any route is now
  **17** (CI saw 6 on `public-app-login`, floor is 12). 8 violations across 26
  routes: previously 7 — `public-pricing color-contrast` is newly *visible*, not
  newly introduced; F4's race was hiding it.
- `test:visual` is deliberately NOT the gate for this change: baselines are a
  Linux + headless-Chromium artifact that must be regenerated only via
  `visual-baselines.yml`, and the product CSS/font stack changed here. Regenerate
  on the runner, review the diff, then commit.

---

# Second CI run (commit 5a506a1)

| check | run 1 | run 2 |
|---|---|---|
| Design drift ratchet + contrast gate | failure | **success** |
| Accessibility baseline (axe) | failure | **success** |
| Font provenance (new gate) | — | **success** |
| Visual regression (78 baselines) | 51 failed / 27 passed | 48 failed / 30 passed |

F1, F2, F4 and F5 are confirmed fixed *on the runner*, not just locally. Font
provenance passing on ubuntu-24.04 is the direct evidence that the font stack is
no longer machine-dependent. `app-login` (3 shots) and `landing` went from failing
to passing, which is the `.env.visual` pinning working.

## F6 — the last 48 visual failures were exactly two causes, both now measured

Downloaded the diff artifact (run 30894696207, artifact 8886634499) and computed
the differing-pixel bounding box for all 48 expected/actual pairs rather than
eyeballing them:

- **36 shots — every `dash-*` page x 3 viewports.** bbox is *identical* on all 36:
  `(16,19)-(116,34)` at 1440, i.e. one 100x15 px box at the top-left. That is the
  sidebar wordmark and nothing else. This is the INTENDED `font-serif` ->
  `font-display` fix. The baselines were legitimately stale. Verified by cropping
  the old and new PNG: Caladea (thin Cambria-metric serif) -> Fraunces (the brand
  display face). "ADMIN" (mono) unchanged.

- **12 shots — `app-agents`, `app-billing`, `app-settings`, `pricing` x 3.** 3-134
  differing px, bboxes scattered mid-page, nowhere near the wordmark. Cropped and
  compared at 4x: **the glyphs are at identical positions with identical shapes,
  and only the antialiasing MODE differs** — baseline greyscale, runner subpixel,
  visible as blue/orange fringing on glyph edges of "RECOMMENDED", "Couldn't load
  your agents", "SINGLE-STORE OWNERS".

That is fontconfig's `rgba` setting: an OS-level knob Chromium inherits.
`--font-render-hinting=none` and `--force-color-profile=srgb` were already pinned
in `playwright.visual.config.ts`; AA *mode* was the one that was not. Fixed by
adding `--disable-lcd-text`.

**Regenerating the baselines would not have fixed these 12 — it would only have
moved the failures from CI to every local run.** That distinction is the whole
reason to measure a diff instead of accepting it.

Why only some elements: Blink already drops to greyscale on any layer whose
background it cannot prove opaque, so both modes coexist on a single page and the
drift looks arbitrary until you know what you are looking at.

### Falsifiable prediction, then the test
If this sandbox was already rendering greyscale, `--disable-lcd-text` is a no-op
locally and *exactly* the 36 intended `dash-*` shots should fail. Measured:
**36 failed / 42 passed**, all 36 `dash-*`. Prediction held, so the 12 were purely
CI-side and the flag closes the divergence rather than papering over it.
After `test:visual:update`: **78 passed**, and `git status` shows **exactly 36**
PNGs modified — no collateral.

## Blocker — `visual-baselines.yml` cannot be dispatched from a branch
`POST /actions/workflows/visual-baselines.yml/dispatches` returns **404**, and
`GET /actions/workflows` lists only `ci.yml` + the two code-scanning workflows.
Cause: GitHub only registers `workflow_dispatch` from a workflow file that exists
on the **default branch**, and `visual-baselines.yml` was added on
`ui/phase-0-guardrails` and has never been merged. Confirmed:
`git ls-tree origin/main .github/workflows/` lists `ci.yml` only.

So the documented "regenerate only via the workflow" rule is **unusable on the PR
that introduces it** — chicken-and-egg. The 36 baselines here were therefore
regenerated locally, which is a deliberate, recorded exception, and CI is the
authority that checks it. With `--disable-lcd-text` the rasteriser should no longer
be environment-dependent at all; **if run 3's visual job is green, that claim is
proven and the rule can be relaxed to "regenerate anywhere, CI verifies"**. Do not
relax it before then.

## Also noticed, not fixed
The `app-agents` harness page screenshots an ERROR state — "Couldn't load your
agents / Something went wrong reaching the server". `blockApi` aborts the query and
the harness has no seed for it, so this baseline locks the error path, not the
page. It compounds the known coverage gap that `agents.tsx:172` early-returns
before its `PageHeader`. Add per-page harness seeds before Phase C7.

---

# Third CI run (commit 68df93f) — GREEN

All 13 checks success, including `CI success`, `Visual regression (78 baselines)`,
`Design drift ratchet + contrast gate`, `Accessibility baseline` and the new
`Font provenance`. PR #2 is mergeable.

Two things this run *proved*, rather than assumed:
1. **`--disable-lcd-text` closed the machine gap.** 36 baselines regenerated on
   Debian trixie passed unmodified on ubuntu-24.04. So the rasteriser is now
   environment-independent, and per the condition recorded above, the
   "regenerate only from CI" rule is relaxed to "any Linux may regenerate, CI is
   the authority". Documented in the header of `playwright.visual.config.ts`
   together with the four pins the claim depends on.
2. **The `maxDiffPixels: 100` justification was wrong.** It described the
   Debian-vs-ubuntu term as "unmeasurable from here". CI measured it: 3-134 px on
   12 shots, from antialiasing mode. That headroom now covers no known risk, so
   the honest value is probably 0. NOT changed here — tightening a gate in the
   same commit that turns it green is how you get a gate nobody trusts. Left as a
   recorded follow-up needing one clean CI run at 0 as evidence.

## Status
- [x] F1 diagnosed
- [x] F2 diagnosed
- [x] F3 diagnosed as environment, confirming with the diff artifact
- [x] F4 diagnosed (settle() mount race)
- [x] F5 diagnosed (blockApi shadowed by blockOffOrigin)
- [x] F1 fixed (`4b3eaed`)
- [x] F2 fixed (`.env.visual` + `--mode visual` + F4)
- [x] F3 fixed locally (font stack + glyph fallback + pinned env); **baselines still
      to be regenerated on ubuntu-24.04 via `visual-baselines.yml`**
- [x] F4 fixed
- [x] F5 fixed
