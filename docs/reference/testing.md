# Testing

OpenVent uses `bun:test` — no separate test runner, no mocking framework. Tests live next to the code they
test (`foo.ts` → `foo.test.ts`), following Bun's convention.

## Test layout: colocation, not a `testing/` folder

Every test file sits **directly beside the source it exercises** (`agent.ts` → `agent.test.ts`,
`WaitlistForm.tsx` → `WaitlistForm.test.tsx`). This is deliberate and settled — do **not** propose or add a
top-level `testing/` (or `__tests__/`) directory:

- It's the Bun convention (`bun test` auto-discovers `*.test.ts` next to source), so it works with zero glob
  config.
- Colocation is agent-navigable: the test for any file is one `ls` away in the same directory, and it's
  obvious at a glance which source files lack a test.
- A separate tree duplicates the package structure and drifts the moment a file moves.

New tests go next to their subject. No exceptions unless a future ADR overturns this.

## Running tests

> **Always `bun run test`, never bare `bun test`** — see the ADR-056 gotcha below. Bare `bun test` skips
> `--isolate` and produces phantom cross-file failures.

```bash
# Everything, across all 3 packages (turbo orchestrates it)
bun run test

# Just the API package (voice pipeline, integrations, compliance gates, resilience layer, etc.)
cd packages/api && bun run test

# Just the web app (frontend unit + component tests)
cd packages/web && bun run test

# The standalone compliance package
cd packages/openvent-compliance && bun run test
```

To iterate on a single file, `bun test <path>` is fine **for that one file** (isolation is moot with one
file) — but always confirm the final state with `bun run test` before committing.

### Gotcha: install deps first, or you get a false green (not a false red)

CI and any clean checkout must run `bun install --frozen-lockfile` **before** testing. If `node_modules` is
missing or stale, `turbo test` can report **success while silently skipping** packages whose tests never
ran — a false *green*, which is worse than a red because it hides real breakage. Never trust a green suite
you ran without a completed install in the same session. The CI `test` job installs with
`--frozen-lockfile` as its first step for exactly this reason.

### Gotcha: `bun run test` vs bare `bun test` (ADR-056)

`packages/api` and `packages/web` run `bun test --isolate src/`. The `--isolate` flag gives each test file
its own module registry. Bare `bun test` (no `--isolate`) shares one registry across every file, so
module-level state — `global.fetch` overrides, circuit-breaker singletons, provider-resolution caches — leaks
across files depending on run order and manufactures failures that don't exist. This is the phantom
"38 pre-existing failures" that got cited across many sessions before [ADR-056](../decisions/adr-056-correction-the-38-pre-existing-test-failures-baseline-cited-.md)
traced it to the wrong verification command. **Verdict: always `bun run test` (reads the package script,
includes `--isolate`); never bare `bun test` for a full run.**

## What's covered today

