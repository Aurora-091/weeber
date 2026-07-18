---
adr: 55
title: "Agent console: full-window layout via a new `AppShell` `fullBleed` opt-out (2026-07-13)"
date: 2026-07-13
status: Accepted
---

## ADR-055 — Agent console: full-window layout via a new `AppShell` `fullBleed` opt-out (2026-07-13)

**Context:** long-standing ask (predating this session, referenced in `docs/UI-UX-AUDIT-CONTEXT.md` §2):
the agent config page should behave like a full-window console — a slim top bar with just an
agent-switcher pill/dropdown, not the standard article-width `PageHeader` layout every other page uses,
with the config form filling the remaining viewport.

**Decision:** rather than a one-off layout special-cased into `/app/agents` and `/dashboard/agents`
directly, added a `fullBleed?: boolean` prop to `AppShell` itself: when set, `<main>` skips the standard
`max-width`/padding container (`--shell-page-max-w` etc.) in favor of the full remaining viewport height
(`h-[calc(100vh-3rem)] md:h-screen`, accounting for the mobile topbar). Threaded through `UserShell` and
`DashboardShell` (both already instantiated fresh per-route in `app.tsx`, e.g.
`<UserShell><UserAgentsPage /></UserShell>`), so it's opt-in per route rather than a global shell change.
Only `/app/agents` and `/dashboard/agents` use it today.

`/app/agents` (merchant): the agent-switcher pill (already existed as a conditionally-shown `<select>`)
is now always visible in a slim top bar, even with a single agent, so the chrome stays consistent as
more agents get added — replaces the previous `PageHeader` entirely on this page. `/dashboard/agents`
(admin): same top-bar treatment applied to the existing org picker (now a pill, consistent styling with
the merchant page), keeping the accordion list of agents below it rather than rebuilding that mechanic —
lower risk than a full rewrite, same visual language.

Also added `collapsible` to `DashboardShell` (previously only `UserShell` had sidebar icon-collapse) for
parity between the two shells, and added missing `isError` states to both agent-configs fetches (a
fetch failure was previously indistinguishable from "no agents configured yet").

**Consequence:** `fullBleed` is available to any future page needing this treatment (the Workflow
Canvas editor pages are a natural next candidate, not done as part of this ADR). The agent-page
full-window redesign requested layout decisions the original audit doc flagged as open (collapse-to-
icons vs. full-hide; pill placement; admin org-picker parity) — resolved here as: icon-collapse (existing
mechanism, not full-hide), pill replaces the page header entirely, and the admin org-picker gets the same
pill treatment rather than being dropped.
