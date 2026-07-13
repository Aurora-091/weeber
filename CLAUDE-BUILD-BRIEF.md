# CLAUDE-BUILD-BRIEF.md — Admin Panel + User Dashboard

Execution-level brief for building the two dashboards on top of this fork. Read `WEEBER-PLAN.md` and ADR-030/
ADR-031 in `DECISIONS.md` first — this doc is the "how to build it" layer on top of "what to build" from
those. Every decision below was explicitly confirmed, not assumed — treat it as a spec, not a suggestion.

## 1. Design system

**shadcn/ui + Tailwind.** Already prerequisite-complete in `packages/web`:
- `components.json` exists (added this round) — style `new-york`, base color `zinc`, aliases pointing at
  `@/components`, `@/lib/utils`, `@/components/ui`.
- `src/web/lib/utils.ts` has the `cn()` helper shadcn components expect.
- `src/web/styles.css` is Tailwind v4's CSS-based `@theme inline` setup with CSS custom properties for every
  color/radius/font token — this is exactly the mechanism shadcn's own theming expects, already in place.
- `clsx`, `tailwind-merge`, `class-variance-authority`, `tw-animate-css` are all already dependencies.
- One component exists today (`src/web/components/ui/button.tsx`), hand-copied before `components.json`
  existed. Once building starts, prefer `bunx shadcn@latest add <component>` over hand-writing new ones —
  it'll place them correctly and stay consistent with what's already there.

**Icons:** `lucide` (set in `components.json`) — already a common choice, no new dependency decision needed.

## 2. Brand direction — starting proposal, not final

No brand assets exist yet for the user-facing product. Rather than block on that, here's a concrete
starting point that's clearly *not* a reskin of OpenVent's editorial serif/ember landing page, and is
swappable later since it's just CSS variables in `styles.css`:

