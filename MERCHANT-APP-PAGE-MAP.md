# MERCHANT-APP-PAGE-MAP.md — Merchant-facing frontend page inventory

**Purpose:** a structural reference for building the real merchant-facing frontend (`/app/*`,
Supabase Auth — see `CLAUDE-BUILD-BRIEF.md` §9) — *pages, routes, and navigation structure only*,
not visual design. Pulled from two sources:

1. **`github.com/Aurora-091/Vocalist`** (the earlier, more fully-built Weeber frontend) — read-only
   reference, page inventory extracted from its actual routing code (`CustomerApp.tsx`, `AdminApp.tsx`,
   `config/verticals/*.ts`) on 2026-07-10. Not cloned/copied into this repo — this doc is notes, not code.
2. **This repo's own planning docs** — `CLAUDE-BUILD-BRIEF.md` (§5 merchant dashboard scope, §9 auth
   model, §10 vertical-agnostic architecture) and `WEEBER-PLAN.md` (config storage, the 3 Shopify agents).

**What currently exists in *this* repo today (2026-07-10):** only the internal `/dashboard/*` admin
panel (`ADMIN_API_KEY`-gated, one shared key sees every org — see `docs/dashboard.md`). No merchant-facing
`/app/*` surface exists yet. Everything below is the target to build toward, not what's live.

---

## 1. Two separate apps, two separate auth models (confirmed architecture, both sources agree)

Vocalist actually shipped this as two physically separate route trees (`CustomerApp.tsx` vs
`AdminApp.tsx`), not one app with role-based hiding — worth keeping that split:

| | This repo's existing `/dashboard/*` | Merchant `/app/*` (not built yet) | Vocalist's admin app (reference only) |
|---|---|---|---|
| Who | You (operator) | Merchants (Shopify store owners) | Platform super-admins |
| Auth | `ADMIN_API_KEY` / labeled keys | Supabase Auth (email+password, magic link) | Supabase Auth + `platform_role === "super_admin"` check |
| Scope | Sees every org | Scoped to the logged-in user's own org | Sees every org, platform-wide |
| Status | **Live today** | **Not built** — this doc is prep for it | Reference only, not being rebuilt as-is |

## 2. Merchant app (`/app/*`) — confirmed v1 scope (`CLAUDE-BUILD-BRIEF.md` §5)

Six pages, Team/seats explicitly deferred:

1. **Onboarding wizard** — guided setup ending with a connected Shopify store + at least one agent
   enabled. The "zero setup" pitch lives or dies here — prioritize feeling simple over completeness.
2. **Agent config** — form-based (not a visual flowchart), one form per agent. *(This repo's
   `voice/agent-frame.ts` + the internal `/dashboard/agents` page built 2026-07-10 is the schema/pattern
   to reuse here — same fields, same API shape, just re-scoped to the logged-in merchant's own org
   instead of an org picker.)*
3. **Call history + transcripts** — org-scoped, already `orgId`-scoped from ADR-030, mostly a filtered read.
4. **Analytics/KPIs** — recovery rate, COD confirm rate, feedback scores. *(This repo's
   `/dashboard/analytics` + `GET /orgs/:orgId/analytics` endpoint, built 2026-07-10, is the same
   reusable pattern — re-scope to the logged-in merchant's own org, no org picker needed.)*
5. **Billing/usage** — merchant's own plan + usage (depends on the billing integration workstream).
6. **Shopify connection/settings** — connected/disconnected status, reconnect flow, link to the
   `weebersh` OAuth install URL.

## 3. Vocalist's actual page inventory (reference — richer than the v1 scope above, useful for what
"phase 2+" could look like once v1 ships)

Extracted directly from `CustomerApp.tsx`'s route table:

**Public / marketing:** `/` (waitlist), `/about`, `/privacy`, `/terms`

**Auth:** `/login`, `/signup`, `/auth/verify`, `/auth/callback`, `/auth/callback/:provider`

