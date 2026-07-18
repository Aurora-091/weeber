---
adr: 45
title: "Weeber marketing/waitlist page: faithful visual port from Vocalist, real brand assets"
date: 2026-07-11
status: Accepted
---

## ADR-045 — Weeber marketing/waitlist page: faithful visual port from Vocalist, real brand assets

**Date:** 2026-07-11

**Context:** The landing page's waitlist section (built ADR-041) was a from-scratch minimal
reinterpretation into `.theme-weeber`'s dark-monochrome system — deliberately not a copy of
Vocalist's actual marketing site. User explicitly corrected this: wanted Vocalist's real design
replicated exactly (animations included, copy verbatim), not reinterpreted. Separately, `index.html`
and `public/` were still branded for "OpenVent" (the unrelated open-source self-hosted portfolio
project this template was originally bootstrapped from) — wrong title, meta tags, OG image,
JSON-LD, and a generic favicon/logo instead of Weeber's actual brand assets.

**Decision:** Full faithful port of Vocalist's `src/pages/Waitlist.tsx` (its entire pre-launch
homepage — hero, live agent demo widget with real recorded call audio, animated stats, verticals,
how-it-works, platform/integrations, upcoming verticals, security, "why we exist," founders quote,
FAQ) plus its nav, footer, and enterprise-inquiry dialog, using Vocalist's copy verbatim where it
still applies. Kept as a **separate token system** (`.marketing`, `--m-*` in styles.css) from
`.theme-weeber` (`--weeber-*`) — same separation Vocalist itself has between its marketing site and
product dashboard; the public site and the product surfaces are allowed to look different on
purpose.

Adapted for openvent's stack (not a byte-copy):
- `react-router-dom`'s `Link to=`/`useLocation` (object) → wouter's `Link href=`/`useLocation`
  (tuple), in `MarketingNav`/`MarketingFooter`.
- Supabase edge functions (`waitlist-join`, `waitlist-phone`, `enterprise-inquire`) → openvent's own
  backend: `POST /api/public/waitlist` + `/waitlist/phone` (already built, ADR-041's referral/
  position/count system — kept as-is, only the visual layer changed) and a new
  `POST /api/public/enterprise-inquiry`, routed through the existing `support_tickets` table with a
  fixed `"Enterprise inquiry"` subject tag rather than a dedicated table — a single lead-capture
  form doesn't need its own schema.
- Referral URL uses `window.location.origin` instead of a hardcoded domain.
- Real brand assets fetched from Vocalist's `public/` (`weeber_logo_transparent.png`,
  `weeber_favicon_transparent.png`, two real recorded demo-call MP3s) and the old OpenVent-OSS
  `favicon.ico`/`logo-mark.png`/`logo-lockup.png` removed. `index.html` fully rebranded — title, meta
  description/keywords, OG/Twitter tags, JSON-LD, favicon links — from "OpenVent — Self-Hosted Voice
  Agent Infrastructure" to Weeber's actual copy. New `WeeberLogo` component (ported as-is).
- Fixed three lint violations the ported markup introduced (`no-autofocus` on the enterprise dialog's
  step inputs, `media-has-caption` on the demo audio — same disable-comment pattern already used
  elsewhere for a synthesized-audio player with no caption track available, `no-redundant-roles` on
  nav/footer's explicit `role="banner"`/`role="contentinfo"`, which duplicate the elements' implicit
  ARIA roles).

**Known gap, not fixed here:** the OG image (`og-image.png`) is still the old OpenVent-OSS one —
Vocalist's own `public/images/og-image.png` reference was a broken/placeholder file when fetched, no
valid replacement available. A real 1200x630 Weeber-branded OG image is a follow-up, not blocking.

**Consequences:** Verified with a real build + screenshot (light mode: white hero, waveform bars,
demo widget rendering correctly with the actual COD-confirmation audio; confirms ADR-044's color fix
alongside it). api tsc + 144/144 tests, web tsc + tests + build, openvent-compliance tsc + 25/25
tests, root lint — all clean.
