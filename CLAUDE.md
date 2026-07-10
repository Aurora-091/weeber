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
4. `DECISIONS.md` — every consequential decision, in order, with full reasoning (ADR-030 onward are
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
- `bun run start:railway` — direct `bun run src/server.ts`, no PM2 — this is how the backend runs in
  production on Railway (confirmed platform, ADR-034); Railway's container supervisor handles restarts.
- `cd packages/api && bun run typecheck` / `bun run test` and `cd packages/web && bun run typecheck` /
  `bun run build` — must all be clean before any PR. CI (`.github/workflows/ci.yml`) already enforces this;
  **branch protection on `main` is not yet enabled** — do this in GitHub repo settings before multiple
  people push here.
- `cd packages/openvent-compliance && bun run typecheck` / `bun run test` — the standalone compliance
  package; same bar applies, arguably higher (see "Compliance package" below).
- `bun test <path>` — run a single test file directly (all packages use plain `bun:test`, no separate
  runner/mocking library; tests live next to the code as `foo.test.ts`). Backend tests are in
  `packages/api/src/`. See `docs/testing.md` for the full convention (stubbing `fetch`, resetting
  module-level state between tests, etc.).
- `bun run lint` (repo root) — oxlint, zero warnings required.
- `cd packages/api && bun run db:push` — applies `src/database/schema.ts` changes to the live DB
  (Supabase Postgres, ADR-034 — the `pgTable` migration has landed; `DATABASE_URL` is the pooled
  Supabase connection string). Additive-only migrations — never rename or drop existing columns
  (repo-wide convention, see any ADR touching the schema for examples).

## Repo structure (top level)

```text
openvent/  (this repo)
├── CLAUDE.md                    # this file — read first
├── WEEBER-PLAN.md                # what's built, Phase 2 backlog, sized workstreams
├── CLAUDE-BUILD-BRIEF.md         # dashboard scope + file tree for packages/web/src/web additions
├── UI-DESIGN-BRIEF.md            # design system spec
├── DECISIONS.md                  # every ADR, in order (ADR-030+ are Weeber-specific)
├── docs/                         # base OpenVent docs (architecture, state-engine, api-reference,
│                                  # configuration, testing, security, dashboard) — still accurate for the
│                                  # underlying framework; Weeber-specific product docs are the 4 files above
├── .mcp.json                     # MCP servers for Claude Code (see below)
├── railway.json                  # backend hosting config (Railway confirmed — ADR-034)
├── vercel.json                   # frontend deploy config (Vercel serves the dashboard; Railway serves /api)
├── supabase/
│   ├── config.toml               # Storage + Auth + Edge Functions config
│   ├── migrations/                # KB document storage bucket, etc.
│   └── functions/                 # gdpr-redact-notify (stub, not yet wired to the redact route)
├── packages/
│   ├── api/                       # @weeber/api — the backend (ADR-036): Bun/Hono server, deployed to Railway
│   │   ├── src/index.ts            # the Hono app — exports AppType for the frontend's typed client
│   │   ├── src/server.ts           # Bun server entry — Twilio Media Stream WS, boot checks, sweeps
│   │   ├── src/database/schema.ts   # Drizzle schema — org-lite tables, agentTemplates, Shopify tables
│   │   ├── src/integrations/shopify/  # the weebersh contract implementation (routes, client, auth, idempotency)
│   │   ├── src/voice/               # call handling, workflows/scheduler, tools, compliance adapters
│   │   └── drizzle.config.ts        # db:* scripts live in this package
│   ├── web/                       # @weeber/web — the frontend (React dashboard), deployed to Vercel
│   │   ├── src/web/                 # see CLAUDE-BUILD-BRIEF.md §3 for the /dashboard + /app tree
│   │   └── components.json          # shadcn config
│   └── openvent-compliance/        # framework-agnostic compliance package — DNC/TCPA/HIPAA/GDPR, tested
│                                    # independently, dependency-free by design; Weeber-private (see below)
├── .github/workflows/ci.yml       # typecheck + test + build + lint on every push/PR to main
└── .env.example                   # full env var reference with inline comments
```

## The call pipeline (base OpenVent — read this before touching anything in `voice/`)

This is the one piece of architecture the Weeber-specific docs above assume you already know. Full detail
in `docs/architecture.md`, `docs/state-engine.md`, `docs/configuration.md`, `docs/api-reference.md`; the
shape of it:

```text
Inbound:  Caller -> Twilio number -> POST /api/voice/incoming (TwiML) -> wss connect
Outbound: POST /api/voice/calls/outbound -> compliance gates -> Twilio places call -> same TwiML/stream flow

Twilio Media Stream (bidirectional WS, base64 mu-law 8kHz audio frames)
  -> Deepgram Live STT (nova-3, buffered through reconnects)
  -> LLM Agent (AI Gateway or Groq, streamed, tool-calling) — src/api/voice/agent.ts, routes.ts, stream.ts
  -> TTS (ElevenLabs or Cartesia, mulaw/8000, no re-encoding)
  -> back to Twilio Media Stream

Barge-in: new speech detected while the agent is talking -> Twilio gets a "clear" event, in-flight LLM/TTS
aborts immediately.

On call end: disposition + Twilio status feed workflows/ (retry scheduling, DNC add, webhook firing) —
no manual step required.
```

Two things worth knowing before editing `voice/agent.ts` or anything that reads/writes call state:

- **State is not the transcript.** The agent calls the `captureField` tool the moment a caller states
  something durable (email, order ID, name); that gets persisted to `calls.capturedState` immediately and
  re-injected into the system prompt every turn as a "known facts" block — not re-derived from scrollback.
  Every integrations/tools file under `voice/` (`tools/`, `integrations/`) is wrapped in a shared
  resilience layer (`resilient-fetch.ts` — timeout, retry, per-integration circuit breaker) so a slow
  third-party API can't stall a live call turn.
- **`callerMemory` is separate from `capturedState`** — one row per phone number, persisted across calls
  (not just within one), merged in on `finalizeCall` and injected as a lower-confidence "from a previous
  call" block. Which number counts as "the human" flips by call direction (`fromNumber` inbound,
  `toNumber` outbound).