| Area | File | What it tests |
|---|---|---|
| State engine | `packages/api/src/voice/agent.test.ts` | `buildKnownFactsBlock` — empty/populated/multi-field prompt injection, doesn't mutate input |
| **End-of-turn detection** (Five Bets P5) | `packages/api/src/voice/turn-detection/turn-detection.test.ts` | `HeuristicTurnDetector` = old `endsMidThought`; `withLatencyBudget` fast-path / slow→fallback / throw→fallback; composite short-circuits on mid-thought (no model call) + consults refiner only when turn looks complete; `createTurnDetector` default = bare heuristic (no vendor). Uses a `StubModelTurnDetector` mock — no live model, no audio path |
| **Backchannels** (Five Bets P4) | `packages/api/src/voice/backchannel.test.ts` | Cached-only mid-utterance ack selection/eligibility; never live-synths on the hot path |
| **Synthetic scenarios** (Five Bets P3) | `packages/api/src/voice/synthetic-test.test.ts` | 8 offline agent-behavior scenarios + catalog-integrity checks (all scenarios well-formed, no dupes) |
| **Call-health classifier** (Five Bets P2) | `packages/api/src/voice/call-health.test.ts` | `classifyCallHealth` tiering — the signal the P5 model-wiring gate depends on |
| **Guardrail events** (Five Bets P1) | `packages/api/src/voice/guardrail-events.test.ts` | `guardrail_events` audit-row shape/writer |
| `captureField` tool | `packages/api/src/voice/tools/captureField.test.ts` | Tool shape, echoes captured field/value |
| Session store | `packages/api/src/voice/session-store.test.ts` | Set/get/update/delete, workflow retry metadata |
| Per-number config | `packages/api/src/voice/number-config.test.ts` | Parses `NUMBER_CONFIG` JSON, handles malformed/non-object input gracefully |
| Cross-provider failover | `packages/api/src/voice/failover.test.ts`, `packages/api/src/voice/compliance/attempt-cap.test.ts` | STT/TTS/LLM fallback-chain resolution, Florida FTSA rolling-24h attempt cap |
| Provider resolution | `packages/api/src/voice/llm/index.test.ts`, `packages/api/src/voice/tts/index.test.ts`, `packages/api/src/voice/stt/*.test.ts` | Env-var/override resolution, safe fallback for unknown provider values, per-provider adapter behavior (Deepgram/Sarvam/ElevenLabs STT, ElevenLabs/Cartesia/Sarvam TTS) |
| E.164 validation | `packages/api/src/voice/validation.test.ts` | Valid/invalid phone number formats |
| **Integration resilience** | `packages/api/src/voice/integrations/resilient-fetch.test.ts` | Timeout detection, retry-then-succeed, retry-then-fail, circuit breaker opening/cooldown, per-integration isolation, failure-count reset on success |
| GoHighLevel / Salesforce / HubSpot / Google Calendar | `packages/api/src/voice/integrations/*.test.ts` | Not-configured fallback (missing env vars), successful sync/booking, graceful degradation when the third-party API errors or is unreachable |
| Telephony providers | `packages/api/src/voice/plivo-client.test.ts`, `packages/api/src/voice/telephony-transport.test.ts` | Wire-format parsing/building, mu-law<->PCM16 codec round-trip, Plivo hangup/transfer request shapes |
| Compliance gates | `packages/api/src/voice/compliance/*.test.ts` | Insurance number-series/producer-licensing gates, consent-adapter org isolation, FTSA attempt cap |
| Compliance package | `packages/openvent-compliance/src/*.test.ts` | Calling-window resolution (incl. mini-TCPA state overrides), DNC add/check, consent disclosure toggle, HIPAA boot guardrail, GDPR retention purge + erasure, national-DNC adapter shape |

Not an exhaustive list — this table covers the areas most worth knowing about, not every test file. Run
`bun run test` for the current total pass/fail count; don't rely on a hardcoded number here, it goes stale
the moment anyone adds a test.

## What's deliberately not covered by automated tests

- **The live call pipeline itself** (`stream.ts`'s WebSocket state machine, actual Twilio/Plivo/Exotel Media
  Stream handling, STT/TTS provider connections) — this needs a real phone call to exercise meaningfully;
  it's verified via manual curl-based regression checks and, where a real provider account was available,
  live-tested end-to-end (see `DECISIONS.md`'s hardening-round ADRs and `docs/voice-quality/hindi-hinglish-voice-support.md`
  for specific examples) rather than unit tests. A proper integration-test harness for this is open
  territory.
- **OAuth flows** for Salesforce/Google Calendar — these integrations assume you already have a valid
  access token in the environment; the token-acquisition flow itself isn't OpenVent's responsibility and isn't
  tested here.
- **Plivo/Exotel against a real account** — the request shapes (hangup/transfer/outbound call) match each
  provider's own documented API, but no live call has been placed through either in this codebase's own
  testing — see `docs/voice-quality/india-telephony.md`'s status notes for exactly what's confirmed vs. unconfirmed.

## Writing new tests

Follow the existing pattern:
- Test the actual function directly, not through HTTP — extract pure logic into its own exported function
  if it's currently buried in a route handler (see `parseWorkflows`/`parseNumberConfigMap`/
  `buildKnownFactsBlock` for the established pattern).
- For anything that calls `fetch` (integrations, Plivo/Exotel clients), stub `global.fetch` directly in the
  test and restore it in `afterEach` — see `packages/api/src/voice/integrations/hubspot.test.ts` or
  `packages/api/src/voice/plivo-client.test.ts` for the pattern. No mocking library needed; `bun:test`
  doesn't require one for this.
- For DB-touching compliance/insurance gates, mock `../../database` and `drizzle-orm`'s `eq`/`and`/`gte` as
  plain-JS predicate builders against in-memory arrays — see `packages/api/src/voice/compliance/insurance-gates.test.ts`
  or `attempt-cap.test.ts` for the pattern.
- Reset any module-level state your test depends on (e.g. `__resetBreakersForTests()` for the resilience
  layer) in a `beforeEach`/`afterEach` so tests don't leak state into each other.

## Web component tests (React + happy-dom)

`packages/web` tests both pure logic (`lib/theme.test.ts`, `lib/verticals.ts`) and **React components**
(`components/ui/button.test.tsx`, `components/marketing/WaitlistForm.test.tsx`). Component tests render with
`@testing-library/react` against a global DOM provided by **happy-dom**, wired up once:

