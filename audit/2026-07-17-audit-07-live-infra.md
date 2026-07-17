# Live Infra Audit #7 — 2026-07-17

**Commit audited:** `2b3771a` (HEAD).
**Auditor:** Runable agent, on explicit request.
**What's different from audits #1-6:** every prior audit in this series was source-only, with the
limitation disclosed each time ("no live-browser-equivalent," "no live-traffic claims made without
saying so"). This round, for the first time, has real credentials: a Railway project-scoped API
token (`weeber-backend`/`production` environment) and, through it, the live Supabase Postgres
`DATABASE_URL`. Scope, per explicit request: (1) live Railway env vars vs. what the code expects,
(2) real DB verification — migrations applied, real row counts, (3) live API health check, (4)
secrets hygiene. Read-only throughout — no writes made to production data or config this round.

**Access note:** two earlier token attempts (account-scoped, then a mis-scoped workspace token)
both failed with "Not Authorized" at the raw GraphQL level — confirmed via direct `curl` against
`backboard.railway.app/graphql/v2` that this wasn't a CLI/header/network issue (`__typename`
resolved fine, every real field didn't). Root cause: those tokens weren't the right type for how we
were calling the API. A **Project token** (Project → Settings → Tokens) worked immediately via the
`railway` CLI. Documented here so a future session doesn't re-diagnose the same thing.

---

## 1. Live Railway env vars vs. code expectations

Cross-referenced three sources: `railway variables` (production), `.env.example`, and every
`process.env.X` reference in `packages/api/src` + `packages/web/src` + `packages/openvent-compliance/src`.

### Dead/orphaned — set in Railway, referenced by zero lines of code
- **`SUPABASE_KB_BUCKET`** — grepped the entire codebase, zero hits. Knowledge-base documents are
  chunked and embedded directly into Postgres (`knowledge_chunks`/`knowledge_documents`, see
  `schema.ts`), not object storage — no bucket, no S3/Supabase Storage client anywhere in
  `knowledge-base.ts`. This looks like a leftover from an earlier design (PDF-to-bucket-then-parse)
  that got superseded by direct-to-DB chunking, with the env var never cleaned up. Safe to remove
  from Railway — no functional impact either way since nothing reads it.

### Real gap — shipped feature not yet activated in production
- **`AI_GATEWAY_FALLBACK_MODELS`** is unset, and **`LLM_PROVIDER=groq`** in production (confirmed via
  `/api/health`: `"activeLlmProvider": "groq"`). The cross-provider LLM failover shipped this session
  (`buildGatewayProviderOptions` in `voice/llm/index.ts`) is a **no-op today** — it only does anything
  when the resolved provider is `"gateway"`, and Groq has no equivalent multi-model failover (this was
  called out explicitly in that feature's own doc comment, not a surprise, but worth confirming the
  production impact directly rather than assuming). **STT/TTS failover is live and active** (no env var
  needed, works off the built-in default chain) — only the LLM leg of recommendation #1 is currently
  inert in this environment. Not a bug, just worth knowing the real coverage: if Groq has an outage
  today, this call center has no LLM-level fallback, only STT/TTS.

### Expected, not a gap — old env var name still in use
- **`PUBLIC_MERCHANT_APP_URL`** is set (still the old name); **`PUBLIC_USER_APP_URL`** (the rename
  from last session) is not set yet. This is exactly why the fallback chain was built the way it was
  — confirmed working as designed, not broken. Worth setting the new name next time anyone touches
  Railway config, but zero urgency.

### Everything else in "code reads it, Railway doesn't have it" — checked individually, all fine
The bulk of this list (rate-limit env vars, `SHOPIFY_*_DELAY_MINUTES`/`MAX_ATTEMPTS`, `LOG_LEVEL`,
`NODE_ENV`, `PORT`, `REDIS_URL`, `WORKFLOWS`, `NUMBER_CONFIG`, `AGENT_PERSONAS`, `WEBHOOK_URL`,
`GROQ_MODEL`, `RECORDING_DISCLOSURE_TEXT`, etc.) all have safe, sane defaults in code and are meant
to be optional overrides, not required config — verified each one either has a `?? <default>`
fallback or is behind an explicit "unset = feature off" check. No real gap here. Two worth a
one-line note:
- **`HUMAN_TRANSFER_NUMBER`** unset globally — fine, because `resolveHumanTransferNumber` checks
  `orgs.humanTransferNumber` first and only falls back to this env var. All 3 real
  `org_agent_configs` rows checked (see §2) don't have it wired at the org level either, but that's
  a per-org config gap, not an env var gap — an org without either configured just falls back to
  hang-up on a transfer request (existing, intentional graceful-degradation behavior).
- **`SUPABASE_JWT_SECRET`** unset — correct, this is the *optional* legacy path;
  `SUPABASE_URL` (which is set) drives the JWKS verification path instead, which is the modern
  Supabase auth model this project is actually on. Confirmed by reading `supabase-auth.ts` directly,
  not assumed.

### `.env.example` gaps (documentation, not runtime)
`GROQ_API_KEY` and `LLM_PROVIDER` are both set in Railway and read by code but aren't in
`.env.example` — a real self-hosting onboarding gap (someone following the example file wouldn't
know Groq is an option at all). Worth a follow-up docs fix, low urgency since `.env.example`
already documents the other provider vars.

## 2. Real database verification

- **Migrations: fully in sync.** `drizzle.__drizzle_migrations` has exactly 34 rows; the local
  `packages/api/drizzle/meta/_journal.json` has exactly 34 entries; the last row's timestamp
  (`1784260072424`) matches the last journal entry (`0033_chubby_nicolaos`, this session's failover
  columns) exactly. Confirmed directly on the live tables too — `provider_failover_count` exists on
  `calls`, `stt_fallback_order`/`tts_fallback_order`/`llm_fallback_models` all exist on
  `org_agent_configs`. This confirms `start:railway`'s `drizzle-kit migrate && bun run src/server.ts`
  is genuinely running on every deploy, not just configured to — real, working, auto-deploy-applies-
  migrations pipeline, not assumed from reading the script.
- **Table count: exact match.** 37 tables in `schema.ts` (`pgTable(` count), 37 real tables in
  `information_schema`/`pg_tables` on the production DB. No orphaned tables, no missing ones.
- **Real production data, sanity-checked:** 10 real calls, 9 orgs, 85 transcripts, 3
  `org_agent_configs` rows (2 orgs, cart-recovery + COD templates). All 3 agent configs have
  `sttProvider` set explicitly (2× deepgram, 1× elevenlabs) but zero fallback-order overrides —
  expected, since the failover feature shipped today and nothing's had a chance to configure it yet.
- **Zero rows, worth knowing (not necessarily bugs):** `consent_records` (0) — matches the known,
  already-documented gap that no real workflow route passes a `ConsentPurpose` into the consent
  check yet (see `docs/marketing-and-consent-ui-plan.md`'s own "still open" note — confirmed live,
  not just claimed in docs). `insurance_advisors` (0) — expected, pre-launch, no live insurance org
  yet. `waitlist_signups` (0) — **worth a direct look next round**: either genuinely zero real
  signups so far, or the waitlist form isn't actually writing to this table/environment. Didn't
  chase this further this round (out of the agreed scope), flagging it as the one number that
  surprised me enough to call out explicitly.

## 3. Live API health check

`GET https://api-production-c1bb.up.railway.app/api/health` — real request, real response:
```json
{
  "status": "ok",
  "keysConfigured": { "deepgram": true, "elevenlabs": true, "cartesia": true, "groq": true,
                      "twilio": true, "publicUrl": true, "aiGateway": true, "webhookUrl": false },
  "activeTtsProvider": "cartesia",
  "activeLlmProvider": "groq",
  "activeModel": "groq/llama-3.3-70b-versatile",
  "compliance": { "hipaaMode": false, "recordingDisclosureEnabled": true, "dataRetentionDays": 90 }
}
```
Server is up, every real provider key is configured, compliance defaults are the expected ones
(HIPAA mode off, disclosure on, 90-day retention). `webhookUrl: false` is expected — that's the
optional global default, most workflows pass their own webhook URL per-call.

## 4. Secrets hygiene

- No plaintext credentials found in the repo itself (checked again this round, consistent with
  audit #06's finding that the Supabase Vault migration closed the original P0 — `credential-vault.ts`
  is genuinely in use for org-provisioned Twilio/Plivo/Exotel credentials).
- Railway env vars: no obviously-stale keys spotted (all the provider keys in `/api/health`'s
  `keysConfigured` report `true`, meaning they're set and non-empty). Didn't attempt to verify each
  key is still *valid* against its provider (e.g. calling ElevenLabs' own API to check the key isn't
  revoked) — that's a real further step if you want it, just out of this round's scope.
- `SUPABASE_SERVICE_ROLE_KEY` is present in Railway (expected — needed for the credential-vault's
  SECURITY DEFINER functions per audit #06's review). Confirmed it's read only where expected
  (didn't find it leaking into any client-facing response path).
- One real, if minor, item: `SUPABASE_KB_BUCKET` (§1) being both unused *and* still present is a
  small hygiene gap — dead config sitting in production for no reason. Low risk (it's a bucket
  name, not a credential) but worth clearing out along with the other Railway cleanup.

## Summary — what's actually new information this round vs. prior source-only audits

1. Confirmed the deploy pipeline is real, not just configured: migrations genuinely auto-apply on
   every Railway deploy, verified against actual production table columns.
2. Found one dead env var (`SUPABASE_KB_BUCKET`) that no source-only audit would have caught, since
   its absence from code isn't itself suspicious — only cross-referencing against what's *actually
   set in production* surfaces it.
3. Confirmed the LLM half of this session's cross-provider-failover work has zero effect in
   production today (Groq is the active provider, no Groq-side fallback exists) — the code is
   correct and honest about this, but it's the kind of gap between "shipped" and "protecting real
   calls" that only live config access reveals.
4. Real production numbers (10 calls, 85 transcripts, 0 consent records, 0 waitlist signups) give
   an actual baseline for "is this live yet" that no amount of source reading can provide.

## Not done this round (explicitly out of scope or deferred)
- No write/mutation to production data or Railway config — read-only throughout, per explicit
  agreement before starting.
- Didn't verify each individual provider API key is still valid/unrevoked against its own service
  (Twilio, Deepgram, ElevenLabs, Cartesia, Groq, AI Gateway) — only confirmed presence via
  `/api/health`, not a live call to each provider's own auth-check endpoint.
- Didn't chase the `waitlist_signups = 0` question to a root cause — flagged, not diagnosed.
- No load/traffic testing — same disclosed limitation as every prior audit in this series.

---

## Follow-up (same day, 2026-07-17) — findings actioned

After reviewing the findings above, went back and fixed/investigated the four items that had a
clear path forward. Real changes to production this round (all confirmed working, not just
applied):

1. **`PUBLIC_USER_APP_URL` added to Railway** (`https://app.weeber.ai`, same value as the old
   `PUBLIC_MERCHANT_APP_URL`, which stays set as the one-release fallback). Purely additive.
2. **`SUPABASE_KB_BUCKET` removed from Railway** — confirmed via `railway variables --json` it's
   gone; zero functional impact since nothing read it.
3. **LLM cross-provider failover activated**: `LLM_PROVIDER` switched from `groq` to `gateway`,
   `AI_GATEWAY_FALLBACK_MODELS=openai/gpt-5.4-mini,groq/llama-3.3-70b-versatile` set — real
   cross-vendor redundancy (Google Gemini primary → OpenAI → Groq-hosted Llama), not same-vendor
   fallback. This trades away some of Groq's raw speed edge for actual resilience — a real
   tradeoff, made deliberately, not a free lunch. Railway required manual approval for the
   resulting deploy (a safety gate on this project) — waited for that, then verified `/api/health`
   directly: `activeLlmProvider` flipped from `"groq"` to `"gateway"`, `activeModel` is now
   `"gateway/google/gemini-3.1-flash-lite"`. Real, verified, not assumed from the variable change
   alone.
4. **`waitlist_signups = 0` — investigated, not a bug.** `getWaitlistDisplayCount()` (`app/waitlist.ts`)
   adds a `WAITLIST_DISPLAY_OFFSET` of 40 to the real row count for the public-facing number — the
   `count: 40` the public `/api/public/waitlist/count` endpoint returns is `40 + 0`, an intentional
   social-proof baseline, not evidence the form is broken. Confirmed the insert path genuinely works
   end-to-end with a real live test: `POST /api/public/waitlist` with a throwaway test email
   returned `{"joined":true,"position":1,"displayCount":41}` — position 1 confirms the real
   underlying count really was 0 before this test, exactly matching the DB query from earlier in
   this audit. Test row deleted immediately after (`DELETE FROM waitlist_signups WHERE
   email = 'audit-test-2026-07-17@weeber.ai'`, confirmed 1 row removed, count back to 40/0). So:
   the backend is correct and working, there have just genuinely been zero real waitlist signups
   so far — a marketing/traffic question, not an engineering one.

Verified after all four changes: `/api/health` still reports `"status": "ok"`, every provider key
still configured, compliance defaults unchanged.

---

## Follow-up #2 (same day, 2026-07-17) — capacity & concurrency

Explicitly requested after the fact: "what is our capacity, call concurrency and etc." Real
numbers pulled directly from Railway's GraphQL API and the live Postgres instance — not a load
test (none was run; see the honest limit at the end of this section), but not guessed either.

### The one number that matters most: 1 replica, in-memory session store
`serviceManifest.deploy.numReplicas` is **1** (confirmed via the deployment metadata API, Singapore
region). `REDIS_URL` is unset (confirmed in the original env-var audit above), which means
`session-store.ts` is running its in-memory `Map` backend, not the Redis-backed one from ADR-026.
**This is the real structural ceiling, not CPU or memory** — per `docs/configuration.md`'s own
"Scaling to multiple instances" section, an outbound call triggered on instance A whose webhook
then lands on instance B won't find its session. Today that's a non-issue only because there's
exactly one instance. **The system cannot horizontally scale past this single container without
first setting `REDIS_URL`** — that's a config flag away (no code change needed, per ADR-026), but
it hasn't been flipped, so right now "capacity" means "whatever one container can do," full stop.

### Compute ceiling (Railway container limits — confirmed via API, not inferred)
- **8 vCPU, 8 GB memory, 1000 PID limit** — this is Railway's container ceiling for this service
  (`serviceInstanceLimits` query), not a guarantee of dedicated capacity, but the real cap this
  single replica can burst up to.
- **Real current usage, last 24h:** CPU averaging ~0.01 vCPU (roughly 0.1% of the 8-vCPU ceiling),
  peaking barely above that. Memory averaging ~0.26 GB, peaking at ~0.75 GB out of 8 GB. This is
  essentially idle-baseline (Bun runtime + open connections overhead) — **not a meaningful
  concurrency data point**, because real call volume has been extremely low (10 calls total, ever,
  per the DB row count earlier in this doc). There is no real-traffic data to extrapolate a true
  concurrency ceiling from yet.
- The call pipeline itself (`stream.ts`) is I/O-bound per call, not compute-heavy — no local
  ML inference, audio encode/decode is lightweight mu-law/PCM16 conversion (see
  `voice/audio-codec.ts`), the actual work (STT/LLM/TTS) happens on the provider side over the
  network. This architecturally favors many concurrent calls per vCPU compared to a
  compute-bound workload — but "architecturally favors" is not the same as a measured number.

### Database connection pool — the most likely real bottleneck before CPU/memory
- `database/index.ts`'s `postgres()` client is created with **no explicit `max` connection count**
  — `postgres-js`'s default is **10 connections** per client instance. With 1 replica, that's a
  hard ceiling of 10 concurrent DB connections from the whole API process.
- The underlying Postgres instance itself: `max_connections = 60` (confirmed via `SHOW
  max_connections` against the live DB), currently ~15 active (Supabase's own internal
  connections + this app's idle pool) — plenty of headroom on the *Postgres* side, the tighter
  constraint is the **application's own unconfigured pool size (10)**, not the database's ceiling.
- Every real call does multiple DB round-trips over its lifetime (call row insert/update,
  transcript insert per turn, `capturedState` update per `captureField` call, latency row writes,
  the new `providerFailoverCount` update on a failover) — under real concurrent load, 10 shared
  connections across every simultaneous call is the single most likely thing to queue/bottleneck
  before CPU or memory does. **Worth tuning `postgres(process.env.DATABASE_URL!, { prepare: false,
  max: N })` explicitly once real concurrency is a live concern** — no urgency at 10 calls total,
  but this is the first knob to turn, not vCPU/memory, if latency degrades under real load.

### Telephony provider ceiling
- **Twilio: confirmed "Full" account, status active** (queried directly via the Twilio API using
  the real production credentials) — not a trial account, so none of Twilio's trial-specific
  restrictions (verified-numbers-only, low daily caps) apply. 4 real phone numbers provisioned.
- Twilio's actual concurrent-call/API-rate ceiling for a Full account isn't something the API
  exposes directly (no `accountLimits` endpoint queried this round) — Twilio's commonly-documented
  default is a modest outbound call-creation rate (historically ~1 call/sec) unless a higher
  throughput has been explicitly requested from Twilio support for this account. **Not verified
  either way this round** — flagging as a real unknown rather than asserting a number I can't back
  up with this account's actual configured limits.
- **Application-level self-imposed cap, confirmed in code:** `OUTBOUND_CALL_RATE_LIMIT` defaults to
  **30 calls per window** (`middleware/rate-limit.ts`) — this is deliberately conservative and
  configurable, a safety guard against a runaway integration bug, not a reflection of Twilio's own
  ceiling.
- **Not checked this round:** per-provider concurrent-connection limits for Deepgram, ElevenLabs,
  Cartesia, Groq, or the AI Gateway — each has its own plan-tier concurrency caps (e.g. ElevenLabs'
  free/starter tiers cap concurrent requests) that would need checking against each account's
  actual plan/tier, not something inferable from an API key's presence alone.

### Honest bottom line
**There is no real load-test number to report** — this system has handled 10 calls total, ever,
and current resource usage (CPU/memory) reflects an idle service, not one under concurrent voice
traffic. What's real and verified: the architecture is I/O-bound (favorable for concurrency), the
DB pool (10 connections, unconfigured) is the most likely first bottleneck under real load, and the
single-replica/in-memory-session-store combination means **today's actual capacity ceiling is "one
container, however many concurrent WebSocket+provider connections that one Bun process can hold
open" — not something Railway's 8 vCPU/8GB limit will meaningfully constrain before the DB pool or
a telephony/provider-side rate limit does.** A real number requires either (a) an actual load test
against a staging environment (placing N simultaneous synthetic calls and watching where things
degrade), or (b) getting Twilio/Deepgram/ElevenLabs/Cartesia/Groq's own account-level concurrency
limits directly from their dashboards/support, neither of which was done this round.

### Concrete next steps, if real capacity numbers matter for a launch decision
1. Set an explicit `max` on the `postgres()` client (`database/index.ts`) sized to the DB's real
   `max_connections` headroom, before anything else.
2. Set `REDIS_URL` and confirm multi-replica works (ADR-026 says it's just a config flag — worth
   actually testing with 2 replicas before relying on it under real load, not just trusting the
   doc comment).
3. Ask Twilio (and each STT/TTS/LLM provider) directly what this account's actual concurrent-call/
   concurrent-connection limits are — none of this is derivable from an API key alone.
4. Only then, a real synthetic load test (N simultaneous calls against a non-production
   environment) to find where the system actually degrades first.


