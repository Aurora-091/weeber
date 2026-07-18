---
adr: 31
title: "Design system, codebase structure, and vertical-agnostic data model for Weeber's dashboards"
date: 2026-07-09
status: Accepted
---

## ADR-031 — Design system, codebase structure, and vertical-agnostic data model for Weeber's dashboards

**Date:** 2026-07-09

**Context:** Before handing the admin panel + merchant-facing dashboard build off to a team working with
Claude, a round of explicit planning decisions was needed — design system, where the new UI lives in the
codebase, what the two dashboards (internal admin vs. merchant-facing) actually contain, CI strictness,
staging/prod separation, API conventions, auth model, and whether to generalize beyond Shopify now or later.
All decisions below were confirmed by direct answer, not assumed.

**Decisions:**
- **Design system: shadcn/ui + Tailwind.** `packages/web` already had every shadcn prerequisite in place
  (Tailwind v4 CSS-theme setup, `clsx`/`tailwind-merge`/`class-variance-authority`, a `cn()` helper, even
  `tw-animate-css`) except the actual `components.json` manifest — added this round so `bunx shadcn add
  <component>` works cleanly going forward instead of the one hand-copied `button.tsx` that existed before.
- **Merchant dashboard gets its own Weeber-branded skin, same component system** — not a reskin of the
  existing editorial serif/ember OpenVent operator look, and not a from-scratch design system either. No
  final brand assets exist yet, so `CLAUDE-BUILD-BRIEF.md` includes a starting proposal (palette, type) to
  build against now rather than blocking on brand work — swappable later via the same CSS-theme variables
  approach already in `styles.css`, not a rebuild.
- **Both dashboards live in `packages/web`, not a separate package/repo.** The existing operator dashboard
  (`/dashboard/*` — calls, DNC, audit, keys) becomes the foundation of the **internal admin panel**, extended
  with org/shop management, the agent template catalog, billing oversight, compliance/DNC oversight, feature
  flags, and merchant-account impersonation. A new `/app/*` route tree is the **merchant-facing** surface
  (onboarding wizard, agent config, call history/transcripts, analytics, billing, Shopify connection status).
  Splitting these into separate apps was considered and rejected — they share auth plumbing and org-scoped
  data access, and a second app boundary right now is complexity with no present benefit.
- **Impersonation is in scope for v1's admin panel, explicitly audit-logged.** This was flagged as a
  security surface worth deferring; the decision was to keep it in scope anyway, so the requirement is that
  every impersonation action writes an audit entry (who impersonated which org, when, for how long) rather
  than being silently possible — see `CLAUDE-BUILD-BRIEF.md` for the concrete requirement.
- **CI stays strict** — the existing `.github/workflows/ci.yml` (typecheck + test + build + lint, inherited
  from the public OpenVent repo) already matches this; no change needed to the workflow itself. The
  requirement going forward is enabling branch protection on `main` (require the CI check to pass before
  merge) — not yet configured, a GitHub repo setting rather than a file, called out explicitly in
  `CLAUDE-BUILD-BRIEF.md` so it doesn't get missed.
- **Fully separate staging and production infrastructure** — separate Fly/Railway app, separate Supabase
  project, separate Twilio subaccount with test numbers for staging. Decided now specifically because it's
  cheap before real merchant data exists and expensive to retrofit after.
- **New backend endpoints follow this repo's existing conventions exactly** — the `resilientCall` wrapper for
  external API calls, the adapter pattern for storage (see `compliance/adapters.ts`), the idempotency-ledger
  pattern (`integrations/shopify/idempotency.ts`) for any future webhook-driven integration, and the
  `requireAdminKey`/`requireWeeberSecret` middleware style for auth. Chosen over giving free discretion per
  endpoint specifically to avoid ending up maintaining two different code styles in one repo.
- **Merchant auth: Supabase Auth (email/password + magic link).** Already scaffolded (`supabase/config.toml`,
  ADR-030) but not wired to any route yet. `ADMIN_API_KEY`/`admin_keys` stays completely untouched — that
  path is for Weeber's own internal ops access, never merchant-facing.
- **Vertical-agnostic data model now, Shopify-only UI for now.** `orgs` gained a `vertical` column (text,
  default `"shopify"`, not DB-enum-constrained — a new vertical shouldn't need a migration to exist). New
  `agentTemplates` table (vertical, stable `key`, name, default persona prompt, default tool list, active
  flag) is the seed of the admin panel's "agent template catalog" and the concrete mechanism a future
  Clinic/Hotel vertical plugs into — new rows, not new schema.

**Consequences:** `components.json` and the two schema additions (`orgs.vertical`, `agentTemplates`) are
additive-only and verified via `tsc -b --force` (clean). No UI was built in this round — per direction, the
actual admin-panel and merchant-dashboard construction is Claude's build, not this pass; this ADR and
`CLAUDE-BUILD-BRIEF.md` are the spec it builds against. The impersonation audit-log requirement is a
commitment made here that the build must satisfy, not an implemented feature yet.
