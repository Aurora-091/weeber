---
adr: 099
title: A font fetched at render time is not a pinned input
date: 2026-08-11
status: Accepted
supersedes: none
amends: none (corrects a claim in playwright.visual.config.ts's pin list)
related: ADR-090 (ratchets), ADR-075 (a required check must assert what succeeded), font-provenance.spec.ts, docs/changelog/2026-08.md
---

# ADR-099 — A font fetched at render time is not a pinned input

## Status

**Accepted and implemented on 2026-08-11.** Four commits on `main` were red; the cause was upstream,
not in this repo.

## Context

`main` had been failing CI for four consecutive commits — `91efb0f`, `075c70e`, `6c9b6d6`, `2a29a18`.
Three jobs were red across them: `visual`, `fonts`, and the `CI success` aggregate that depends on
both. (`lint` was separately and trivially red on `2a29a18` only — see the note at the end.)

The first thing worth stating is what the diffs were **not**. `git show --stat` on all four commits
shows exactly one file changed under `packages/web` across the entire range, and it is
`responsive-grid.test.ts` — two lines, no rendered output. Three of the four commits are backend and
docs only. So the pixels moved with no source change, which is the signature of an unversioned input,
not of a regression.

The failures did not agree with each other either:

- `visual` failed 6 of 78 shots in CI (`app-calls`, `app-integrations`, `app-leads`, `dash-dnc`,
  `dash-settings`, `dash-templates`), and 1 of 78 on a Debian trixie machine (`dash-dnc @ 1440-dark`).
- `fonts` failed 2 of 26 routes in CI (`app-leads`, `dash-analytics`) and **0 of 26** locally.

A gate whose failure set changes per machine and per run is measuring the machine.

The diff itself named the culprit. Cropping the one locally-reproducing failure to its changed
bounding box — a single 28px band at the top of the shell — shows the admin wordmark and the page
title rendered in a visibly lighter, narrower cut of Fraunces than the baseline. Same glyphs, same
positions, different optical grade. And `fonts` was reporting `Liberation Serif x30 via [Fraunces,
ui-serif, serif]`: Chromium falling through the `--font-display` stack to the distro's Times
substitute for some nodes, on some runs.

Both symptoms have one cause, and `_settle.ts` had already written it down, under protest:

> Google Fonts is on this list under protest. styles.css:1 @imports the CSS2 endpoint, so the four
> brand families are fetched from a third-party CDN at test time — which means the fonts, and
> therefore the pixels, are an input this repo does not version.

`styles.css:1` was `@import url("https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@...")`.
Every screenshot in this repo was a photograph of whatever binary Google served that minute, and
`ALLOWED_OFF_ORIGIN` in the screenshot guard existed solely to let that request through. Upstream
Fraunces moved; 78 baselines and a provenance gate moved with it, on a branch where nobody had touched
the frontend.

This also falsifies one of the four claims in `playwright.visual.config.ts`'s header, the list that
justifies letting any Linux machine regenerate baselines:

> - the font FILES are pinned to webfonts, enforced by font-provenance.spec.ts

"Pinned to webfonts" and "pinned" are different properties. `font-provenance.spec.ts` proves a glyph
came from *a* webfont; it cannot prove it came from the *same* webfont as last week, because the file
had no version. That pin was the one that sprang, exactly as the config's own instruction anticipated
("find out which of the four pins above has sprung — do not raise `maxDiffPixels`").

## Decision

**The four brand families are self-hosted from version-pinned npm packages, and the screenshot suite
is allowed to reach nothing off-origin at all.**

1. `@fontsource-variable/{fraunces,inter-tight,jetbrains-mono,bricolage-grotesque}` at `5.3.0`, pinned
   in `bun.lock`. These ship the same Google Fonts binaries; the version that matters is the font
   build, and fontsource records it (`fraunces` → `v38`, `lastModified 2025-09-10`).
2. `styles.css` imports the fontsource sheets instead of the CSS2 URL. Fraunces and Bricolage use the
   `standard` sheets — the `opsz` + `wght` axes, i.e. what the CSS2 endpoint was returning — plus
   `standard-italic` for Fraunces, which ships italics as a separate file. Inter Tight and JetBrains
   Mono are `wght`-only and use `index`.
3. The `--font-*` stacks and `.marketing .font-display` lead with the `... Variable` family names and
   keep the plain names behind them, so the old names remain a valid fallback and no consumer changes.
4. `ALLOWED_OFF_ORIGIN` in `e2e-visual/_settle.ts` becomes **empty**. It only ever held the two font
   hosts. With the fonts bundled by Vite and served same-origin, a screenshot run now reaches nothing
   but `localhost`, and reintroducing a CDN `@import` fails the visual suite instead of silently
   moving 78 baselines a second time.

### What this is not

It is not a baseline update. **Zero baseline bytes changed** — `test:visual:update` rewrote nothing
and a clean `test:visual` is 78/78. The npm-pinned Fraunces build is the same one the committed
baselines were generated from; Google's live CDN had drifted ahead of it. That is the strongest
available evidence for the diagnosis: pinning the input restored the exact prior rendering rather than
producing a new one. Had this been fixed by regenerating, the drift would have been laundered into the
baselines and would have recurred on the next upstream release.

It is also not a widened ratchet. No `ALLOWED` entry was added to `font-provenance.spec.ts` (it stays
`[]`), no `maxDiffPixels` was raised, no knip or design or contrast baseline was touched.

## Alternatives rejected

- **Regenerate the 78 baselines against the new upstream Fraunces.** Makes CI green today and
  guarantees the same red main on Google's next release, while permanently accepting a third party's
  release schedule as a CI input. This is the option the `visual-baselines` workflow exists for and it
  is the wrong one here, because the diff was not a design change.
- **Add `Liberation Serif` to the provenance `ALLOWED` list.** The gate's own rule is that an escape
  must name the glyph and the reason. There is no glyph here — every character in "Command palette" is
  covered by Fraunces. The escape was a failed network fetch, which is precisely what the gate is for.
- **Raise `maxDiffPixels` or `threshold` until the six shots pass.** Explicitly forbidden by the
  config header, and it would have to absorb a full change of typeface weight — enough to hide any
  real regression the suite exists to catch.
- **Vendor the `.woff2` files into `public/` by hand.** Same pinning benefit, but the version becomes
  tribal knowledge in a commit message instead of a lockfile entry, and subset/unicode-range
  maintenance becomes ours. npm already solves this.
- **Self-host but keep the CDN as a fallback.** Reintroduces the unversioned input on exactly the runs
  where the local one failed, which is the hardest case to reproduce.

## Consequences

- The build gains ~852 KB of `.woff2` across 21 subset files. Users download far less: `unicode-range`
  means a latin-only page fetches 4 of them. In exchange, the render-blocking cross-origin `@import`
  on the critical path is gone, along with a DNS lookup and TLS handshake to a third party — this is
  a first-paint improvement, not a cost.
- One fewer third party is in the page-load path in production, which is also one fewer entry for the
  privacy/security posture in `docs/reference/security.md`.
- Upgrading a typeface is now a deliberate, reviewable `bun add` that shows up in `bun.lock`, and the
  baseline diff that follows it is a design decision with a commit attached to it.
- The claim in `playwright.visual.config.ts`'s pin list is now true rather than aspirational. The list
  should be read as load-bearing: when a pixel gate goes red with no source change, check the four
  pins before touching a baseline.

## Note on the `lint` failure

Unrelated and one line. `2a29a18` replaced the `HERE = dirname(...)` construction in
`tools/dead-code/knip-gate.ts` with `import.meta.dir` but left `dirname` in the `node:path` import, so
`oxlint --deny-warnings` reported `Identifier 'dirname' is imported but never used` — 0 warnings, 1
error. The import is corrected. Worth noting only because it is the third time a required check on
`main` has been red for a reason a reviewer would call trivial while a real defect sat behind it in
the same run (ADR-075).
