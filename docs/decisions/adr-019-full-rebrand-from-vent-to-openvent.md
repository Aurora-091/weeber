---
adr: 19
title: "Full rebrand from 'Vent' to 'OpenVent'"
date: 2026-07-08
status: Accepted
---

## ADR-019 — Full rebrand from "Vent" to "OpenVent"
**Date:** 2026-07-08

**Context:** The exact domain `vent.com`/`.dev`/`.org`/`.app`/`.ai`/`.io`/`.co` was unavailable across every
budget-reasonable TLD. `openvent.dev` was available at a flat, honest renewal price (no bait-and-switch
TLD pricing), and — unlike a suffixed domain trick (e.g. `getvent.dev`) — "OpenVent" also does real
positioning work: it puts the project's actual thesis (open-core, self-hosted, read-the-code-before-you-
trust-it) directly in the name, not just the URL. The alternative considered was keeping the product name
"Vent" and only using a prefixed domain — cheaper to execute, but it leaves the domain and the brand saying
two different things forever.

**Decision:** Full rename, not just a domain-layer relabel: product name, landing page copy, docs, README,
LICENSE (now the "OpenVent Sustainable Use License"), the standalone compliance package (`@vent/compliance`
→ `@openvent/compliance`, folder `packages/vent-compliance` → `packages/openvent-compliance`), and the
admin-auth header (`X-Vent-Admin-Key` → `X-OpenVent-Admin-Key`, updated in both the frontend client and the
backend middleware that reads it). Alongside the rename, added a full SEO/AEO layer that didn't exist
before: `index.html`'s title was a literal placeholder (`"Web"`) with no meta description, no Open Graph
tags, and the `og-image.png` was an unrelated leftover template asset — all replaced with real OpenVent-
specific meta tags, a new branded OG image, `SoftwareApplication` + `FAQPage` JSON-LD, `robots.txt`,
`sitemap.xml`, and `llms.txt` (a plain-text summary aimed at AI answer engines/crawlers). A visible FAQ
section was added to the landing page itself so the `FAQPage` schema reflects real on-page content rather
than being schema-only (search engines can penalize or ignore structured data that doesn't match visible
page content).

**Consequences:** Historical entries above this one in this file are left as originally written — they
correctly record what the project was called and how the package was named at the time each decision was
made. Only this entry and everything going forward uses "OpenVent." The GitHub repository itself was not
renamed (still `github.com/I-invincib1e/vent`) — GitHub repo renames risk breaking the existing Vercel Git
integration, and the badge/link in `README.md` already points at the correct fork; only the product's own
name, package name, and public-facing copy changed. No functional code changes beyond the header rename
(compliance/auth logic itself is untouched).
