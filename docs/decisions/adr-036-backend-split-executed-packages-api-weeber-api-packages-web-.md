---
adr: 36
title: "Backend split executed: `packages/api` (@weeber/api) + `packages/web` (@weeber/web)"
date: 2026-07-10
status: Accepted
---

## ADR-036 — Backend split executed: `packages/api` (@weeber/api) + `packages/web` (@weeber/web)

**Date:** 2026-07-10

**Context:** ADR-035 built the seam and deferred the physical split until a trigger arrived. The user then
decided to do it immediately — "both times we have to spend time, so go for it now" — reasoning that the
mechanical cost is the same today as later, and today the seam is fresh. Fair: the split was several hours
either way, and doing it with zero production traffic removes all deploy risk.

**Decision:** `packages/web/src/api` + `src/server.ts` + `drizzle.config.ts` moved (via `git mv`, history
preserved) into a new **`packages/api`** workspace package, `@weeber/api`:

- **`@weeber/api`** owns everything server-side: the Hono app (`src/index.ts`, exports `AppType`), the Bun
  server entry (`src/server.ts` — Twilio Media Stream WebSocket, boot checks, sweeps), the Drizzle schema +
  config, all voice/integration/database code, and all backend tests (`bun test src/`). Backend deps
  (drizzle, twilio, ai/groq, ioredis, ws, libsql, @openvent/compliance) moved here.
- **`@weeber/web`** (renamed from `@template/web`) is frontend-only: React dashboard, Vite build. It keeps
  `hono` (for `hono/client`) and gains `"@weeber/api": "workspace:*"` — used exclusively for the type-only
  `AppType` import in `lib/api.ts`. The package-level `exports` map (which used to export the API from the
  web package — the tell that the boundary was inverted) moved to `@weeber/api` where it belongs.
- **Single-deploy still works:** `@weeber/api`'s server serves the frontend's built assets from the sibling
  package (`../../web/dist` relative to `src/`) when they exist — `bun run start` (PM2) behaves exactly as
  before. In the split deploy the dist simply never exists on Railway and only `/api/*` + the WebSocket
  matter there.
- **Vite dev `/api` proxying preserved:** `hono-dev-plugin` now loads the Hono app cross-package via
  `/@fs/`-prefixed `ssrLoadModule` — dashboard dev experience unchanged.
- **Config/CI updates:** `ecosystem.config.cjs` + root `start:railway` point at `packages/api/src/server.ts`;
  CI typechecks all three packages and runs the api + compliance test suites; `db:*` scripts live in
  `packages/api` now.

**Consequences:** The repo now has three packages with one-directional dependencies:
`web → api (types only) → compliance`. Backend work and frontend work no longer share a `package.json`,
which is the future-proofing the user asked for — a separate backend repo, if ever wanted, is now a
`git filter-repo` away rather than a refactor. Costs accepted: `bun install` must be re-run (lockfile
changes), and anyone's muscle memory of `cd packages/web && bun run test` must become `packages/api`.
`docs/architecture.md`'s "where things live" tree predates this and reads `packages/web/src/api` — the
`docs/` folder is deliberately unmodified (user direction), so treat `CLAUDE.md`'s tree as current.