**Authenticated app** (wrapped in a shared `AppShell` — sidebar + header, matches the "one shell,
many pages" pattern already used in this repo's `DashboardShell`):

| Route | Page | Notes |
|---|---|---|
| `/dashboard` | Home | Vertical-specific dashboard cards (inbound/outbound), KPI strip, empty states |
| `/agents` | Agents list | |
| `/agents/:id` | Agent detail | Persona/prompt editing, presumably voice/tools config too |
| `/campaigns` | Campaigns list | Outbound campaign management — broader than this repo's current scheduled-call workflows |
| `/campaigns/new` | New campaign | |
| `/campaigns/:id` | Campaign detail | |
| `/calls` | Conversations | Call history — equivalent to this repo's `/dashboard` calls-list |
| `/numbers` | Numbers | Phone number management/provisioning |
| `/contacts` | Contacts (Customers/Patients/Guests per vertical) | |
| `/integrations` | Integrations list | |
| `/integrations/numbers` | Number setup flow | |
| `/integrations/shopify` | Shopify connect | |
| `/integrations/connect/:provider` | Generic integration connect flow | |
| `/voices` | Voice library | Browse/preview available TTS voices — same idea as this repo's new voice-preview button, but as its own page/catalog rather than inline in the agent form |
| `/outcomes` | Results | Outcome/disposition-focused view, separate from Analytics |
| `/analytics` | Analytics | |
| `/knowledge` | Knowledge base | Upload/manage docs the agent can reference |
| `/playbooks` | Playbooks | Reusable call-flow templates, separate from per-agent config |
| `/billing` | Billing | |
| `/settings` | Settings | |

**Not (re)built as part of the merchant `/app/*` v1** — flagging as later/optional, not urgent:
`/campaigns`, `/numbers`, `/voices`, `/outcomes`, `/knowledge`, `/playbooks` go beyond the confirmed
6-page v1 scope in §2. Worth revisiting once v1 ships and there's real merchant usage to react to,
not before.

## 4. Vertical-driven navigation (the actual mechanism, not just a concept)

Confirmed real, working pattern in Vocalist — one `VerticalDefinition` object per vertical
(`shopify.ts`, `clinic.ts`, `hotel.ts`), registered in `config/verticals/index.ts`, driving:

- **Glossary** — same page renders "Customers" for Shopify, "Patients" for Clinic, "Guests" for Hotel,
  off one glossary object, not per-vertical page forks.
- **Navigation groups** — the sidebar's actual nav items/labels/icons are data, not JSX per vertical.
- **Dashboard cards, quick actions, templates, integrations list, empty-state copy** — all vertical-scoped
  data too.

This is a more fleshed-out version of the same idea already decided in this repo's `DECISIONS.md`
ADR-031 (`orgs.vertical` + `agentTemplates` table) and `CLAUDE-BUILD-BRIEF.md` §10. Worth building the
merchant `/app/*` nav the same data-driven way from day one — a `VerticalDefinition`-style config object
per vertical, even with only Shopify enabled today — rather than hardcoding Shopify-specific labels into
page components and having to retrofit Clinic/Hotel later.

## 5. Auth wiring specifics worth reusing

- A logged-in Supabase user resolves to an `orgId` via a `users`-to-`orgs` mapping table — not yet in
  this repo's schema (flagged as an open question in `CLAUDE-BUILD-BRIEF.md`'s final section: single org
  per user vs. array; "one owner per org" today, shouldn't architecturally block multi-org-per-user later).
- `RequireAuth`/`PublicOnly` wrapper components gate authenticated vs. logged-out-only routes — same
  shape as this repo's existing `requireAdminKey` middleware pattern, just Supabase-session-based instead
  of header-key-based (see `CLAUDE-BUILD-BRIEF.md` §8's note on keeping new auth middleware in that same
  shape).
- Command palette (⌘K), notifications bell, theme toggle, usage-meter in the header — all reasonable
  phase-2 polish, not v1-blocking.

## 6. Suggested build order for the merchant `/app/*` frontend

1. `users`-to-`orgs` mapping table (schema decision from §5 first — everything else depends on it).
2. Supabase Auth wiring (login/signup/session middleware) — reuse the existing `requireAdminKey`-shaped
   middleware pattern, Supabase-session-based instead.
3. Onboarding wizard (§2.1) — the pitch depends on this feeling simple.
4. Agent config page (§2.2) — reuse `voice/agent-frame.ts` + this repo's `/dashboard/agents` code/API
   almost directly, just re-scoped to the session's own `orgId` instead of an org picker.
5. Call history + transcripts (§2.3) — mostly a filtered read against already `orgId`-scoped tables.
6. Analytics/KPIs (§2.4) — reuse the `/dashboard/analytics` endpoint/page the same way as #4, re-scoped.
7. Shopify connection/settings (§2.6).
8. Billing/usage (§2.5) — last, since it depends on the billing integration workstream landing first.

Everything in §3 beyond this six-page scope: revisit later, not part of v1.
