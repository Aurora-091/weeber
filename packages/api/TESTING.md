# Testing (`packages/api`)

## Run the suite

```bash
bun run test          # bun test --isolate src/   ← the ONLY supported invocation
```

As of 2026-07-20 this is **658 pass / 0 fail** across 91 files.

## Do not remove `--isolate`

The `test` script **must** keep the `--isolate` flag. It runs each test file in a
fresh global object so leaked handles from one file cannot affect another.

If you strip it and run a bare `bun test`, you will see a large, drifting number
of **false** failures (73+ at last count, and the count changes as files are
added — a tell that it is order-dependent, not real). Those failures are **not**
product regressions. Proof:

- One-file-per-process (`for f in $(find src -name '*.test.ts'); do bun test "$f"; done`) → **0 fail**
- `bun test --isolate src/` → **0 fail**
- Bare `bun test` (single process) → 73 fail

## Why the leakage happens

Bun's `mock.module()` is **process-global and non-restorable** — `mock.restore()`
and `afterEach` do **not** undo it. 41 test files install `mock.module` at module
scope (30 of them mock `../../database`; others stub sibling source modules like
`./tts`, `./stt`, `./agent`). In a single process the last-registered mock wins
for every file, so e.g. `test-call-stream.test.ts` stubbing `./tts` clobbers the
real module that `tts/index.test.ts` exercises. `--isolate` gives each file a
fresh global, which sidesteps the whole problem.

## CI

`.github/workflows/ci.yml` runs `cd packages/api && bun run test` directly (fresh,
isolated — not through the turbo cache), so CI always reflects the true suite
state. The root `turbo` `test` task is additionally set to `"cache": false` as
defense-in-depth, so a local `turbo test` can never serve a stale-green result.

## Deferred: make the suite isolation-independent (tracked debt)

The durable fix — so bare `bun test` is also green — is to stop each file
installing its own divergent `mock.module`, and instead centralize DB/drizzle
mocking into a single shared `--preload` module (one canonical, per-test-settable
fake `db`). This is a 30+ file migration and is deliberately deferred: the shipped
command (`--isolate`) is green and CI is correct, so it is a P2 hygiene item, not
a launch blocker. Do it as a focused refactor, not piecemeal, to avoid
destabilizing the currently-green suite.
