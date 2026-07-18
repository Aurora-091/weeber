---
adr: 44
title: "Fixed `.theme-weeber` light/dark color inversion bug"
date: 2026-07-11
status: Accepted
---

## ADR-044 — Fixed `.theme-weeber` light/dark color inversion bug

**Date:** 2026-07-11

**Context:** User reported the product theme (`/dashboard`, `/app`) looked wrong — expected black+grey
for dark mode and white for light/day mode, but the app didn't behave that way. Investigation found a
real bug, not a preference mismatch: base `.theme-weeber` (applied regardless of light/dark toggle)
held the near-black monochrome palette itself (`--weeber-paper: oklch(0.145 0 0)`), while
`.theme-weeber.dark` held an entirely unrelated leftover warm/purple palette from the original
ADR-032 round (chroma 0.014–0.019, a blue-violet `oklch(0.68 0.16 275)` accent) that ADR-039's
"recolor to monochrome" pass never actually touched. Net effect: the default/light state rendered
near-black, and toggling to "dark" made it warmer and purple-accented instead of darker and
monochrome — exactly backwards from "light = white, dark = black/grey."

**Decision:** Rewrote both blocks in `packages/web/src/web/styles.css`. Base `.theme-weeber` is now
the real light-monochrome variant (near-white background `oklch(0.99 0 0)`, near-black text,
light-grey borders, black-on-white inverted accent). `.theme-weeber.dark` now holds the correct
near-black monochrome palette that used to sit in the base block. The stale warm/purple block is
gone entirely, not just superseded. Semantic success/warning/error colors were re-tuned for each
background (light-mode soft variants are light tints, not the dark-mode dark tints) — same hues,
adjusted lightness only, still the one deliberate non-monochrome exception per ADR-039.

**Verified visually** (screenshot, `/app/login` with Supabase unconfigured so only the shell chrome
renders): default/light state is white background with black text; `weeber_theme=dark` in
localStorage renders near-black background with light-grey text, no purple/warm tint anywhere.

**Consequences:** No component code changed — every page reads through the same CSS variables
(`bg-background`, `text-foreground`, etc.), so this was a single-file fix. Any user who had
`weeber_theme=dark` set in localStorage before this fix will now correctly see monochrome dark
instead of the old warm/purple theme (a visual change, not a regression — the old dark state was the
bug).