- `packages/web/test-setup.ts` calls `GlobalRegistrator.register({ url: "http://localhost:4200" })`, which
  installs `document`, `window`, `localStorage`, `fetch`, `WebSocket`, etc. as real globals.
- `packages/web/bunfig.toml` preloads it for every test run: `[test] preload = ["./test-setup.ts"]`.

Patterns to follow (and gotchas that already bit us):

- **happy-dom provides the DOM globals — don't reassign them.** happy-dom registers `localStorage`,
  `window`, `fetch`, and `WebSocket` as **read-only** globals. A top-level `global.localStorage = {...}` or
  `global.window = {...}` throws `TypeError: Attempted to assign to readonly property` *once another test
  file has registered happy-dom first* — i.e. it passes in isolation and fails in the full run. Rely on the
  happy-dom implementations (`localStorage.clear()` in `beforeEach`; happy-dom's `matchMedia` defaults
  `matches: false`).
- **To stub a global (e.g. `fetch`, `WebSocket`) use `Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })`**,
  not a plain assignment — that sidesteps the read-only conflict. Restore it in `afterEach`. See the
  `setGlobal()` helper in `WaitlistForm.test.tsx`.
- Components that fetch on mount (`useWaitlistCount` → `fetch` + a live `WebSocket`) need both stubbed to an
  inert success, or the test emits unhandled errors (false-red in CI). `WaitlistForm.test.tsx` shows the
  inert-`WebSocket` class pattern.
- Call `cleanup()` from `@testing-library/react` in `afterEach` to unmount between tests.
- A benign `An update to X inside a test was not wrapped in act(...)` warning can appear for
  fetch-on-mount components; it does not fail the run (exit 0) and is acceptable.

## Coverage

Each package has a `test:coverage` script (Bun's built-in `--coverage`, no extra tooling):

```bash
# Whole monorepo (turbo fans out per package)
bun run test:coverage

# One package
cd packages/openvent-compliance && bun run test:coverage
```

Coverage is a **separate** script on purpose — the canonical `test` stays lean and fast for the CI gate,
and coverage is opt-in when you want the report. Output is a per-file line/function table in the terminal;
the `coverage/` directory is gitignored. There is **no enforced threshold** today — coverage is a lens for
spotting untested surfaces (e.g. it's what flagged the then-untested marketing waitlist form), not a
blocking gate. Don't add a hard `--coverage-threshold` without an ADR.

## End-to-end (Playwright)

`packages/web` has one happy-path E2E suite for the **public landing page** — the site's single conversion
surface — under `packages/web/e2e/`, configured by `packages/web/playwright.config.ts`.

```bash
cd packages/web && bun run test:e2e
```

Design constraints that keep it deterministic (read before adding more E2E):

- **It targets the secret-free static path only.** The spec asserts things that are fully client-side: the
  landing page renders (title + hero headline) and the waitlist form's validation gating runs in-browser.
  The API is same-origin by default (`lib/api.ts`), so the count fetch/WebSocket simply fail gracefully
  against the static preview and don't affect the page. **No live backend, no secrets** → it can't go
  false-red in CI.
- **It runs against the real built bundle**, not the dev server: the Playwright `webServer` runs
  `bun run build && vite preview` on a fixed port, so the test exercises the shipped artifact.
- **It is NOT part of `bun run test`.** Keep it on its own `test:e2e` script (and its own CI job) so the fast
  unit/component gate stays fast and the E2E's browser + build cost is isolated.
- First run needs the browser: `bunx playwright install chromium`. Artifacts (`test-results/`,
  `playwright-report/`) are gitignored.
- Anything requiring auth or a live backend (dashboard, `/app`) is deliberately **out of scope** for E2E —
  those stay in manual/curl regression checks (see the "deliberately not covered" section) to avoid
  flaky, secret-dependent tests.

## Continuous Integration

Every push and pull request against `main` runs six parallel jobs via GitHub Actions — see
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml): `typecheck`, `test`, `build`, `lint`,
`migration-drift`, and `e2e` (the Playwright landing-page suite). Every job runs
`bun install --frozen-lockfile` **as its first step** — the deps-first rule above is enforced in CI, so the
false-green-on-missing-deps failure mode can't reach `main`.

None of these steps need real API keys or a live database; the build, tests, and the E2E suite are fully
static/mocked/secret-free by design (the E2E targets only the client-side landing path — see above). A red
CI check therefore means something is actually broken, not a missing secret — treat it as blocking.

The one required status check in branch protection is `ci-success`, the aggregator that `needs` all six
jobs. Adding/renaming a job never means reconfiguring branch protection — but a new job **does** need to be
added to `ci-success`'s `needs` list or its failures won't block merges (the `e2e` job is wired in).
