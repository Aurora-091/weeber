---
adr: 35
title: "Backend separation: prepare the seam now, split later"
date: 2026-07-10
status: Accepted
---

## ADR-035 — Backend separation: prepare the seam now, split later

**Date:** 2026-07-10

**Context:** Explicit user direction: separating the backend into its own unit will pay off in the future
but not now — start preparing for it. Today `packages/web` is one package holding both the Hono API
(`src/api`) and the React dashboard (`src/web`), served by one Bun process in the single-deploy story but
already deployed as two artifacts in production (Railway runs the full server; Vercel serves only the
static frontend build). An audit of the actual coupling found it small: exactly one frontend→backend
import, and it's type-only (`AppType` for the Hono RPC client — erased at build time, survives any split
as a package-name change); the real coupling was that every API call assumed same-origin (`hc("/")` plus
three raw `fetch("/api/...")` call sites).

**Decision:** Do not split into separate packages/repos yet — build and enforce the seam so the eventual
split is mechanical:

1. **`src/web/lib/api.ts` is the single point of contact with the backend's location.** It reads
   `VITE_API_BASE_URL` (build-time, Vite): unset = same-origin (single-deploy, today's default), set = all
   API traffic targets that origin. It exports the typed RPC client (`api`), plus `apiFetch`/`apiUrl` for
   the few raw-HTTP call sites (status checks, text/blob downloads). **Boundary rule from now on: frontend
   code never calls global `fetch` with a hardcoded `/api/...` path, and never imports anything from
   `src/api` except types.** All three existing raw call sites were migrated.
2. **CORS allowlist, env-gated:** `CORS_ALLOWED_ORIGINS` (comma-separated) on the backend. Unset preserves
   the previous reflect-any-origin behavior (acceptable while auth is header-based, no cookies); it must be
   set to the real dashboard origin(s) before the Vercel frontend goes live on a real domain.
3. **The future split shape**, when it earns its cost (own release cadence, separate teams, or backend
   reuse by a non-dashboard client): `src/api` moves to a `packages/api` workspace package (or its own
   repo), the frontend's `AppType` import becomes a package import, and nothing else changes — that's the
   point of the seam. Not scheduled; revisit when one of those triggers is actually true.

Also this round: the `railway` MCP entry corrected to Railway's hosted HTTP MCP (`mcp.railway.com/mcp`,
OAuth on connect — same pattern as Vercel's), replacing the stdio/`RAILWAY_API_TOKEN` wiring from earlier
in the day.

**Consequences:** Workstream E's code half (WEEBER-PLAN) is done ahead of the Vercel deploy — what remains
is setting `VITE_API_BASE_URL` in Vercel's build env and `CORS_ALLOWED_ORIGINS` on Railway once real URLs
exist. `RAILWAY_API_TOKEN` is no longer needed for MCP use.