None of this is Weeber-specific — it's the base OpenVent framework the Weeber product logic (org scoping,
Shopify agents, compliance gates) is built on top of.

## Architecture summary

Full detail is in `CLAUDE-BUILD-BRIEF.md`; the short version:

- **Two dashboards, one app.** `/dashboard/*` (existing) is the internal admin panel — org/shop list, agent
  template catalog, billing oversight, compliance/DNC oversight, feature flags, merchant impersonation
  (**must be audit-logged, no exceptions** — see `CLAUDE-BUILD-BRIEF.md` §4). `/app/*` (new) is the
  merchant-facing surface — onboarding wizard, agent config, call history, analytics, billing, Shopify
  connection status. Both live in `packages/web`, not separate packages.
- **Frontend↔backend boundary rule (ADR-035/036 — the split is done):** the backend is `packages/api`
  (`@weeber/api`), the frontend is `packages/web` (`@weeber/web`). Frontend code never imports anything
  from `@weeber/api` except types (the `AppType` RPC type in `lib/api.ts`), and never calls global `fetch`
  with a hardcoded `/api/...` path — all HTTP goes through `src/web/lib/api.ts` (`api` typed client, or
  `apiFetch`/`apiUrl` for raw HTTP), which honors `VITE_API_BASE_URL`. Dependency direction is one-way:
  `web → api (types only) → compliance`. In single-deploy mode the api server serves `packages/web/dist`
  when it exists; on Railway it never does, and only `/api/*` + the Twilio WebSocket matter.
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
- **Compliance package** (`packages/openvent-compliance`) is standalone, dependency-free code (no Twilio/
  Bun/database coupling) kept to publish-quality standards even though it's Weeber-private now, not an
  external npm package — DNC, calling-window, HIPAA guardrail, GDPR retention/erasure, audit-trail export.
  Treat any change here with more care than average; it's the actual product differentiator, not incidental
  plumbing.

## Config surfaces that must stay in sync

- `packages/api/drizzle.config.ts` (`dialect: "postgresql"`, ADR-034) and
  `packages/api/src/database/schema.ts` — schema changes need `db:push` (or a generated migration) run
  against the real `DATABASE_URL` after editing.
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

`.mcp.json` wires up five MCP servers for whoever's driving Claude Code in this repo:

