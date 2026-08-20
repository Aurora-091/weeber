# Dashboard

The operator (admin) console at `/dashboard`, gated behind an admin key — either your `ADMIN_API_KEY`
env var, or a labeled key created from Settings (entered once per browser session, never sent anywhere
but your own server; see [`docs/decisions/`](../decisions/README.md) ADR-025 for the labeled-key model).

Paths below are written as `/dashboard/*`, but nothing hardcodes that prefix: every route goes through
`adminPath()` (`packages/web/src/web/lib/route-base.ts`), so a dedicated admin build serves the same
pages at the domain root. Pages live in `packages/web/src/web/pages/dashboard/` and are backed by
`voice/admin-routes.ts` and `voice/workflows/admin-routes.ts` — see [api-reference.md](./api-reference.md).

## Calls and compliance

| Page | Path | What it does |
|---|---|---|
| Calls | `/dashboard` | Live/completed calls, auto-refreshing, with captured-fact counts |
| Call detail | `/dashboard/calls/:id` | Transcript, tool-call log, recording, captured-state panel ([state engine](./state-engine.md)), and the latency breakdown (STT connect, LLM time-to-first-token, TTS first byte — "not recorded" rather than a false `0ms`) |
| Do Not Call | `/dashboard/dnc` | Add/remove DNC entries |
| Audit | `/dashboard/audit` | Compliance audit trail per call or per phone number, exportable as text or JSON |
| Compliance | `/dashboard/compliance` | Guardrail events, call-health classifications, blocked calls, consent records and summary |

## Agents and workflows

| Page | Path | What it does |
|---|---|---|
| Agents | `/dashboard/agents` | The agent "frame" per org+template: identity (name, greeting/closing, tone), voice (provider + voice ID with live preview), LLM (provider + model), enabled tools, guardrail strictness. Schema in `voice/agent-frame.ts` |
| Templates | `/dashboard/templates` | Create/edit agent templates and grant them to orgs |
| Workflows | `/dashboard/workflows` | Workflow template list |
| Workflow editor | `/dashboard/workflows/:id` | React Flow canvas for one workflow template (`components/canvas/`) |
| Workflow runs | `/dashboard/workflow-runs` | Run history and per-run detail |

## Tenancy and platform ops

| Page | Path | What it does |
|---|---|---|
| Orgs | `/dashboard/orgs` | Every org, its telephony state, subaccount/number provisioning, BYO carrier credentials |
| Users | `/dashboard/users` | Platform users |
| Billing | `/dashboard/billing` | Plan/usage rollup across orgs |
| Flags | `/dashboard/flags` | Feature flags (create, update, delete) |
| Logs | `/dashboard/logs` | Platform log feed |
| Settings | `/dashboard/settings` | Labeled admin keys — generate (shown once), see created/last-used timestamps, revoke individually, without rotating `ADMIN_API_KEY` for everyone. Plus platform settings |
| Admin login | `/dashboard/admin-login` | Admin session sign-in |

## Growth

| Page | Path | What it does |
|---|---|---|
| Analytics | `/dashboard/analytics` | Org-scoped call volume, disposition breakdown, latency averages, tool usage, guardrail event counts over a date range. Aggregated off the existing tables — no rollup/warehouse layer |
| Revenue analytics | `/dashboard/revenue-analytics` | Revenue rollups |
| Marketing analytics | `/dashboard/marketing-analytics` | Funnel/marketing metrics |
| Waitlist | `/dashboard/waitlist` | Waitlist signups |
| Broadcasts | `/dashboard/broadcasts` | Compose and send broadcasts |
| Support | `/dashboard/support` | Support tickets and threaded replies |

## Scope

This console is for the operator, not for customers. The org picker on the Agents/Analytics pages is a
plain client-side dropdown, not an access-scoping mechanism — an admin key sees every org's data.

The customer-facing, per-org-scoped app (Supabase Auth, `/app/*`, pages in
`packages/web/src/web/pages/app/`) is a separate surface and has been live since 2026-07-12 — see
`architecture/user-flow.md` for its page flow. Its original pre-build specs (`CLAUDE-BUILD-BRIEF.md`,
`USER-APP-PAGE-MAP.md`) are archived in [`docs/archive/`](../archive/README.md), superseded by the real build.
