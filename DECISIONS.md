# DECISIONS.md — moved

This monolithic decision log was split on **2026-07-18** so agents (and humans) load one decision at a
time instead of a 170KB file.

**→ Start here: [`docs/decisions/README.md`](./docs/decisions/README.md)** — the ADR index (number,
title, date, status), with a link to each decision.

Each decision now lives in its own file: `docs/decisions/adr-NNN-slug.md`, with YAML frontmatter.

## Adding a decision

1. Create the next `docs/decisions/adr-NNN-slug.md` (copy the frontmatter from any existing ADR).
2. Add a row to `docs/decisions/README.md`.
3. Never rewrite a shipped ADR — supersede it with a new one that says so.

See [`AGENTS.md`](./AGENTS.md) for the ADR-vs-changelog rule (when something is a decision vs. routine
changelog work).
