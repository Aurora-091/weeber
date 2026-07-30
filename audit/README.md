# Audit log

Dated, point-in-time code audits — each one is a snapshot of "what does the codebase actually do
right now", not a plan or a spec. If a finding here is stale, the code has moved on since; check
`DECISIONS.md`/`changelog.md` for what happened after. Files are named `YYYY-MM-DD-audit-NN[-topic].md`
and are read chronologically, oldest first.

- **`2026-07-10-audit-01.md`** — first backend audit pass.
- **`2026-07-12-audit-02.md`** — follow-up backend audit.
- **`2026-07-13-audit-03.md`** — follow-up backend audit.
- **`2026-07-13-audit-04-uiux.md`** — first UI/UX-focused audit (admin panel + user dashboard).
- **`2026-07-15-audit-05.md`** — follow-up backend audit.
- **`2026-07-15-audit-06-db-systems.md`** — database/systems-focused audit (schema, migrations,
  Postgres/Supabase setup).
- **`2026-07-15-review-outbox-vault-versioning.md`** — targeted review of the outbox pattern, secrets
  vault, and versioning approach.
- **`2026-07-17-audit-07-live-infra.md`** — audit covering live infrastructure as currently deployed.
- **`2026-07-30-audit-08-workflow-canvas-ux.md`** — most recent audit: cold UX audit of the merchant
  workflow builder (Standard view / canvas / AI-draft) + competitive matrix; drove the P0 persona-dropdown
  and AI-draft-front-door fixes shipped the same day.

See also `docs/product-strategy/agents-ux-audit-and-cogs-2026-07-17.md` for a source-level audit of
the Agents UI framework paired with COGS/unit-economics analysis — kept under `docs/` rather than here
since it's half product/GTM content, not a pure code audit.
