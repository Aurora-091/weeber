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
- **`ui-implementation-plan.md`** — the phased execution plan companion to the 2026-08-03 UI/UX audit
  (now `audit/2026-08-03-audit-ui-ux-full-surface.md`). Phase 0's guardrails shipped and are enforced in
  CI (`tools/ui-guard/{contrast-gate.ts,design-guard.ts,design-budget.json,tokens.json}`,
  `packages/web/e2e-visual/{visual,a11y,font-provenance}.spec.ts`), so the plan's file paths and open
  questions no longer describe the repo. Kept as the reasoning record. Archived 2026-08-20.
- **`ui-phase0-notes.md`** — scratchpad for that plan's Phase 0, which says in its own second line to
  "delete or fold into docs/ when Phase 0 closes". Phase 0 closed. Archived 2026-08-20.
- **`UI-FIX-TASK.md`** — a task tracker for three structural UI complaints (nav chunk flash, detached
  page feel, z-index/overflow drift). Its verification harness (`/__preview`, `pages/__preview.tsx`) is
  now a permanent DEV-only route, and the work it tracked is done. Archived 2026-08-20.
- **`ci-triage-notes.md`** — the write-up of the first-ever CI run (2026-07, PR #2). Its own banner
  already marked it historical; the live definition is `.github/workflows/ci.yml`. Moved out of the repo
  root, 2026-08-20.

- **`insurance-language-variants-task.md`** — the build task for config-driven single-language insurance
  agents (`en`/`hi`/`hinglish`). All ten steps are checked off and verified 2026-07-19 (test 565 pass,
  typecheck 3/3, lint 0). Its one flagged open gap — no `hinglish` key in the compliance disclosure map —
  has since been closed: `DISCLOSURE_TEXT_BY_LANGUAGE` in `packages/weeber-compliance/src/consent.ts` now
  carries a `hinglish` entry. The live definitions are `voice/insurance-greetings.ts`, `voice/agent-frame.ts`
  and `voice/tts/sarvam.ts`; the four code comments citing this doc were repointed here in the same commit.
  Archived 2026-08-21 (ADR-118).
- **`leads-layer-build-task.md`** — Phase 1 build tracker for the native leads layer, banner `✅ COMPLETE`.
  Superseded by the shipped code (`packages/api/src/voice/leads/`, `POST /api/leads/ingest`) and recorded in
  ADR-061 + changelog 2026-07-19. The design rationale it points at stays live at
  `docs/product-strategy/native-leads-layer-plan-2026-07-19.md`. Archived 2026-08-21 (ADR-118).
- **`leads-phase2-3-build-task.md`** — Phase 2 + 3 tracker for the same layer, banner
  `✅ COMPLETE (2026-07-19)`, with the Orders-migration item deferred as planned. Same supersede path:
  ADR-061 + changelog 2026-07-19. Archived 2026-08-21 (ADR-118).
- **`PHASE23-PROGRESS.md`** — a live scratchpad for the Phase 2+3 build, self-described as such, banner
  `✅ COMPLETE (2026-07-19)`. The running-progress role it served now belongs to `docs/brain/progress.md`.
  Archived 2026-08-21 (ADR-118).
