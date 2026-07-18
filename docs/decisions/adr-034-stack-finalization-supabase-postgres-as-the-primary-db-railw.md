---
adr: 34
title: "Stack finalization: Supabase Postgres as the primary DB, Railway + Vercel confirmed, Razorpay-first billing (India GTM)"
date: 2026-07-10
status: Accepted
---

## ADR-034 — Stack finalization: Supabase Postgres as the primary DB, Railway + Vercel confirmed, Razorpay-first billing (India GTM)

**Date:** 2026-07-10

**Context:** Three items from `CLAUDE.md`'s STOP-AND-ASK gate list (hosting platform, payment gateway) plus
the Turso-vs-Postgres question raised in the post-cleanup stack review were resolved by explicit user
direction in one round. The stack review's core argument on the database: ADR-030 kept Turso/libSQL because
migrating had "zero functional benefit right now" — true for the MVP fork, but Weeber is now a startup whose
Phase 2 roadmap (per-org DNC lists, per-org billing entities, RBAC) is exactly the relational multi-tenant
modeling Postgres is built for, Supabase is already in the stack for Auth/Storage/Functions (so this
*removes* a database rather than adding one), and Postgres row-level security can enforce org isolation at
the database layer instead of relying on `WHERE orgId = ?` discipline in every query. Same asymmetric-cost
logic ADR-030 itself used for `orgId` scoping: cheap before real merchant data exists, expensive to
retrofit after.

**Decision:**

1. **Supabase Postgres is the primary relational DB, from the start — supersedes ADR-030's "core DB stays
   on Turso" call.** The full Drizzle schema migrates `sqliteTable` → `pgTable` (`dialect: "turso"` →
   `"postgresql"` in `drizzle.config.ts`), and Supabase is used to its full extent: Postgres (+ RLS for
   org scoping), Auth (merchant login, per ADR-031), Storage (KB documents), Edge Functions, and whatever
   else earns its place (Realtime for live call status on the dashboard is a natural candidate, not
   committed). No data migration burden exists yet — no production merchant data is in Turso — which is
   precisely why now. **Blocked on:** the Supabase project itself does not exist yet; create it first, then
   the schema migration is a normal workstream (sized in `WEEBER-PLAN.md`).
2. **Hosting: Railway for the backend, Vercel for the frontend — resolves STOP-AND-ASK #3.** Fly.io's HIPAA
   BAA argument is moot for now: first vertical is Shopify (India GTM), not clinics. `railway.json` stands.
   Both platforms' official MCP servers are wired into `.mcp.json` (`railway` via `@railway/mcp-server` +
   `RAILWAY_API_TOKEN` env var; `vercel` via the hosted HTTP MCP at `mcp.vercel.com`, OAuth at connect
   time). `vercel.json` — deleted in error during the OSS cleanup on the assumption it existed only for the
   OpenVent marketing site — is restored: it is the production deploy config for the dashboard frontend.
3. **Payments: Razorpay first — resolves STOP-AND-ASK #5, with a sequencing twist.** First GTM is
   India-based, which is exactly the market Razorpay is strongest in; Dodo Payments (Merchant-of-Record,
   cross-border tax handling) is the planned addition **when** international expansion happens — a "when,"
   not an "if," per explicit direction ("we are going global too"). Consequence for the billing
   integration whenever it's built: put a thin gateway abstraction in front (same provider-seam pattern as
   LLM/TTS), so adding Dodo later is an adapter, not a rework. Do not build the Dodo adapter now.

**Consequences:** The Turso → Supabase Postgres migration becomes the top structural workstream and should
land **before** merchant-facing features build up more schema surface on the SQLite dialect. `db:push`
against Turso remains the working reality until that lands — every doc reference to Turso/libSQL is
accurate-but-terminal. The `@tursodatabase/api` and `@libsql/client` dependencies go away with the
migration. Env surface changes: `DATABASE_URL` will point at Supabase Postgres (pooled connection string),
and `RAILWAY_API_TOKEN` joins the shell-env list for MCP use. India-first GTM also means the TCPA
calling-window/DNC model (US-centric, NANP area codes) needs an India-aware compliance review — TRAI's
DND registry and calling-hour norms are a different regime; flagged as a required follow-up in
`WEEBER-PLAN.md`, not silently assumed equivalent.
