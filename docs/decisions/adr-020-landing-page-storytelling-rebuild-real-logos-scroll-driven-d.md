---
adr: 20
title: "Landing page storytelling rebuild: real logos, scroll-driven diagram, drop stale demo data"
date: 2026-07-08
status: Accepted
---

## ADR-020 — Landing page storytelling rebuild: real logos, scroll-driven diagram, drop stale demo data
**Date:** 2026-07-08

**Context:** The landing page's Product Tour section showed screenshots that had gone stale — old
"Vent" branding, a placeholder phone number, a fake test transcript — while still claiming "not a
mockup, real calls." Separately, the pipeline diagram used generic lucide icons with text labels
("Twilio", "Deepgram", "ElevenLabs") instead of the providers' actual marks, and every section used
the same simple viewport-enter fade regardless of what it was trying to communicate.

**Decision:** Three changes, done together:
1. Removed the Product Tour section and its three stale screenshots entirely (`packages/web/public/
   demo/`) rather than patch them — real screenshots come later, once there's a current instance to
   capture, not before.
2. Replaced the linear icon-based pipeline with a real boxes-and-hub architecture diagram
   (`architecture.tsx`) using the providers' actual official marks (Twilio, Deepgram, ElevenLabs,
   Cartesia, Groq, n8n, Zapier, GitHub — sourced from simple-icons, Wikimedia Commons, and Cartesia's
   own site directly, never AI-generated, normalized to single-color `currentColor` React components
   in `logos.tsx` so they recolor with the rest of the UI instead of clashing brand colors), plus a
   real interactive piece: clicking the TTS node swaps its label/logo between ElevenLabs and Cartesia,
   demonstrating the actual env-var provider swap instead of just describing it in prose.
3. Gave each remaining section a scroll treatment that matches what it's saying, not a uniform fade:
   the provider strip is now an infinite logo marquee (pauses on hover), the Problem comparison table
   reveals row-by-row tied to scroll position, Features/Shipped use a scroll-stack effect (cards
   settle into place as the next arrives), Roadmap's "shipped" checkmarks scale in as you scroll past
   them, and the FAQ became a real accordion (first item open by default) instead of everything always
   expanded — while keeping every answer's text present in the DOM so the `FAQPage` JSON-LD schema
   still matches real page content. Added GSAP + `@gsap/react` for the one component (`split-text.tsx`,
   a character-by-character reveal on the hero's "OpenVent") where GSAP is a meaningfully better fit
   than Motion for staggering dozens of individual tweens; everything else stays on Motion
   (framer-motion), already the project's animation library.

**Consequences:** No backend/data changes — this is a landing-page-only round. `bunx tsc --noEmit`
and `bunx vite build` both clean, all 25 `@openvent/compliance` tests still passing (untouched by this
round). One real bug caught during this work worth noting for future editing sessions: several
sub-component definitions (`ProblemRow`, `DoneItem`) were dropped by an editing pass that replaced
their call sites without the definitions actually landing in the file, causing runtime
`ReferenceError`s that only surfaced in the browser console, not in `tsc`or the build step — worth
double-checking rendered output in-browser after structural refactors, not just relying on
typecheck/build passing.
