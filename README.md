# Weeber

Weeber is a multi-tenant, vertical voice-AI SaaS (Shopify/ecommerce, clinic, insurance) — a Bun/Hono/Drizzle
backend, a React/Vite frontend, and a provider-abstracted voice pipeline (Twilio/Plivo/Exotel +
Deepgram/Sarvam + ElevenLabs/Cartesia). See `CLAUDE.md` for the fuller "what this repo is" description.

**New to this repo? Read in this order:**

1. [`architecture/README.md`](./architecture/README.md) — how a call actually flows end to end, and how
   the codebase (`packages/api`, `packages/web`, `packages/weeber-compliance`, ...) is laid out. Start here.
2. [`docs/reference/getting-started.md`](./docs/reference/getting-started.md) — local setup, running the stack.
3. [`docs/reference/configuration.md`](./docs/reference/configuration.md) — env vars, per-number config, workflows.
4. [`CLAUDE.md`](./CLAUDE.md) — repo conventions, commands, and things that trip people up (this is the
   file written for AI coding agents, but it's the densest single "how to work in this repo" doc there is).

## Where things live

| Folder | What's in it |
|---|---|
| [`architecture/`](./architecture/) | Codebase map + call-flow diagrams. Read this first, not `docs/`. |
| [`docs/`](./docs/) | Everything else — operational reference (`docs/reference/`), compliance plans, voice-quality/latency research, product-strategy/GTM research, insurance-vertical planning, Workflow Canvas history, per-agent prompts (`docs/agent-prompts/`), and an `archive/` of superseded docs. See [`docs/README.md`](./docs/README.md) for the full index. |
| [`audit/`](./audit/) | Dated, point-in-time code audits — snapshots of what the codebase actually does, not plans. See [`audit/README.md`](./audit/README.md). |
| [`packages/`](./packages/) | The actual code: `api` (backend), `web` (frontend), `weeber-compliance` (standalone compliance engine). |
| [`docs/decisions/`](./docs/decisions/) | The architecture decision log (ADRs) — why things are the way they are, including reversed ones. Start at [`docs/decisions/README.md`](./docs/decisions/README.md); root [`DECISIONS.md`](./DECISIONS.md) is a stub pointing here since the 2026-07-18 split. The single most useful place for "why does this work like this." |
| [`docs/changelog/`](./docs/changelog/) | What shipped, when — one file per month, index at [`docs/changelog/README.md`](./docs/changelog/README.md). Root [`changelog.md`](./changelog.md) is a stub pointing here. |
| [`tools/`](./tools/) | The CI ratchets. `tools/dead-code/` is the knip reachability gate (`bun run knip:gate`, ADR-090); `tools/ui-guard/` is the design-drift + contrast gate. Both compare against a committed baseline and fail only when a count goes up — so a red one means the change under review added the finding. |
| [`WEEBER-PLAN.md`](./WEEBER-PLAN.md) | The phase roadmap (Foundation → Differentiation → Scale/Moat → Cost/In-house) — what's built vs. what's next. |
| [`UI-DESIGN-BRIEF.md`](./UI-DESIGN-BRIEF.md) | The confirmed design system/direction for `/dashboard` and `/app`. |
| [`AGENT-CONSOLE-UI-PLAN.md`](./AGENT-CONSOLE-UI-PLAN.md) | Agent config + live-preview UI plan and build status. |

## One path that must never move

`docs/agent-prompts/` is resolved at runtime by `packages/api/src/database/seed.ts` via a relative path
from `import.meta.dir`. Moving or renaming that folder breaks seeding silently — it's happened before.
Everything else under `docs/` is free to reorganize.
