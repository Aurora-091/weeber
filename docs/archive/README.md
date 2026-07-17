# Archive

Historical/superseded docs, kept for git history and past reasoning — not current references. If you're
looking for how something works today, use `architecture/`, `WEEBER-PLAN.md`, `DECISIONS.md`, or the
actual code, not these.

- **`CLAUDE-BUILD-BRIEF.md`** — pre-build execution spec for the admin panel + user dashboard. Both are
  live now; this describes the "how to build it" plan before either existed. Superseded 2026-07-13.
- **`USER-APP-PAGE-MAP.md`** — pre-build page inventory for the `/app/*` user dashboard, extracted from
  the earlier Vocalist frontend as a reference. `/app/*` shipped 2026-07-12. Superseded 2026-07-13.
- **`project_analysis.md`** — a codebase snapshot analysis that describes a pre-Postgres-migration,
  pre-package-split state (says "currently uses SQLite/libSQL... slated to migrate to Postgres" — that
  migration finished under ADR-034). Stale as of 2026-07-13.
- **`component-documentation-template.md`** — a generic, unused component-documentation template, never
  actually adopted for any real component in this repo. Archived, not deleted, 2026-07-13.
- **`workflow-canvas-bolt-prompt.md`** — the original copy-paste prompt used to scaffold the Workflow
  Canvas UI in an AI coding tool. The canvas is built and live; this prompt is a one-time build
  instruction with no further use beyond history. Moved out of `workflow-canvas-architecture.md` §7
  during a docs cleanup pass, 2026-07-16.
- **`UI-UX-AUDIT-CONTEXT.md`** — a UI/UX audit checklist whose own status banner (2026-07-13, later
  same day) marks items 1, 2, 4, 5, 7 as superseded — most of what it tracked has since shipped or been
  re-planned elsewhere (see `AGENT-CONSOLE-UI-PLAN.md`, `UI-DESIGN-BRIEF.md`). Archived during the
  `docs/` reorg, 2026-07-17.
