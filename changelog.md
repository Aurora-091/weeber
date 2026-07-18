# changelog.md — moved

This monolithic changelog was split on **2026-07-18** into one file per month so agents load only the
window they need instead of a 91KB file.

**→ Start here: [`docs/changelog/README.md`](./docs/changelog/README.md)** — the index by month.

- Dated entries live in `docs/changelog/YYYY-MM.md` (newest month first).
- Undated summary sections (backend workstreams, schema modifications, API/param updates) live in
  [`docs/changelog/reference-sections.md`](./docs/changelog/reference-sections.md).

## Adding an entry

Append to the current month's file (create it if the month doesn't exist yet) and keep
`docs/changelog/README.md` current.

**Changelog vs. decision:** routine feature work (new table/column, endpoint param, wiring an
already-decided pattern) → changelog. A real choice between alternatives (architecture / compliance /
data-model / UX) → an ADR in [`docs/decisions/`](./docs/decisions/README.md). See [`AGENTS.md`](./AGENTS.md).
