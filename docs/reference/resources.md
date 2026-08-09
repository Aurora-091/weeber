# Infra resources & capacity

What this project actually runs on, the real numbers behind it, and the reasoning for how it
scales from here — written after Audit #7 (`audit/2026-07-17-audit-07-live-infra.md`) gave this
project its first real (not source-only) look at production. Pin-pointed facts below are cited
against a source (an API query, a file, a doc) — nothing here is guessed.

## Current infra, service by service

| Service | Provider | Specifics |
|---|---|---|
| Hosting | Railway (project `weeber-backend`, environment `production`) | Region: Singapore (`sin`). 1 service (`api`), `start:railway` runs `drizzle-kit migrate` then the server on every deploy — confirmed actually happening (Audit #7: local migration journal matches production's `__drizzle_migrations` table exactly, including columns added same-day). Deploys require manual approval (a safety gate on this project) before going live. **Plan: Pro, confirmed live 2026-07-17** (container ceiling verified via API, see below). |
| Compute ceiling | Railway container limits | **24 vCPU, 24 GB memory, 1000 PID limit** (`serviceInstanceLimits` API, confirmed 2026-07-17 post-Pro-upgrade — was 8 vCPU/8GB pre-upgrade). Vertical scaling within that ceiling is automatic — Railway bursts CPU/memory on its own as load increases, no config needed. |
| Replicas | Railway (`numReplicas`) | **1, staying at 1 for now** (explicit decision 2026-07-17 — Redis dropped, see "Scaling beyond one instance" below). Not auto-scaled — Railway's horizontal scaling is a manual dial, confirmed via their own docs: "Railway does not support sticky sessions" and replica count is a service-settings value, not traffic-driven. |
| Database | Supabase-hosted Postgres, accessed via `DATABASE_URL` (pooled, transaction-mode, port 6543) | **Compute add-on: Small (2-core ARM, 2GB memory), upgraded 2026-07-17 from Micro.** `max_connections = 90` post-upgrade (confirmed via `SHOW max_connections`, was 60 on Micro). Disk: 8GB gp3, autoscaling configured (grows 50%/4GB minimum at 90% usage, up to a very high ceiling), currently 0.28GB used (~3.5%) — never a real concern. 37 tables, exact match between `schema.ts` and the live DB (Audit #7). |
| DB client pool (app-side) | `postgres-js` via `database/index.ts` | Explicit via `DATABASE_POOL_MAX` (default 20). `DATABASE_URL` uses port 6543, Supavisor's transaction-mode pooler — this value is this ONE replica's client-side connection count *to the pooler*, not a direct 1:1 cap on real Postgres backend connections. At 1 replica with Supabase now on Small, there's real headroom (20 pooled connections against a 90-connection/Small-tier pooler ceiling that's meaningfully higher than Micro's). Revisit the `(replica count) × DATABASE_POOL_MAX` math only if replicas ever go above 1. |
| Session store | In-memory `Map` (`session-store.ts`); Redis-backed if `REDIS_URL` is set (ADR-026) | **Decision 2026-07-17: staying on in-memory, not adding Redis right now.** Redis only matters once replicas > 1 — since Railway Pro's *vertical* scaling (single replica bursting to 24 vCPU/24GB) is automatic and free, and real usage is still ~10 calls total, there's no case for spending on Redis yet. Revisit only when there's a real signal one replica is genuinely saturated. |
| Auth | Supabase Auth | JWKS-based verification (`app/middleware/supabase-auth.ts`), cached 10 min. No shared-secret (`SUPABASE_JWT_SECRET`) needed or set — this is the modern/correct path, not a gap. |
| File storage for knowledge-base docs | **None — corrected from a stale claim.** | `docs/product-strategy/product-infra-and-gtm-report.md`'s Part 2 table says "S3-compatible (`S3_ENDPOINT`/`S3_BUCKET`)" for KB uploads — checked directly against `knowledge-base.ts`: documents are chunked and embedded straight into Postgres (`knowledge_chunks`/`knowledge_documents`), no object storage client anywhere in that file. `SUPABASE_KB_BUCKET` was a dead env var from an earlier design (removed from Railway in Audit #7's follow-up). `S3_ENDPOINT`/`S3_BUCKET`/`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` in `.env.example` are similarly unused today. |
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

## Supabase compute tier — upgraded 2026-07-17, tandem with Railway Pro

Confirmed both from the Supabase dashboard directly (Compute Add-on page: Small, 2-core ARM, 2GB
memory, $0.0206/hour) and independently verified against the live Postgres instance's own settings
(the dashboard label and the actual running config agree, not just taken on faith):

| Setting | Before (Micro) | After (Small, confirmed live) |
|---|---|---|
| `max_connections` | 60 | **90** |
| `shared_buffers` | 256 MB | **512 MB** |
| `effective_cache_size` | ~768 MB | **~1.5 GB** |
| `work_mem` | 3.5 MB | **5 MB** |
| Postgres version | 17.6 | 17.6 (unchanged) |
| Database size | 14 MB | trivially small, no storage pressure |
| Disk | 8 GB gp3, autoscaling configured (grows 4GB/50% at 90% usage) | 0.28 GB used (~3.5%) — never a real concern |

**Why this mattered before upgrading:** Railway Pro's replica headroom would have been wasted if
every replica were still sharing a Micro-class (1GB, 60-connection) Postgres instance — more app
instances contending for the same small database isn't real capacity. Confirmed **the org-level
"Supabase Pro" plan and the per-project "Compute Add-on" size are two separate axes** — being on
Supabase's Pro billing plan does NOT itself upgrade a project's compute size; that's a separate,
explicit per-project setting (Database/Project Settings → Compute Add-on, not the Disk Size page,
which is storage only and was not the source of this finding).

**Current decision (2026-07-17): staying at 1 Railway replica, Redis not added.** Supabase's Small
tier gives real headroom over Micro even at 1 replica; there's no case yet for horizontal scaling
or Redis given real usage (~10 calls total). If replicas are ever raised later, revisit the
`(replica count) × DATABASE_POOL_MAX` math against Supavisor's pooler client-connection ceiling for
Small (or whatever tier is active then) — not derived from SQL alone, check Supabase's docs/support
for the pooler-specific number at that time.

## Known bottlenecks, in the order they'd actually bite

1. **DB connection pool — fixed 2026-07-17.** Was unconfigured (postgres-js default of 10); now
   explicit via `DATABASE_POOL_MAX` (default 20), see the DB client pool row above for the
   pooler-multiplexing nuance.
2. **Supabase compute tier — upgraded 2026-07-17.** Micro → Small in tandem with the Railway Pro
   upgrade, real headroom confirmed live (see "Supabase compute tier" above). Not a bottleneck at
   1 replica.
3. **Single replica + in-memory session store — accepted, not fixed, by explicit decision
   2026-07-17.** Redis was considered and deliberately dropped for now: Railway Pro's vertical
   scaling (this one replica bursting to 24 vCPU/24GB) is automatic and free, and real usage
   (~10 calls total) doesn't justify the added complexity/cost yet. Revisit only if real signal
   shows one replica genuinely saturated — see "Scaling beyond one instance" below for the
   options already evaluated when that day comes.
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

1. **Set `REDIS_URL`, stay on Railway.** Per ADR-026 this is a pure config change, zero code
   changes — a shared external key-value store every replica can read/write. Upstash's free tier
   is the natural pick (serverless, nothing to run). **Explicitly evaluated and deferred
   2026-07-17** — not needed yet given real usage (~10 calls total) and Railway Pro's automatic
   vertical scaling on the single existing replica; revisit only once there's a real signal one
   replica is genuinely saturated. **Caveat whenever it does happen:** ADR-026's "just a config
   flag" claim has never actually been tested with 2+ replicas under real load in this project —
   worth verifying before trusting it at the moment it matters.
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

**Bottom line, as of 2026-07-17:** Railway is on Pro, Supabase is on Small — both confirmed live.
Staying at 1 replica, no Redis, by explicit decision — real usage (~10 calls total) doesn't justify
either yet, and vertical scaling on the single replica already gives 3x the previous compute
ceiling for free. When real scale is needed later, the order is unchanged: (1) set `REDIS_URL` and
actually test it with 2+ replicas before trusting it, (2) re-check Supabase's compute tier is still
sized for the target replica count, (3) get real concurrency limits directly from Twilio/each AI
provider, (4) only then a real synthetic load test. EC2 is not on that path unless something
unrelated to this specific issue pushes a platform migration.

## Railway Pro plan — confirmed live 2026-07-17

Upgraded from the previous (Hobby-class) plan. Real specs, as given, and verified against the
actual container ceiling (`serviceInstanceLimits` API jumped from 8 vCPU/8GB to 24 vCPU/24GB
immediately after the upgrade — confirmed, not just claimed):

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

**What this unlocks vs. what it doesn't, on its own — and what was actually done:**
- Real compute headroom, confirmed: this one replica can now burst to 24 vCPU/24GB automatically,
  no config needed — that alone is a 3x jump over the pre-upgrade ceiling, with zero added
  complexity. This is the part of Pro that's actually in use today.
- The multi-replica/multi-region headroom (up to 42 replicas, concurrent global regions) is **not
  in use** — explicit decision 2026-07-17 to stay at 1 replica, since it would need `REDIS_URL`
  first (see "Scaling beyond one instance" above) and real usage doesn't justify it yet.
- The Supabase side of this **was** addressed in tandem, as planned: Supabase's compute add-on was
  upgraded from Micro to Small the same day, confirmed live (see "Supabase compute tier" above) —
  so the database isn't the artificial ceiling it would have been if only Railway had been upgraded.
- **Multi-region replicas specifically**, whenever they do get used, add a further wrinkle beyond
  same-region horizontal scaling: cross-region requests to the same (single-region) Supabase
  instance add real network latency — worth confirming which region(s) any future deployment would
  use relative to where Supabase's project actually lives before spreading replicas globally.

**If replicas are ever raised later:** set `REDIS_URL` first, raise incrementally (1 → 2 first) and
actually verify session continuity holds under a real test call before going further, re-check
Supabase's compute tier is still sized for the target concurrency, then only consider multi-region.

## Sources
- `audit/2026-07-17-audit-07-live-infra.md` — the original live-infra audit + same-day follow-ups
  (env var actions, capacity/concurrency analysis).
- `docs/voice-quality/india-telephony.md` — Plivo/Exotel provider status, what's confirmed vs. unconfirmed.
- `docs/reference/configuration.md`'s "Scaling to multiple instances" section — the `REDIS_URL`/ADR-026
  mechanics.
- `docs/decisions/` ADR-026 (Redis-backed session storage) and ADR-034 (Supabase Postgres decision).
