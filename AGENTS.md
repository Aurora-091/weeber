# AGENTS.md — Weeber agent brain (start here)

> **This is the canonical entry point for any AI agent working in this repo** — Claude Code,
> Antigravity, Bolt, Cursor, or anything else. `CLAUDE.md` now points here. Read this file top to
> bottom once; it's a *map*, not the whole story — it tells you which file to open for what, and in
> what order, so you don't have to load 170KB of history to make one change.

## 30-second orientation

Weeber is a **private, multi-vertical voice-AI SaaS** — a fork of the open-source `OpenVent`
orchestration framework (Bun / Hono / Drizzle / Twilio / Deepgram), extended into an org-scoped
product with per-vertical agents. Ecommerce (Shopify first) is the launch vertical; clinic, insurance,
and hotel verticals are on the board. It pairs with a separate Shopify OAuth bridge repo,
[`weebersh`](https://github.com/Aurora-091/weebersh). This repo holds the call logic, scheduling,
compliance, and business rules.

- **Backend:** `packages/api` (`@weeber/api`) — Bun/Hono, deployed to **Railway** (Pro, Singapore).
- **Frontend:** `packages/web` (`@weeber/web`) — React/Vite dashboard, deployed to **Vercel** (Pro).
- **DB:** **Supabase** Postgres (pooled, port 6543) — auth + `pgvector` KB, ADR-034.
- **Compliance:** `packages/openvent-compliance` — standalone, dependency-free, the real moat.

Pre-launch. ~10 real calls all-time. No paying customers yet. Treat traction docs accordingly.

## Read order — do this before making decisions

Don't skim everything. Read the **brain** (fast, always current), then dive only into what your task
touches via the routing table below.

1. **[`docs/brain/project-brief.md`](docs/brain/project-brief.md)** — what Weeber is, the
   non-negotiables, the glossary. Read once.
2. **[`docs/brain/active-context.md`](docs/brain/active-context.md)** — **what's being worked on right
   now**, last state, next step. Read every session. Update it when you finish meaningful work.
3. **[`docs/brain/progress.md`](docs/brain/progress.md)** — done / in-progress / next / known issues at
   a glance.
4. **[`docs/brain/00-index.md`](docs/brain/00-index.md)** — the routing table: *"working on X → read
   Y, Z."* Use this instead of guessing which doc is relevant.

Then, only as your task needs it: `WEEBER-PLAN.md` (phase roadmap), `architecture/README.md` (how the
code is laid out), `docs/decisions/` (the *why* — one file per ADR), `docs/reference/` (how it works
today).

## The rules that get violated most (read these)

1. **Check the ADR before "fixing" an odd choice.** If something looks wrong and the doc you're in
   doesn't explain it, search [`docs/decisions/`](docs/decisions/README.md) — most surprises are
   deliberate, documented decisions. Changing one without reading its ADR is how regressions happen.
2. **ADR vs changelog — put the record in the right place.** Did the change require picking between two
   real alternatives (architecture, compliance, data-model semantics, user-visible behavior)? → it's an
   **ADR** in `docs/decisions/` (new `adr-NNN-slug.md` + a row in the index; never rewrite an old ADR,
   supersede it). Routine feature work following an already-decided pattern (new table/column, new
   endpoint param, wiring)? → a dated entry in the current month's `docs/changelog/` file.
3. **Additive-only migrations.** Never rename or drop an existing DB column. `schema.ts` changes need
   `db:push` against the real `DATABASE_URL`.
4. **Frontend never imports backend runtime** — only the `AppType` RPC type. All HTTP goes through
   `packages/web/src/web/lib/api.ts` (honors `VITE_API_BASE_URL`), never a hardcoded `fetch("/api/...")`.
   Dependency direction is one-way: `web → api (types only) → compliance`.
5. **Anything touching `packages/openvent-compliance` is STOP-AND-ASK.** It's the product differentiator;
   correctness matters more than speed. Confirm with the user before merging, however small.
6. **Never invent credentials.** Twilio, Supabase, Deepgram, Cartesia/ElevenLabs, LLM, GitHub tokens —
   ask the user through a secure channel; never hardcode or use plausible-looking placeholders.
7. **Vertical-agnostic by default.** New verticals add rows to `agentTemplates` + use `orgs.vertical`;
   they don't get a bespoke code path or schema migration. Same for ecommerce platforms beyond Shopify
   (WooCommerce/BigCommerce/Dukaan are coming) — build platform-agnostic where feasible.

See the full STOP-AND-ASK gate list in [`docs/brain/project-brief.md`](docs/brain/project-brief.md).

## Commands (the ones you'll actually run)

```bash
bun install                              # monorepo, Bun workspaces + Turborepo
cd packages/web && bun run dev           # Vite dev server — UI only, NO live call audio
bun run start                            # repo root, PM2 — required to test real call audio locally
bun run start:railway                    # how production runs (drizzle migrate + bun server.ts)

cd packages/api && bun run typecheck && bun run test    # must be clean before any PR
cd packages/web && bun run typecheck && bun run build   # must be clean before any PR
bun run lint                             # oxlint, zero warnings
cd packages/api && bun run db:push       # apply schema.ts to the live DB (additive-only)
```

Live call audio only works under the real Bun runtime (Twilio Media Stream WS), never under Vite's dev
server. CI enforces typecheck + test + build + lint + e2e on every push to `main`.

**How testing works here — read [`docs/reference/testing.md`](docs/reference/testing.md) before writing or
running tests.** Non-obvious rules that live there: always `bun run test` (never bare `bun test` — the
`--isolate` gotcha, ADR-056); install deps first or a green run may be a false green; tests are colocated
(`foo.ts` → `foo.test.ts`, no `testing/` folder); web component tests use happy-dom; coverage is the
opt-in `bun run test:coverage`; and the Playwright landing-page E2E is `cd packages/web && bun run test:e2e`.

## Map of the repo's knowledge

| You want… | Open |
|---|---|
| What Weeber is, glossary, non-negotiables | `docs/brain/project-brief.md` |
| What's happening right now | `docs/brain/active-context.md` |
| Done / next / known issues | `docs/brain/progress.md` |
| "Which doc for task X?" | `docs/brain/00-index.md` |
| The phase roadmap (built vs open) | `WEEBER-PLAN.md` |
| How the code is laid out + call pipeline | `architecture/README.md` + `architecture/*.md` |
| Why a decision was made | `docs/decisions/README.md` → the specific ADR |
| What shipped when | `docs/changelog/README.md` → the month |
| How something works today (evergreen) | `docs/reference/` |
| Compliance / voice-quality / product-strategy deep dives | `docs/{compliance,voice-quality,product-strategy}/` |
| Design system | `UI-DESIGN-BRIEF.md` |
| Env vars | `.env.example` (inline-commented) |

## Keeping the brain alive (this is the whole point)

A stale brain is worse than none — an agent will confidently act on wrong info. When you finish
meaningful work:

- Update **`docs/brain/active-context.md`** (current focus / next step) — every session.
- Move completed items in **`docs/brain/progress.md`**.
- Log the change: an **ADR** (`docs/decisions/`) if it was a real decision, else a dated
  **changelog** entry (`docs/changelog/`).
- Never rewrite a shipped ADR — supersede it with a new one that says so.
