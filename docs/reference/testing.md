# Testing

OpenVent uses `bun:test` — no separate test runner, no mocking framework. Tests live next to the code they
test (`foo.ts` → `foo.test.ts`), following Bun's convention.

## Running tests

```bash
# Everything, across all 3 packages (turbo orchestrates it)
bun run test

# Just the API package (voice pipeline, integrations, compliance gates, resilience layer, etc.)
cd packages/api && bun run test

# Just the web app (frontend unit tests)
cd packages/web && bun run test

# The standalone compliance package
cd packages/openvent-compliance && bun run test
```

All four are plain `bun test` under the hood (see each package's `package.json`) — you can also run
`bun test <path>` directly to run a single file while iterating.

## What's covered today

| Area | File | What it tests |
|---|---|---|
| State engine | `packages/api/src/voice/agent.test.ts` | `buildKnownFactsBlock` — empty/populated/multi-field prompt injection, doesn't mutate input |
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

## Continuous Integration

Every push and pull request against `main` runs typecheck, the full test suite, the production build, and
lint via GitHub Actions — see [`.github/workflows/ci.yml`](../.github/workflows/ci.yml). None of these steps
need real API keys or a live database; the build and tests are fully static/mocked. A red CI check means
something is actually broken, not a missing secret — treat it as blocking.
