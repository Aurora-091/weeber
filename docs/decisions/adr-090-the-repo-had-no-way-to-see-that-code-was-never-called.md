# ADR-090: The repo had no way to see that code was never called

- Status: Accepted
- Date: 2026-08-09
- Supersedes: none
- Amends: none
- Related: ADR-073 (number webhook sync), ADR-088 (prohibited-capture guard), the
  `tools/ui-guard/design-guard.ts` ratchet precedent

## Context

Eight of the last seventeen ADRs are the same defect, not seventeen different
ones: **code written, documented, unit-tested, and never connected to a caller.**
ADR-073 (`syncNumberWebhooksForOrg`, zero callers) and ADR-088
(`findProhibitedCapture`, zero callers) are the identical bug found **three days
apart**, both times by a human who happened to run `rg` for the function name.
ADR-076, 077, 080, 083, 084 and 087 are variants of the same seam failure.

Two facts explain why the existing gates never caught any of them.

**1. Nothing in this repo measured reachability.** A grep for
`"(knip|ts-prune|unimported|depcheck|madge)"` across every `package.json`
returned nothing. `.oxlintrc.json` enables `categories.correctness` only, which
is per-file — it cannot see across module boundaries by design. The CI had eleven
jobs and not one of them could answer "is this function called from production?"

**2. Unit tests actively hide this class of bug.** A test imports the symbol
directly. From the test's point of view the export is used; from production's it
is dead. 57 of 123 API test files use `mock.module`, and only 1 touches
`db.insert(`, so the suite is dense at the unit level and near-blind at the seams
— which is precisely where all eight defects lived. Adding more unit tests would
not have found a single one of them. Reachability analysis is the only check that
distinguishes "a test calls it" from "the product calls it".

The detection cost is the tell: both times, the mechanism was a human's memory
plus a manual grep. That does not scale past a repo one person is holding in
their head.

## Decision

Add `knip` and enforce it in CI as a **ratchet**, mirroring `design-guard`:

- `knip.json` — workspace-aware entry/project config for `.`, `packages/api`,
  `packages/web`, `packages/weeber-compliance`. Zero configuration hints.
- `tools/dead-code/knip-baseline.json` — the recorded state of `main`, 61
  findings, as line-number-free `category:file#name` keys.
- `tools/dead-code/knip-gate.ts` — runs knip, diffs against the baseline, exits 1
  on any finding **not** in it. `--update` rewrites the baseline; `--json` for
  machines.
- `bun run knip:gate`, plus a `dead-code` CI job wired into `ci-success`'s
  `needs`.

Configuring knip properly also removed four genuinely unused root/package
devDependencies as a side effect (`semver`, `@types/semver`, `oxfmt`, root
`zod`, `@types/ws` in api) — nothing in the repo, CI, or turbo referenced them.

## Why a ratchet and not a binary gate

Same reason as `design-guard`. The honest baseline is 61 findings: 4 unused files,
40 unused exports, 15 unused exported types, 2 duplicate exports. A pass/fail
gate would have to be switched off on its first run, and a gate that gets
switched off never comes back on. A ratchet cannot be switched off — it only ever
lets the number go DOWN, so the existing debt stays visible without blocking
work, and the next `findProhibitedCapture` fails CI on the commit that introduces
it instead of three days later.

The baseline is **not** an exclusion list. It records specific findings by
identity, so deleting one dead export and adding another does not net out to
green — the new one fails. Raising the baseline is a one-line diff in a file
whose only purpose is to make that edit conspicuous in review.

## Why keys ignore line numbers

A finding is keyed `category:file#name`. Line and column are printed for humans
and deliberately not part of the key. Otherwise moving a known-dead export ten
lines down a file turns CI red and teaches everyone that the gate is noise.

## Why `knip-bun` and not `knip`

knip's node build allocates through oxc-parser's raw-transfer buffer and dies on
a small machine: `RangeError: Array buffer allocation failed` at
`oxc-parser/src-js/raw-transfer/common.js:294` on a 4 GB / 2-core box. The bun
build has no such step. Pinning `knip-bun` in the gate also means a laptop and a
CI runner produce byte-identical numbers, which is the only thing that makes a
recorded baseline meaningful.

## Consequences

- New unreferenced exports, files, types and dependencies now fail CI on arrival.
- The 61 baseline findings are a visible, shrinkable debt list rather than
  invisible rot. Notable entries worth resolving deliberately, not casually:
  the whole of `voice/workflows/index.ts` and `voice/turn-detection/index.ts`
  barrel exports, `bookAppointment`, `deleteOrgCredentials`/`readCredentials`,
  and six unused error classes in `utils/errors.ts`.
- **This does not fix the seam problem, only its most visible symptom.** knip
  proves a symbol is referenced from an entry point; it cannot prove the
  reference is on the path that actually runs. ADR-084's defect (a counter wired
  but reading the wrong field) would still pass this gate. Integration tests
  against a real DB, with no `mock.module`, remain the next required step.
- A false positive is now possible: genuinely reachable code that knip cannot see
  (dynamic import, config-file-only usage). The fix is `knip.json`, never the
  baseline.
