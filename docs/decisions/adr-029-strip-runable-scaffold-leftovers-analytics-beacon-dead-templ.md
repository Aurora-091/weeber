---
adr: 29
title: "Strip Runable-scaffold leftovers: analytics beacon, dead template files, placeholder identifiers"
date: 2026-07-09
status: Accepted
---

## ADR-029 — Strip Runable-scaffold leftovers: analytics beacon, dead template files, placeholder identifiers

**Date:** 2026-07-09

**Context:** The repo was originally scaffolded from Runable's internal managed-app template, and several
pieces of that scaffolding never got cleaned up as the project turned into a real, independent, public
open-source repo. A pass looking specifically for "things that shouldn't be in a public repo" turned up:

- A **third-party analytics beacon** (`packages/web/vite/plugins/runable-analytics-plugin.ts` +
  `packages/web/public/runable.js`) that a Vite plugin silently injected into every production build,
  sending every visitor's page views to `https://r.lilstts.com/events` (Runable's own collector,
  "onedollarstats" under the hood) with zero disclosure anywhere in the app, privacy policy, or docs. Same
  pattern existed in the mobile shell (`OneDollarStatsProvider` in `packages/mobile/app/_layout.tsx` +
  `packages/mobile/lib/analytics.ts`, `onedollarstats` npm dependency). For a project whose entire pitch is
  "compliance-first, self-hosted, read-the-code-and-trust-it" (TCPA/GDPR/HIPAA positioning throughout the
  landing page and docs), silently phoning a third-party analytics collector on every self-hosted deploy is
  a direct contradiction of the project's own stated values, not just an unused file.
- **`.runable/`** — Runable-platform-internal release-tracking tooling (`validate-releases.ts`,
  `releases.json`, its Zod schema) with no relevance to OpenVent as an independent project; wired into the
  `lint` npm script (`validate:releases`), so it ran on every contributor's machine and in CI for no reason
  a self-hoster or contributor could make sense of.
- **`package.json`'s `name` field** was still literally `"sandbox-app-template"` — the raw scaffold name,
  never renamed to `"openvent"`. Cosmetic, but exactly the kind of thing that undermines trust in a repo
  asking for outside contribution (ADR-028).
- **`.env.template`** — a second, unreferenced env-file template left over from the original scaffold,
  listing unrelated platform env vars (`BETTER_AUTH_SECRET`, `AUTUMN_SECRET_KEY`, `APPLICATION_ID`) that
  don't exist anywhere in OpenVent's actual code. `.env.example` is the real, accurate, already-documented
  one; the second file was pure confusion for anyone setting up a dev environment.
- **`packages/web/website.config.json`** still had `"name": "Runable"` and `"hostname": "xyz.runable.site"`
  — unfilled scaffold placeholders.
- **`packages/mobile/app.json`** had `"package"/"bundleIdentifier": "com.appId.runable"` (a literal,
  never-filled-in template placeholder) and a hardcoded `apiUrl` pointing at a dead internal Runable preview
  URL (`voiceag-1mf8gfp-preview-4200.runable.site`) plus a Runable-internal `applicationId` — none of it
  meaningful outside the original sandbox session it was generated in.
- Two landing-page copy spots (`faq.tsx`, `cta-footer.tsx`) still said "fair-code" / "OpenVent Sustainable
  Use License" after ADR-028 moved the project to Apache 2.0 — the license file changed but two prose
  mentions were missed in that round.

Removing the `.runable/`-wired `validate:releases` step also surfaced that the root `zod`/`semver`/
`@types/semver` devDependencies existed only to support that deleted tooling — `packages/web` already
depends on its own `zod` directly, so nothing else used the root copies.

Deleting the analytics plugin also exposed a latent, unrelated type-checking gap: six files
(`gohighlevel.ts`, `google-calendar.ts`, `hubspot.ts`, `salesforce.ts`, `hono-dev-plugin.ts`) were only
passing `tsc -b` because `jsdom`'s ambient types (pulled in only by the now-deleted plugin importing
`jsdom`) were incidentally providing a looser global `fetch`/`Request`/`Response` type than `bun-types`
actually defines on its own. With that incidental import gone, `tsc -b --force` correctly failed on `.json()`
calls typed as `{}`/`unknown` and a `new Request(url, ...)` call passed a `URL` instead of a `string`. These
were real, pre-existing gaps in the type coverage of those files, just masked by an accidental transitive
import — not something introduced by this cleanup, but only surfaced by it.

**Decision:**
- Delete the analytics plugin, its injected script, and the mobile `OneDollarStatsProvider` wiring +
  `onedollarstats` dependency entirely. No replacement telemetry added — if usage analytics are wanted
  later, they need to be an explicit, disclosed, opt-in choice documented in the privacy-relevant docs, not
  a silent build-time injection.
- Delete `.runable/` and the `validate:releases` step from `package.json`'s `lint` script.
- Rename `package.json`'s `name` to `"openvent"`; drop the now-unused `zod`/`semver`/`@types/semver` root
  devDependencies.
- Delete `.env.template`; `.env.example` remains the single source of truth for env setup.
- Fix `website.config.json` and `packages/mobile/app.json` placeholders to real OpenVent values
  (`dev.openvent.mobile` for bundle/package identifiers, no hardcoded stale preview URL —
  `packages/mobile/lib/api.ts` already falls back to `EXPO_PUBLIC_API_URL` if the Expo config extra is
  empty).
- Fix the two stale "fair-code" mentions in landing-page copy to reflect Apache 2.0.
- Fix the six real type-checking gaps directly (`as any` casts on external API JSON responses in the four
  integration files — these are untyped third-party API bodies by nature, so a cast is the honest
  representation, not a workaround; `url.toString()` in `hono-dev-plugin.ts` so `Request`'s first argument
  matches its actual type; removed the now-unneeded `@ts-expect-error` on `duplex` since the overload
  resolves cleanly once the first argument is a plain string) rather than papering over them or
  reintroducing an incidental `jsdom` import just to keep the previous (accidental) type behavior.

**Consequences:** Verified via `tsc -b --force` (clean, no incremental-cache shortcuts), `vite build`
(clean — confirmed the built `dist/index.html` no longer contains any reference to the analytics script),
`bun run lint`/oxlint (0 warnings/errors), 55/55 web tests, 25/25 `@openvent/compliance` tests. Anyone
self-hosting OpenVent from this commit forward sends zero telemetry anywhere unless they explicitly wire up
their own. `packages/desktop`'s `package.json`/`app` naming (`@template/desktop`, etc.) and the mobile/
desktop packages' internal workspace names (`@template/web`, `@template/mobile`) were deliberately left
alone in this round — those are internal-only workspace package names never published or exposed to end
users, and renaming them touches every cross-package import; not worth the blast radius for a cosmetic-only
concern, unlike the public-facing identifiers and behavior fixed above.
