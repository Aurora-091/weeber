# Infra resources & capacity

What this project actually runs on, the real numbers behind it, and the reasoning for how it
scales from here — written after Audit #7 (`audit/2026-07-17-audit-07-live-infra.md`) gave this
project its first real (not source-only) look at production. Pin-pointed facts below are cited
against a source (an API query, a file, a doc) — nothing here is guessed.

## Current infra, service by service

| Service | Provider | Specifics |
|---|---|---|
| Hosting | Railway (project `weeber-backend`, environment `production`) | Region: Singapore (`sin`). 1 service (`api`), `start:railway` runs `drizzle-kit migrate` then the server on every deploy — confirmed actually happening (Audit #7: local migration journal matches production's `__drizzle_migrations` table exactly, including columns added same-day). Deploys require manual approval (a safety gate on this project) before going live. **Plan: currently on-demand/Hobby-class limits (see below); a Pro-plan upgrade is planned, not yet applied — see "Railway Pro upgrade" section.** |
| Compute ceiling | Railway container limits | **8 vCPU, 8 GB memory, 1000 PID limit** (`serviceInstanceLimits` API, confirmed 2026-07-17, pre-Pro-upgrade). Vertical scaling within that ceiling is automatic — Railway bursts CPU/memory on its own as load increases, no config needed. |
| Replicas | Railway (`numReplicas`) | **1**, manually set (not auto-scaled — Railway's horizontal scaling is a manual dial, confirmed via their own docs: "Railway does not support sticky sessions" and replica count is a service-settings value, not traffic-driven). |
| Database | Supabase-hosted Postgres, accessed via `DATABASE_URL` (pooled, transaction-mode, port 6543) | `max_connections = 60` on the underlying instance (confirmed via `SHOW max_connections`), ~15 active at idle baseline (mostly Supabase's own internal connections). 37 tables, exact match between `schema.ts` and the live DB (Audit #7). |
| DB client pool (app-side) | `postgres-js` via `database/index.ts` | **Fixed 2026-07-17** — was unconfigured (postgres-js default of 10), now explicit via `DATABASE_POOL_MAX` (default 20 if unset). Important nuance: `DATABASE_URL` uses port 6543, Supavisor's transaction-mode pooler — this value is this ONE replica's client-side connection count *to the pooler*, not a direct 1:1 cap on real Postgres backend connections (the pooler multiplexes many client connections onto a smaller, separately-limited set of backend connections). The real cross-replica math once horizontal scaling is turned on: `(replica count) × DATABASE_POOL_MAX` must stay under Supavisor's own client-connection ceiling for the active Supabase compute tier — see "Supabase compute tier" below, that ceiling has NOT been directly queried (needs Supabase's management API/dashboard, not SQL). |
| Session store | In-memory `Map` (`session-store.ts`) by default; Redis-backed if `REDIS_URL` is set (ADR-026) | `REDIS_URL` is **not set today** — confirmed in Audit #7's env-var cross-reference. This is fine at 1 replica; see "Scaling beyond one instance" below for why it matters the moment that changes. |
| Auth | Supabase Auth | JWKS-based verification (`app/middleware/supabase-auth.ts`), cached 10 min. No shared-secret (`SUPABASE_JWT_SECRET`) needed or set — this is the modern/correct path, not a gap. |
| File storage for knowledge-base docs | **None — corrected from a stale claim.** | `docs/product-infra-and-gtm-report.md`'s Part 2 table says "S3-compatible (`S3_ENDPOINT`/`S3_BUCKET`)" for KB uploads — checked directly against `knowledge-base.ts`: documents are chunked and embedded straight into Postgres (`knowledge_chunks`/`knowledge_documents`), no object storage client anywhere in that file. `SUPABASE_KB_BUCKET` was a dead env var from an earlier design (removed from Railway in Audit #7's follow-up). `S3_ENDPOINT`/`S3_BUCKET`/`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` in `.env.example` are similarly unused today. |
| Telephony | Twilio (platform + BYO), Plivo (BYO), Exotel (BYO, India) | Twilio: **confirmed "Full" account, status active** (queried Twilio's own API with production credentials, 2026-07-17) — not a trial account, no trial-specific caps apply. 4 real phone numbers provisioned. Plivo: real hangup/transfer wired this session, matches Plivo's documented API, not yet live-call-verified (no real account/call in this sandbox). Exotel: hangup/transfer intentionally NOT implemented — no confirmed REST endpoint for an already-connected call in Exotel's public docs. |
| STT | Deepgram, Sarvam, ElevenLabs (Scribe v2 Realtime) | Per-agent configurable, cross-provider failover live (`voice/failover.ts`) — default chain deepgram → elevenlabs → sarvam. |
| TTS | ElevenLabs, Cartesia, Sarvam | Per-agent configurable, cross-provider failover live — default chain cartesia → elevenlabs → sarvam. |
| LLM | AI Gateway (model-agnostic) | **`LLM_PROVIDER=gateway`** as of 2026-07-17 (was `groq`) — switched specifically to activate cross-provider LLM failover (`AI_GATEWAY_FALLBACK_MODELS=openai/gpt-5.4-mini,groq/llama-3.3-70b-versatile`), verified live via `/api/health`: `activeModel` is now `gateway/google/gemini-3.1-flash-lite`. Trades away some of Groq's raw speed for real cross-vendor redundancy — a deliberate tradeoff, not free. |
| Email | Resend | Waitlist, auth emails. |
| CRM integrations | HubSpot, Salesforce, GoHighLevel, Google Calendar | Resilient-fetch wrapped (timeout/retry/circuit-breaker), see `voice/integrations/*.ts`. |
| Cross-repo contract | `weebersh` (separate Shopify OAuth/webhook bridge repo) | `WEEBERSH_APP_URL`/`WEEBER_INTERNAL_SECRET`. |

## Current real capacity — measured, not estimated

Pulled directly from Railway's metrics API for the 24h window ending 2026-07-17 (Audit #7):

- **CPU:** averaging ~0.01 vCPU (~0.1% of the 8-vCPU ceiling), never meaningfully spiking above that.
- **Memory:** averaging ~0.26 GB, peaking ~0.75 GB out of the 8 GB ceiling.
- **Real call volume, all-time:** 10 calls, 85 transcripts, 9 orgs, 3 configured agents (`org_agent_configs`).

**Honest read of these numbers: there is no real load-test data here.** This is an idle-baseline
service, not one that's ever handled concurrent voice traffic. Any capacity ceiling below this
point is architectural reasoning, not a measured result — flagged as such, not asserted as fact.

## Supabase compute tier — the real ceiling if Railway scales up alone

Queried directly against the live Postgres instance (2026-07-17), since Supabase's actual
plan/billing tier isn't visible from `DATABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` alone (that
needs Supabase's own Management API with a separate personal access token, not obtained this
round — noted as a real gap, not inferred around):

| Setting | Value | What it implies |
|---|---|---|
| `max_connections` | 60 | Matches Supabase's smallest compute tier (their free/Micro-class sizing). |
| `shared_buffers` | 256 MB | Consistent with a ~1 GB-class instance — again, the smallest tier, not a mid/large compute add-on. |
| `effective_cache_size` | ~768 MB | Same story — small instance. |
| Postgres version | 17.6 | Current, not a version concern. |
| Database size | 14 MB | Trivially small — no storage pressure at all right now. |

**Why this matters for the Railway Pro plan specifically:** Railway Pro offers up to 42 replicas at
24 vCPU/24 GB each — real, substantial compute headroom. But every one of those replicas would
still be sharing the *same* Supabase Postgres instance, currently sized for a single small app, not
dozens of concurrent replicas. Raising Railway's replica count without also upgrading Supabase's
compute add-on doesn't unlock real capacity — it just means more app instances contending for the
same small database. **The two need to scale together, not independently.** Whatever real replica
count is eventually decided, verify Supabase's own pooler client-connection ceiling for the target
compute tier at the same time (via Supabase's dashboard/support — not derivable from SQL alone).

## Known bottlenecks, in the order they'd actually bite

1. **DB connection pool — fixed 2026-07-17.** Was unconfigured (postgres-js default of 10); now
   explicit via `DATABASE_POOL_MAX` (default 20), see the DB client pool row above for the
   pooler-multiplexing nuance and the cross-replica math that still needs revisiting once real
   replica counts are decided.
2. **Supabase compute tier** — currently sized for a single small app (60 max_connections, ~1GB
   instance class), not for the replica counts Railway's Pro plan would allow. Must scale together
   with any Railway replica increase — see "Supabase compute tier" above. Not yet upgraded.
3. **Single replica + in-memory session store** — not a bottleneck at 1 replica (today's reality),
   but a hard wall the moment anyone tries to scale horizontally without first setting `REDIS_URL`.
   See "Scaling beyond one instance" below.
4. **Provider-side concurrency limits (unverified)** — Deepgram/ElevenLabs/Cartesia/Groq/AI Gateway
   each have their own plan-tier concurrent-connection caps. Not checked this round — not
   inferable from an API key's presence, needs each provider's actual account/plan info.
5. **Twilio's own concurrent-call ceiling (unverified)** — confirmed the account is "Full" (not
   trial), but Twilio's API doesn't expose this account's actual concurrent-call/API-rate limit
   directly; would need to ask Twilio support or check their dashboard.

## Scaling beyond one instance — the actual reasoning, and the alternatives considered

**The core problem, precisely:** the in-memory session `Map` lives in the RAM of one Bun process.
If a second replica existed, a request for an in-flight call could land on a *different* replica
than the one holding that call's session (e.g. a Twilio status webhook arriving after the call was
placed by a different instance) — that replica wouldn't see it. This is a real distributed-systems
problem, not a Railway-specific quirk, and it exists on any platform running 2+ stateful instances
without a shared state layer.

**Options weighed (2026-07-17 discussion), in order of fit for this project's current stage:**

1. **Set `REDIS_URL`, stay on Railway (recommended default).** Per ADR-026 this is a pure config
   change, zero code changes — a shared external key-value store every replica can read/write.
   Upstash's free tier is the natural pick (serverless, nothing to run). **Caveat, not yet
   resolved:** ADR-026's "just a config flag" claim has never actually been tested with 2+ replicas
   under real load in this project — worth verifying before trusting it at the moment it matters.
2. **Store this session state in Postgres instead of adding Redis.** Since Supabase is already the
   system of record, this ephemeral state could live there too — slightly higher per-lookup latency
   than Redis, but one fewer service to operate. A legitimate simpler alternative if avoiding a new
   dependency matters more than the latency difference (irrelevant at current call volume either
   way).
3. **Sticky sessions / session affinity (route a call's requests to the same replica, sidestep
   shared state entirely).** **Not available on Railway** — confirmed directly against Railway's
   own docs ("Railway does not support sticky sessions nor report the usage of the individual
   replicas"). Would require leaving Railway to get this.
4. **Fly.io.** The strongest managed-platform alternative *specifically for this problem* — its
   `fly-replay` header feature is built exactly for pinning a session to a machine/region and
   routing subsequent requests there. Worth considering if this project ever outgrows Railway
   specifically because of session-affinity needs — not recommended as a move right now.
5. **EC2 (or raw AWS).** **Does not solve this problem by itself.** Running 2 EC2 instances behind
   a load balancer has the identical in-memory-state issue unless you separately add ElastiCache
   (AWS's managed Redis) or configure ALB sticky sessions — i.e. you'd still need option 1 or 3's
   equivalent, just self-managed. In exchange you take on everything Railway currently does for
   free: patching, deploy pipeline, the migrations-on-deploy behavior already confirmed working,
   health checks, TLS. For a single-founder, pre-launch product, that's real ongoing operational
   burden with no corresponding benefit for *this specific problem*. Not recommended unless some
   other reason (cost at real scale, a specific AWS service need, data-residency requirement) drives
   a platform move independently of this.

**Bottom line:** there is no scaling problem to solve today (10 calls total, ~0.1% CPU). The DB pool
is now tuned (above). When real scale is needed, the order is: (1) set `REDIS_URL` and actually
test it with 2+ replicas before trusting it, (2) upgrade Supabase's compute tier in tandem with any
Railway replica increase — see "Supabase compute tier" above, (3) get real concurrency limits
directly from Twilio/each AI provider, (4) only then a real synthetic load test. EC2 is not on that
path unless something unrelated to this specific issue pushes a platform migration.

## Railway Pro plan — planned upgrade, not yet applied (2026-07-17)

Plan is to move from the current (Hobby-class) Railway plan to Pro. Real specs, as given:

| Spec | Pro plan |
|---|---|
| Monthly usage credit | $20 included, pay-as-you-go beyond that |
| Compute ceiling per service | Up to 1,000 vCPU / 1 TB RAM |
| Replicas | Up to 42, at up to 24 vCPU / 24 GB RAM each |
| Storage | Up to 1 TB |
| Seats | Unlimited workspace seats |
| Support | Railway Support included |
| Availability target | 99.99% |
| Log retention | 30 days |
| Regions | Concurrent global regions (multi-region replicas) |

**What this actually unlocks vs. what it doesn't, on its own:**
- Real compute headroom and the option to run multiple replicas across regions — genuinely useful
  once this project has real concurrent call volume to justify it (today: 10 calls total, ~0.1% of
  the *current, smaller* container ceiling — nowhere close to needing this yet).
- **Does NOT, by itself, fix the in-memory session-store problem** — going from 1 to N replicas
  on Pro still needs `REDIS_URL` set first (see "Scaling beyond one instance"), or every replica
  above the first is a real correctness risk (a call's session invisible to whichever replica a
  later request lands on), not just a missed-optimization.
- **Does NOT, by itself, fix the Supabase ceiling** — see "Supabase compute tier" above. Upgrading
  only Railway while Supabase stays on its current ~60-connection, ~1GB-class tier means the new
  replica/compute headroom can't actually be used before the database becomes the limiting factor.
- **Multi-region replicas specifically** add a further wrinkle beyond same-region horizontal
  scaling: cross-region requests to the same Supabase instance (which lives in one region) add
  real network latency — worth confirming which region(s) any real deployment would use relative
  to where Supabase's project actually lives before spreading replicas globally.

**Recommended sequencing once the Pro upgrade happens:** don't just raise the replica dial. In
order: (1) confirm/upgrade Supabase's compute tier to match the intended real concurrency, (2) set
`REDIS_URL`, (3) raise replicas incrementally (e.g. 1 → 2 first) and actually verify session
continuity holds under a real test call before going further, (4) only then consider multi-region.

## Sources
- `audit/2026-07-17-audit-07-live-infra.md` — the original live-infra audit + same-day follow-ups
  (env var actions, capacity/concurrency analysis).
- `docs/india-telephony.md` — Plivo/Exotel provider status, what's confirmed vs. unconfirmed.
- `docs/configuration.md`'s "Scaling to multiple instances" section — the `REDIS_URL`/ADR-026
  mechanics.
- `DECISIONS.md` ADR-026 (Redis-backed session storage) and ADR-034 (Supabase Postgres decision).
