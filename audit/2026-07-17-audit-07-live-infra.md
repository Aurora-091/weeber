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
