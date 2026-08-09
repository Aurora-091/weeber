# CLAUDE.md

**Read [`AGENTS.md`](./AGENTS.md) first — it is the canonical entry point for every AI agent in this
repo** (Claude Code, Antigravity, Bolt, Cursor, this assistant). It gives you the 30-second
orientation, the read-order, the rules that get violated most, the commands you'll actually run, and a
map of the repo's knowledge. Everything that used to live at the top of this file now lives there, so
there's one source of truth instead of two that drift apart.

This file keeps only the bits that are **specific to Claude Code** and don't belong in the shared
`AGENTS.md`.

## The brain, in one line

Read the brain before deciding anything: [`docs/brain/project-brief.md`](./docs/brain/project-brief.md)
(what Weeber is) → [`docs/brain/active-context.md`](./docs/brain/active-context.md) (what's happening
now) → [`docs/brain/00-index.md`](./docs/brain/00-index.md) (task → which files to open). Decisions live
one-per-file in [`docs/decisions/`](./docs/decisions/README.md); what-shipped-when lives by month in
[`docs/changelog/`](./docs/changelog/README.md).

## MCP servers (Claude Code only)

`.mcp.json` wires up five MCP servers for whoever's driving Claude Code in this repo:

- **`shopify-dev-mcp`** (official, `@shopify/dev-mcp`) — live access to Shopify's Admin API/GraphQL
  schema docs. Same server `weebersh` uses; needs no credentials.
- **`supabase`** (official, hosted HTTP MCP at `mcp.supabase.com/mcp`, scoped to the Weeber project via
  `?project_ref=`) — no env vars or access token; authenticates via OAuth on first connect (run `/mcp`,
  pick `supabase`, choose Authenticate). The project ref in the URL is public (it's in the served
  frontend bundle anyway), not a secret.
- **`twilio`** (official, `@twilio-alpha/mcp`) — same pattern, needs `TWILIO_ACCOUNT_SID` /
  `TWILIO_AUTH_TOKEN` as shell env vars.
- **`railway`** (official, hosted HTTP MCP at `mcp.railway.com` — the URL is the bare host, no `/mcp`
  path) — no env var; authenticates via OAuth on first connect (tokens are short-lived, revocable from
  Railway account settings).
- **`vercel`** (official, hosted HTTP MCP at `mcp.vercel.com`) — no env var; authenticates via OAuth on
  first connect.

## Notes specific to driving Claude Code here

- Live call audio only works under the real Bun runtime (`bun run start`), never Vite's dev server —
  the Twilio Media Stream WebSocket bridge doesn't exist under Vite's SSR module runner. Fine for
  UI/dashboard work; not fine for testing an actual phone call.
- Before any PR: `packages/api` typecheck + test, `packages/web` typecheck + build, repo-root
  `bun run lint`, and the three repo-root gates `bun run knip:gate` / `bun run design:guard` /
  `bun run contrast:gate` must all be clean (CI enforces all of them across eleven jobs plus a
  `ci-success` aggregate). Branch protection on `main` is not yet enabled.
- `knip:gate` and `design:guard` are **ratchets**: they compare against a committed baseline and fail
  only when a count increases, so a red one means you added the finding. Do not widen
  `tools/dead-code/knip-baseline.json` or `tools/ui-guard/design-budget.json` to get green — that edit
  exists to be argued about in review. See ADR-090 for why reachability analysis is a separate check
  from the test suite: a unit test imports a symbol directly, so dead exports look used, and eight of
  ADRs 073–088 shipped that way.
- `packages/weeber-compliance` changes are STOP-AND-ASK — see the gate list in
  [`docs/brain/project-brief.md`](./docs/brain/project-brief.md).
