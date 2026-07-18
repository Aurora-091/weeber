---
adr: 47
title: "Setup modal, not a setup page — vertical-driven dashboard as the default landing route (2026-07-12)"
date: 2026-07-12
status: Accepted
---

## ADR-047: Setup modal, not a setup page — vertical-driven dashboard as the default landing route (2026-07-12)

**Context:** The merchant `/app` route pointed straight at a dedicated full-page onboarding wizard
(`pages/app/onboarding.tsx`), permanently pinned in the nav as "Setup," with step completion derived
live from `shopify/status` + `agent-configs` on every load (no persisted step/dismiss state). This is
a Shopify-only shape: `VerticalDefinition` (`lib/verticals.ts`) only carried `glossary`/`nav`/`copy`,
no dashboard content, and only one vertical (`shopify`) was ever registered — the "every vertical gets
its own dashboard metrics/cards" requirement had no seam to hang off of.

Studied two references before deciding: (1) Vocalist (github.com/Aurora-091/Vocalist, read-only
clone), whose `Dashboard.tsx` mounts an `OnboardingModal` (Dialog/Drawer) that auto-opens only when
`onboarding_state.steps` is incomplete AND the org has zero agents, with a persistent checklist card
on the dashboard for any steps the modal doesn't cover; `vertical_configs` is a global DB table
(`config` jsonb: glossary, recommended integrations/templates, dashboard metrics/cards) so adding a
vertical is an insert, not a code branch. (2) Vapi/Retell/typical SaaS practice: checklist/progress
widget on the main dashboard, not a page that gates the rest of the product.

**Decision:**
- `/app` now renders `pages/app/home.tsx` (a lightweight dashboard: checklist card while setup is
  incomplete, vertical-driven metric tiles, quick links to Agents/Conversations/Analytics) instead of
  the onboarding page. `pages/app/onboarding.tsx` is deleted; `/app/onboarding` redirects to
  `/app?setup=1`, which force-opens the modal for old bookmarks/links.
- New `components/app/setup-modal.tsx` (Dialog) holds the exact same 3 steps (connect store → pick
  agents → review & activate) and mutations the old page had — only the shell changed. It auto-opens
  from `home.tsx` when steps are incomplete and not dismissed, same gate as Vocalist.
- New `onboarding_state` table (`org_id` PK, `steps` jsonb, `dismissed`, `completed_at`,
  `updated_at` — drizzle migration `0011_grey_scarlet_spider.sql`) plus `getOnboardingState` /
  `updateOnboardingState` (`voice/org-queries.ts`) and `GET`/`PATCH /api/app/onboarding`
  (`app/routes.ts`). Steps are a free-form jsonb bag (`ONBOARDING_STEP_KEYS`), not one column per
  step, so the step set can change without a migration. The modal PATCHes step flags as they change,
  so the dashboard checklist and "resume where I left off" stay accurate even if the modal is closed
  mid-way.
- `VerticalDefinition` (`lib/verticals.ts`) gained a `dashboard` shape (`metrics[]`, `emptyState`) —
  the Home page renders these instead of hardcoding Shopify-shaped tiles, so a Clinic/Insurance/Real
  Estate vertical added later gets its own dashboard content by filling in config, not by branching
  `home.tsx`. Nav also lost the separate "Setup" entry (folded into "Home").

**Explicitly not built:** no onboarding state-machine library — a jsonb steps column is enough at this
scale (proven in Vocalist production). No per-vertical dashboard component fork (separate `home.tsx`
per vertical) — config-driven tiles are enough for now. No change to the dedicated
Agents/Calls/Analytics/Billing/Integrations pages — only the entry point changed.

**Consequences:** Verified: `packages/api` tsc clean, `packages/web` tsc clean, drizzle migration
generated and reviewed (also picked up pre-existing unmigrated drift: `workflow_templates`/
`workflow_runs`/`org_workflow_configs` tables and `orgs.webhook_url`/`scheduled_calls.workflow_run_id`
columns that existed in `schema.ts` but had no prior migration file — bundled into 0011 rather than
split out, since it's one accurate diff against the last snapshot). Not yet run against a live
database (no `DATABASE_URL` in this environment) — run `db:migrate` before deploying. The two
vertical-dashboard metric tiles (`carts_recovered`, `revenue_recovered`) render as `—` placeholders
today since no backend aggregation computes them yet; wiring real values is follow-up work, not part
of this change.
