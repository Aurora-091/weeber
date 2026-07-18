---
adr: 24
title: "Fixed a repo-wide silent typecheck gap: `tsc --noEmit` was checking nothing"
date: 2026-07-08
status: Accepted
---

## ADR-024 — Fixed a repo-wide silent typecheck gap: `tsc --noEmit` was checking nothing
**Date:** 2026-07-08

**Context:** While building Phase 1/2, `bunx tsc --noEmit` (invoked exactly as `packages/web`'s
`typecheck` and `build` scripts run it, and exactly as `.github/workflows/ci.yml` runs it in CI)
reported zero errors on a file that was — confirmed by direct inspection — missing an import and
referencing an undefined name. Root cause: `packages/web/tsconfig.json` is a solution-style config
(`"files": []`, only `"references"` to `tsconfig.app.json` and `tsconfig.node.json`). Running plain
`tsc --noEmit` against a references-only config with no `--build` flag does nothing — it doesn't error,
it silently type-checks an empty file set and exits 0. This has been true since the project template was
scaffolded, meaning **CI's typecheck step, and every "tsc clean" verification claimed in this project's
history (including this session's own ADR-020 and ADR-022), was not actually checking anything.**
Running `tsc -b` (or `-p tsconfig.app.json` / `-p tsconfig.node.json` explicitly) surfaced real,
pre-existing errors: several dashboard pages (`calls-list.tsx`, `dnc.tsx`, `call-detail.tsx`) accessed
properties directly on a Hono client's `{error} | {data}` union return type without narrowing first
(worked at runtime because the error branch never actually fires in normal use, but was never provably
type-safe), `admin-key-gate.tsx`'s typed RPC call resolved to `never` (root cause not fully isolated;
worked around by using a plain `fetch` there instead, since that call site only needs the HTTP status,
not a typed payload), `dnc.tsx` used a nonexistent `entry.id` (the DNC entry type has no `id` field —
fixed to key on `entry.phoneNumber`, which is actually unique), an unused `motion` import in `stack.tsx`,
and a `MotionValue<unknown>` vs `MotionValue<number>` mismatch in `architecture.tsx` from an untyped
`ReturnType<typeof useTransform>`. Also surfaced, and separately worth noting: this session's own edits
to `stream.ts`, `deepgram.ts`, `agent.ts`, `routes.ts`, and `call-detail.tsx` had several instances of an
edit silently not landing (a call site referencing a name that was never actually declared) — invisible
until real typechecking existed to catch it.

**Decision:** Changed `packages/web/package.json`'s `typecheck` script from `tsc --noEmit` to `tsc -b`,
and `build` from `tsc --noEmit && vite build` to `tsc -b && vite build` — both now honor the project
references and actually check `src/web` and `src/server.ts`/`vite.config.ts`. Fixed every error this
surfaced (listed above) rather than just the ones blocking this round's own work. Fixed
`.github/workflows/ci.yml`'s stale `packages/vent-compliance` references (two steps) left over from the
OpenVent rebrand (ADR-019/ADR-020) — the directory has been `packages/openvent-compliance` since then,
meaning CI's compliance-package steps have also been silently misconfigured since that rebrand.

**Consequences:** `bun run typecheck` and `bun run build` are now meaningfully trustworthy for the first
time — any future "verified: tsc clean" claim in this file means something. No functional/runtime
behavior changes beyond the `admin-key-gate.tsx` fetch-instead-of-RPC-client swap and the `dnc.tsx` key
fix, both of which are strictly more correct than before. Worth remembering going forward: after any
multi-file edit, verify with `tsc -b` (not bare `tsc --noEmit` on this project's root config), and
re-grep-verify individual edits landed rather than trusting an edit tool's success response alone —
demonstrated real value this round.