- **`shopify-dev-mcp`** (official, `@shopify/dev-mcp`) — live access to Shopify's Admin API/GraphQL schema
  docs. Same server `weebersh` uses; needs no credentials.
- **`supabase`** (official, `@supabase/mcp-server-supabase`) — needs `SUPABASE_PROJECT_REF` and
  `SUPABASE_ACCESS_TOKEN` set as real shell environment variables before starting Claude Code (the file uses
  `${VAR}` substitution — **never replace these with literal values in the committed file**).
- **`twilio`** (official, `@twilio-alpha/mcp`) — same pattern, needs `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`
  as shell env vars.
- **`railway`** (official, hosted HTTP MCP at `mcp.railway.com` — the URL is the bare host, no `/mcp`
  path) — no env var; authenticates via OAuth on first connect (tokens are short-lived, revocable from
  Railway account settings).
- **`vercel`** (official, hosted HTTP MCP at `mcp.vercel.com`) — no env var; authenticates via OAuth on
  first connect.

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
3. ~~Hosting platform~~ **RESOLVED (ADR-034): Railway for the backend, Vercel for the frontend.** Fly.io's
   HIPAA BAA argument deferred until a clinic-type vertical is actually near-term.
4. **Entry-condition branching ("trigger split," ADR-033):** config-driven-only, or visual-canvas-from-day-one
   (React Flow) — explicitly left open, ask before starting this workstream.
5. ~~Payment gateway~~ **RESOLVED (ADR-034): Razorpay first — GTM is India-based.** Dodo Payments is the
   planned addition when international expansion happens (a "when," not an "if"). Build the billing
   integration behind a thin gateway abstraction so Dodo lands later as an adapter; do not build the Dodo
   adapter now.
6. **Anything touching `packages/openvent-compliance`** — confirm the change with the user before merging,
   regardless of how small it looks. Correctness there matters more than usual.
7. **Real credentials of any kind** (Twilio, Supabase, Deepgram, Cartesia/ElevenLabs, LLM provider, GitHub
   tokens) — never hardcode, never invent placeholder-that-looks-real values. Ask the user to supply them
   through a secure channel when needed.
8. **Per-org Twilio sub-accounts, per-org DNC lists, full RBAC/multi-seat, per-org billing entities** — all
   explicitly deferred (`WEEBER-PLAN.md` Phase 2). If a task seems to require one of these, that's a signal
   to check whether the task is actually in scope yet, not to build the deferred thing as a side effect.

## Notes

- **This repo used to be OpenVent's open-source scaffolding; it now isn't one.** The unbuilt `packages/
  mobile`/`packages/desktop` shells, the public marketing landing page (`src/web/components/landing/`,
  `design.md`), and the OSS project files (LICENSE, NOTICE, TRADEMARK.md, README.md, ROADMAP.md,
  CHANGELOG.md, CODE_OF_CONDUCT.md, CONTRIBUTING.md, SECURITY.md, `brand/`, issue/PR templates) have all
  been removed — Weeber is a private startup, not an OSS project soliciting external contributors or
  publishing a marketing site under the OpenVent name. Don't recreate any of these unless explicitly asked;
  their absence is deliberate, not an oversight. `docs/` and the ADR history in `DECISIONS.md` were kept
  as-is since they document the underlying framework's design, not OpenVent's public-facing OSS identity.
- The root `/` route now redirects straight to `/dashboard` (`packages/web/src/web/app.tsx`) since there's
  no landing page to serve — update this once a real Weeber marketing site or `/app` onboarding entry point
  exists.
- `.theme-weeber` (see `UI-DESIGN-BRIEF.md`) is the only theme that should apply to Weeber product UI; there
  are no more competing `:root`/`.dark` landing-page tokens to accidentally reuse.
- `packages/openvent-compliance` is no longer framed as an externally-publishable npm package (no `license`/
  `keywords` fields, marked `private: true`) — it's Weeber-internal code, just held to a higher bar. If the
  business decides to open-source it again later, that's a deliberate call to revisit, not a default.
- `ADMIN_API_KEY`/`admin_keys` (internal ops auth) and the planned Supabase-Auth-based merchant login are two
  separate, intentionally non-unified auth systems for two different audiences — don't merge them.
