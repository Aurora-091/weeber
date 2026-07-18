---
adr: 39
title: "Weeber product theme recolored: dark, fully monochrome (overrides ADR-032)"
date: unknown
status: Supersedes prior
---

## ADR-039 — Weeber product theme recolored: dark, fully monochrome (overrides ADR-032)

**Decision:** `.theme-weeber` (scoped to `/dashboard` admin panel and `/app` merchant portal only — the
public OSS landing page is untouched) is now dark-by-default and fully monochrome: near-black background,
light-grey foreground, zero brand/accent hue anywhere, including primary buttons and the active-nav state
(those render as an inverted light-grey/white-on-black treatment instead of a color). This replaces
ADR-032's confirmed round (warm off-white paper background + a distinct indigo/violet brand accent).

**Context:** User request, explicit and direct: replace the brown/ember-adjacent warm palette with
black-and-grey, "the full thing." Confirmed via follow-up: dark by default (not a light/dark toggle
defaulting to dark — just dark), fully monochrome including primary/CTA/active-nav (the stricter of two
offered options), applied to both `/dashboard` and `/app` (not just one surface).

**One deliberate exception, flagged rather than silently decided:** the semantic error/success/warning set
stays as distinct hues (kept the same lightness/chroma shape as before, just re-tuned for a dark
background) rather than going fully grayscale too — a DNC/guardrail/call-outcome alert needs to be
scannable at a glance, and "everything is the same grey" would defeat that for a compliance-adjacent
product. If the user actually wants zero color anywhere including status indicators, that's a quick
follow-up change to the same CSS block, not a re-architecture.

**Consequences:** `packages/web/src/web/styles.css`'s `.theme-weeber` block rewritten — same variable
names/structure as ADR-032 (background/foreground/card/primary/etc. all still map through
`--weeber-*` tokens), only the actual OKLCH values changed to chroma-0 (grayscale) except the three status
colors. No component code changed — every dashboard/app page already read through the CSS variables
(`bg-background`, `text-foreground`, `bg-primary`, etc.) rather than hardcoded colors, so the recolor was a
single-file change. Verified visually (screenshot) on both the admin-key-gate screen (`/dashboard`) and the
merchant login screen (`/app/login`) — both render correctly as near-black/monochrome. The existing
light/dark toggle scaffold (`lib/theme.ts`, `theme-toggle.tsx`) is unchanged and still harmless-but-inert
(no `.theme-weeber.dark`-specific rule exists, same as before this round — toggling doesn't currently do
anything either way, pre-existing gap, not introduced or worsened here).
