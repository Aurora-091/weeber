# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

This is **Weeber's backend** — a private fork of the open-source `OpenVent` voice-AI orchestration
framework (self-hosted, Bun/Hono/Drizzle/Twilio/Deepgram), extended into a multi-org-lite, Shopify-vertical
voice SaaS. It talks to a separate Shopify connector app, **weebersh**
(`github.com/Aurora-091/weebersh`) — that repo is the OAuth/webhook bridge; this repo is where the actual
call logic, scheduling, compliance, and business rules live. The wire contract between the two repos is
documented in `weebersh`'s `docs/contract.md` (v1.4 as of this writing) — this repo implements the backend
side of it (`packages/web/src/api/integrations/shopify/`).

**Read these documents in this order before making architectural decisions** — they are the actual spec,
not background reading:

1. `WEEBER-PLAN.md` — what's built, what's Phase 2/deferred, sized workstreams, assignable tasks.
2. `CLAUDE-BUILD-BRIEF.md` — admin panel + merchant dashboard scope, codebase structure, API conventions.
3. `UI-DESIGN-BRIEF.md` — the confirmed design system (Arc-like warm paper theme, tokens already implemented
   in `styles.css`'s `.theme-weeber`).
4. `DECISIONS.md` — every consequential decision, in order, with full reasoning (ADR-030 through ADR-033 are
   Weeber-specific; ADR-001 through ADR-029 are the base OpenVent project's history — still relevant for
   understanding *why* the underlying framework works the way it does).

If something looks like an odd choice and isn't explained by the doc you're reading, check `DECISIONS.md`
before assuming it's a mistake or before changing it.

## Commands

- `bun install` — install dependencies (monorepo, Bun workspaces + Turborepo).
- `cd packages/web && bun run dev` — Vite dev server. **Does not support live call audio** — the Twilio
  Media Stream WebSocket bridge only works under the real Bun runtime, not Vite's dev SSR module runner. Fine
  for UI/dashboard work; not fine for testing an actual phone call.
- `bun run start` (from repo root) — production server via PM2 (`ecosystem.config.cjs`) — required for
  testing live call audio locally.
- `bun run start:railway` — direct `bun run src/server.ts`, no PM2 — used for platform-supervised hosting
  (see "Hosting — not yet decided" below).
- `cd packages/web && bun run typecheck` / `bun run build` / `bun run test` — must all be clean before any
  PR. CI (`.github/workflows/ci.yml`) already enforces this; **branch protection on `main` is not yet
  enabled** — do this in GitHub repo settings before multiple people push here.
- `cd packages/openvent-compliance && bun run typecheck` / `bun run test` — the standalone compliance
  package; same bar applies, arguably higher (see "Compliance package" below).
- `bun run lint` (repo root) — oxlint, zero warnings required.
- `cd packages/web && bun run db:push` — applies `src/api/database/schema.ts` changes to the live DB (Turso/
  libSQL). Additive-only migrations — never rename or drop existing columns (repo-wide convention, see any
  ADR touching the schema for examples).

## Repo structure (top level)

```
openvent/  (this repo)
├── CLAUDE.md                    # this file — read first
├── WEEBER-PLAN.md                # what's built, Phase 2 backlog, sized workstreams
├── CLAUDE-BUILD-BRIEF.md         # dashboard scope + file tree for packages/web/src/web additions
├── UI-DESIGN-BRIEF.md            # design system spec
├── DECISIONS.md                  # every ADR, in order (ADR-030+ are Weeber-specific)
├── ROADMAP.md, CHANGELOG.md      # inherited from base OpenVent — still accurate for the base framework
├── .mcp.json                     # MCP servers for Claude Code (see below)
├── railway.json                  # backend hosting config — NOT FINALIZED, see STOP AND ASK #3
├── supabase/
│   ├── config.toml               # Storage + Auth + Edge Functions config
│   ├── migrations/                # KB document storage bucket, etc.
│   └── functions/                 # gdpr-redact-notify (stub, not yet wired to the redact route)
├── packages/
│   ├── web/                       # the actual app — Bun/Hono API + React dashboard, single deploy unit
│   │   ├── src/api/                # backend — voice pipeline, Shopify integration, database
│   │   │   ├── database/schema.ts   # Drizzle schema — org-lite tables, agentTemplates, Shopify tables
│   │   │   ├── integrations/shopify/  # the weebersh contract implementation (routes, client, auth, idempotency)
│   │   │   └── voice/                # call handling, workflows/scheduler, tools, compliance adapters
│   │   ├── src/web/                 # frontend — see CLAUDE-BUILD-BRIEF.md §3 for the /dashboard + /app tree
│   │   └── components.json          # shadcn config
│   ├── openvent-compliance/        # standalone compliance package — DNC/TCPA/HIPAA/GDPR, tested independently
│   ├── mobile/, desktop/          # unbuilt scaffold shells, not part of Weeber's product surface (see Notes)
├── .github/workflows/ci.yml       # typecheck + test + build + lint on every push/PR to main
└── .env.example                   # full env var reference with inline comments
```

## Architecture summary

Full detail is in `CLAUDE-BUILD-BRIEF.md`; the short version:

- **Two dashboards, one app.** `/dashboard/*` (existing) is the internal admin panel — org/shop list, agent
  template catalog, billing oversight, compliance/DNC oversight, feature flags, merchant impersonation
  (**must be audit-logged, no exceptions** — see `CLAUDE-BUILD-BRIEF.md` §4). `/app/*` (new) is the
  merchant-facing surface — onboarding wizard, agent config, call history, analytics, billing, Shopify
  connection status. Both live in `packages/web`, not separate packages.
- **Org-lite, not full multi-tenant** (ADR-030/031) — `orgId` scopes data (`calls`, `scheduledCalls`,
  `shopifyContacts`), but there's no per-org Twilio sub-account, no per-org DNC list, and no per-org
  billing entity yet. Don't build those without checking `WEEBER-PLAN.md`'s Phase 2 list first — they're
  deliberately deferred, not forgotten.
- **Vertical-agnostic seam:** `orgs.vertical` + `agentTemplates` table (ADR-031) — Shopify is the only
  vertical with real agents today, but new verticals (clinic, hotel) should add rows here, not require a
  schema migration or a new code path per vertical.
- **The 3 Shopify agents** (cart-recovery, cod-confirmation, feedback) are plain `scheduledCalls` rows — no
  bespoke scheduling infrastructure. The existing DNC + TCPA-calling-window compliance gate
  (`voice/workflows/scheduler.ts`) already runs for every one of them, same as any other call.
- **Compliance package** (`packages/openvent-compliance`) is standalone, published-package-quality code —
  DNC, calling-window, HIPAA guardrail, GDPR retention/erasure, audit-trail export. Treat any change here
  with more care than average; it's the actual product differentiator, not incidental plumbing.

## Config surfaces that must stay in sync

- `packages/web/drizzle.config.ts` (`dialect: "turso"`) and `src/api/database/schema.ts` — schema changes
  need `db:push` run against the real `DATABASE_URL` after editing.
- `weebersh`'s `docs/contract.md` and this repo's understanding of it — if you change a Shopify webhook
  payload shape or add an endpoint, the contract version must bump in **both** repos, not just this one.
- `packages/web/components.json` — shadcn config; new components should be added via `bunx shadcn@latest add
  <component>`, not hand-copied, to stay consistent with this.
- `supabase/config.toml` + `supabase/migrations/` — Storage/Auth/Edge Functions config. Run `supabase link`
  then `supabase db push` after creating the real Supabase project (not yet created — see below).

## Environment variables

See `.env.example` for the full list with inline comments. Notably: `WEEBER_INTERNAL_SECRET` /
`WEEBER_CALLBACK_SECRET` (shared with weebersh, distinct secrets per direction, rotate independently),
`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`, and the `SHOPIFY_*` playbook-tuning vars (delay/attempt counts
per agent).

## MCP servers

`.mcp.json` wires up three MCP servers for whoever's driving Claude Code in this repo:

- **`shopify-dev-mcp`** (official, `@shopify/dev-mcp`) — live access to Shopify's Admin API/GraphQL schema
  docs. Same server `weebersh` uses; needs no credentials.
- **`supabase`** (official, `@supabase/mcp-server-supabase`) — needs `SUPABASE_PROJECT_REF` and
  `SUPABASE_ACCESS_TOKEN` set as real shell environment variables before starting Claude Code (the file uses
  `${VAR}` substitution — **never replace these with literal values in the committed file**).
- **`twilio`** (official, `@twilio-alpha/mcp`) — same pattern, needs `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`
  as shell env vars.

Hosting-platform MCP (Railway's or Fly's) intentionally isn't wired up yet — see "STOP AND ASK" item 3
below, add whichever MCP matches once that decision is made.

## STOP AND ASK — do not decide these unilaterally

The user will supply some of this directly; for the rest, pause and ask rather than inventing a plausible
answer. This list exists because several of these look like implementation details but are actually
unresolved product/business decisions:

1. **The 3 agents' actual persona/system-prompt text.** Not written anywhere in this repo on purpose — the
   user is providing this directly. If you reach the point of wiring up `AGENT_PERSONAS` (or wherever the
   config-storage migration lands) and the prompt text isn't provided yet, ask for it. Do not write
   plausible-sounding persona copy yourself.
2. **Final brand assets** (logo, exact hex values beyond `UI-DESIGN-BRIEF.md`'s starting proposal) — that
   proposal is explicitly a placeholder, not a commitment.
3. **Hosting platform: Railway vs. Fly.io is not finalized.** `railway.json` exists in this repo from an
   earlier round; Fly.io was recommended in a later discussion for its no-spend-minimum HIPAA BAA and
   multi-region story, but no final decision was confirmed. Ask before provisioning either.
4. **Entry-condition branching ("trigger split," ADR-033):** config-driven-only, or visual-canvas-from-day-one
   (React Flow) — explicitly left open, ask before starting this workstream.
5. **Payment gateway: Dodo Payments vs. Razorpay** — not finalized (Razorpay is India-first with weak
   international support; Dodo is a Merchant-of-Record with better cross-border coverage) — ask before
   building the billing integration.
6. **Anything touching `packages/openvent-compliance`** — confirm the change with the user before merging,
   regardless of how small it looks. Correctness there matters more than usual.
7. **Real credentials of any kind** (Twilio, Supabase, Deepgram, Cartesia/ElevenLabs, LLM provider, GitHub
   tokens) — never hardcode, never invent placeholder-that-looks-real values. Ask the user to supply them
   through a secure channel when needed.
8. **Per-org Twilio sub-accounts, per-org DNC lists, full RBAC/multi-seat, per-org billing entities** — all
   explicitly deferred (`WEEBER-PLAN.md` Phase 2). If a task seems to require one of these, that's a signal
   to check whether the task is actually in scope yet, not to build the deferred thing as a side effect.

## Notes

- `packages/mobile` and `packages/desktop` are unbuilt scaffold shells inherited from the base OpenVent
  template ("not voice-specific yet," per its own `docs/architecture.md`) — not part of Weeber's product
  surface. Don't build features into them unless explicitly asked.
- The public OpenVent landing page (`src/web/components/landing/`) and its `:root`/`.dark` CSS tokens belong
  to the unrelated open-source marketing site — don't reuse or modify them for Weeber product UI; use
  `.theme-weeber` instead (see `UI-DESIGN-BRIEF.md`).
- `ADMIN_API_KEY`/`admin_keys` (internal ops auth) and the planned Supabase-Auth-based merchant login are two
  separate, intentionally non-unified auth systems for two different audiences — don't merge them.