- **Type:** A clean grotesque/geometric sans for UI (e.g. Inter or Geist — either is a safe, neutral,
  user-SaaS-appropriate choice, unlike OpenVent's editorial Fraunces serif). Keep JetBrains Mono for any
  code/API-key display, matching the existing convention.
- **Palette direction:** A trust-oriented SaaS palette — a single confident accent (blue or a deep teal/green
  reads well for "commerce ops" tools) on a neutral zinc/slate base, not the ember/warm-editorial palette.
  Concretely, as a starting point: accent `#2563EB` (blue) or `#0F766E` (teal) — pick one, don't need both.
- **Logo/wordmark:** Not designed here — placeholder text wordmark ("Weeber") is fine until real brand work
  happens; don't let this block the build.

Whoever owns actual brand work should replace this proposal wholesale — it exists so the build has *something*
concrete to start from, not to preempt real design decisions.

## 3. Codebase structure

Both dashboards live in `packages/web` — no new package, no new repo.

```
src/web/
  pages/
    dashboard/          # EXISTING — becomes the internal admin panel
      calls-list.tsx    # existing
      call-detail.tsx   # existing
      dnc.tsx           # existing
      audit.tsx         # existing
      settings.tsx      # existing (admin keys)
      orgs.tsx          # NEW — org/shop list + connection status
      templates.tsx     # NEW — agent template catalog (reads/writes `agentTemplates`)
      billing.tsx       # NEW — billing/plans oversight across orgs
      compliance.tsx    # NEW — DNC/compliance oversight across orgs
      flags.tsx         # NEW — feature flags
      # impersonate.tsx never shipped as its own page (folded into users.tsx's "Log in as"
      # action instead, see \u00a74 point 6) -- and the whole capability was later removed
      # entirely. No impersonation exists in this codebase anymore.
    app/                # NEW ROUTE TREE — user-facing, org-scoped
      home.tsx          # dashboard landing page (/app) — checklist card + vertical-driven metrics;
                         # setup is now components/app/setup-modal.tsx opened on top of this, not its
                         # own page (see DECISIONS.md ADR-047 — this line used to say "onboarding.tsx",
                         # that file no longer exists)
      agents.tsx         # form-based agent config (persona/tone/KB per agent)
      calls.tsx          # call history + transcripts, scoped to the logged-in org
      analytics.tsx      # recovery rate, COD confirm rate, feedback scores
      billing.tsx        # usage + plan, user's own view
      integrations.tsx   # Shopify connection status + Twilio/Plivo/Exotel telephony BYO (built as
                         # integrations.tsx, not the originally-planned shopify.tsx name)
  components/
    dashboard/          # existing admin-panel components stay here
    app/                # NEW — user-facing components
```

`/dashboard/*` continues to be gated by `requireAdminKey` (existing middleware, unchanged). `/app/*` gets a
new Supabase-session-based auth check (see \u00a77) — these are two different auth systems on purpose, not
unified, because they're for two different audiences with different trust levels.

## 4. Admin panel — what it manages

**Point 6 (impersonation) below is historical — the capability was built, then removed
entirely** (DB table dropped, all routes/UI deleted — see DECISIONS.md's removal ADR).
Kept here only so nobody reintroduces it without knowing it was a deliberate call, not an
oversight.

Confirmed scope (originally six, now five — impersonation removed):
1. Orgs/shops list + connection status (reads `orgs` + `shopLinks`)
2. Agent template catalog (reads/writes `agentTemplates` — the vertical-agnostic seam, see ADR-031)
3. Billing/plans oversight (depends on the billing integration existing — see `WEEBER-PLAN.md` workstreams;
   this page can ship as read-only against `orgs.planName` before real billing integration lands)
4. Compliance/DNC oversight across all orgs (depends on per-org DNC existing — currently DNC is still global,
   see the earlier per-org-DNC discussion; this page should clearly label itself "global DNC list" until
   that lands, not imply per-org isolation that doesn't exist yet)
5. Feature flags (new, simplest possible implementation is fine — a flat table, org-scoped or global boolean
   flags, no need for a full flag-management product)
6. **User account impersonation — hard requirement: every impersonation action must write an audit log
   entry** (who impersonated which org, start time, end time/duration, at minimum). This was explicitly kept
   in scope despite being a real security surface — the audit trail is the non-negotiable part of that
   decision, not optional hardening to add later. Reuse the existing audit-trail patterns in
   `packages/openvent-compliance/src/audit-trail.ts` as the model for how this should be structured (append-only,
   queryable, not just a console log line).

## 5. User dashboard — pages in v1

Confirmed scope (six pages, Team/seats explicitly deferred per the org-lite decision):
1. **Onboarding wizard** — guided setup, ends with a connected Shopify store and at least one agent enabled.
   This is also where the "zero setup" pitch either holds up or doesn't — prioritize this feeling actually
   simple over feature-completeness.
2. **Agent config** — form-based (not a visual flowchart, per the earlier decision), one form per agent
   (persona/tone text, KB upload, on/off toggle). Reads/writes wherever the config-storage migration (see
   `WEEBER-PLAN.md`'s "Config storage" section — env-var to DB) lands; build that migration first, this page
   depends on it existing.
3. **Call history + transcripts** — org-scoped view over `calls`/`transcripts` (already `orgId`-scoped from
   ADR-030 — this page is mostly a filtered read, not new backend work).
4. **Analytics/KPIs** — recovery rate, COD confirm rate, feedback scores. **Blocked on order-value
   attribution not existing yet** (flagged in `WEEBER-PLAN.md`'s Phase 2 list) — don't ship a recovery-rate
   number until that's real; a fabricated metric is worse than no metric for a compliance-first product.
5. **Billing/usage** — user's own plan + usage, depends on the billing integration workstream.
6. **Shopify connection/settings** — status (connected/disconnected), reconnect flow, links back to the
   weebersh OAuth install URL.

## 6. Quality gates

CI is already strict (`.github/workflows/ci.yml` — typecheck, both test suites, build, lint on every push/PR
to `main`), inherited from the public OpenVent repo. **Not yet done: enable branch protection on `main`**
(GitHub repo Settings → Branches → require the CI status check before merge) — this is a dashboard toggle,
not a file, and it's the actual enforcement mechanism; the workflow existing without branch protection is
advisory, not a gate. Do this before multiple people start pushing to this repo.

Any new backend logic (new routes, new tools, anything in `packages/openvent-compliance`) needs `bun:test`
coverage matching the existing style (see `gohighlevel.test.ts`/`hubspot.test.ts` for the pattern — test the
actual function directly, no mocking framework). UI/dashboard code doesn't need the same bar, but anything
with real logic (form validation, KPI calculation) should still get a test.

## 7. Staging vs. production

Fully separate, top to bottom:
- Separate Fly.io (or Railway) app for staging vs. production.
- Separate Supabase project for staging vs. production (different `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`).
- Separate Twilio subaccount for staging, with dedicated test numbers — never test against real user
  Twilio numbers.
- `weebersh` needs a staging install target too (a dev Shopify store) — coordinate with whoever owns that
  repo's staging setup; the contract (`WEEBER_INTERNAL_SECRET`/`WEEBER_CALLBACK_SECRET`) needs distinct
  values per environment, not shared between staging and production.

## 8. API conventions for new backend code

Follow what's already here, don't introduce a second style:
- **External API calls** go through the `resilientCall` wrapper (see
  `src/api/voice/integrations/resilient-fetch.ts` and how `hubspot.ts`/`salesforce.ts` use it) — timeout,
  retry, circuit-breaker, per-integration isolation. Any new outbound integration (a payment gateway, a new
  CRM) uses this, not a bare `fetch()`.
- **Storage access** goes through an adapter interface (see `compliance/adapters.ts`'s `dncAdapter`/
  `callLogAdapter` pattern) when the underlying package/module is meant to be storage-agnostic. Not every new
  table needs this — it's specifically for code that's (or might become) a standalone package.
- **Webhook idempotency** follows `integrations/shopify/idempotency.ts`'s pattern — check-then-mark-processed
  against a ledger table, not ad-hoc dedupe logic per route.
- **Auth middleware** follows the existing `requireAdminKey`/`requireWeeberSecret`/`requireTwilioSignature`
  shape — a Hono middleware that checks a header/signature and either calls `next()` or returns a 401/403.
  The new Supabase-session check for `/app/*` routes should be built the same way, not as inline checks
  scattered across route handlers.

## 9. Auth model

- **`/dashboard/*` (internal admin panel):** as of 2026-07-12 this is no longer just header-based.
  `platform_admins` (email allowlist, service-role-only RLS) + `middleware/admin-session.ts` now verify a
  Supabase session JWT first; `requireAdminKey` only runs as a fallback when no Bearer token is present
  ("Use API key instead" link preserved for CI/scripts). `admin-login.tsx` is the email/password login
  page (`supabase.auth.signInWithPassword()`). If you're building against `/dashboard/*`, auth is
  Supabase-session-first, `ADMIN_API_KEY`-second — not `ADMIN_API_KEY`-only as originally planned here.
- **`/app/*` (user-facing):** Supabase Auth, email/password + magic link. `supabase/config.toml` already
  has `[auth]` enabled from ADR-030 — this build wires an actual login flow and session middleware against
  it. A logged-in user's Supabase user needs to resolve to an `orgId` (a `users`-to-`orgs` mapping table,
  not yet in the schema — add it as part of this build, keyed by Supabase user id).

## 10. Vertical-agnostic architecture

Already done at the schema level (ADR-031): `orgs.vertical` (default `"shopify"`) and the new
`agentTemplates` table (vertical, key, name, default persona prompt, default tools, active flag). Build the
Shopify UI against this seam — e.g. the agent-config page queries `agentTemplates` filtered by the org's
vertical, rather than hardcoding "3 Shopify agents" as literal UI branches. When Clinic/Hotel verticals start,
they add rows to `agentTemplates` and (eventually) their own vertical-specific UI branch — not a schema
migration.

## Open questions for whoever starts building (not yet decided, need an answer before that specific piece)

- Exact copy/tone for the onboarding wizard and the 3 agent personas — content work, not architecture,
  assign separately (see `WEEBER-PLAN.md`).
- Final brand assets (logo, exact palette) — \u00a72's proposal is a placeholder, not a commitment.
- The `users`-to-`orgs` mapping table's exact shape (single org per user vs. array, given "one owner per org"
  today but this should not architecturally prevent multi-org-per-user later) — small design decision, size
  it before writing the auth middleware.
