# Infra consolidation audit — Supabase / Vercel / Railway — 2026-07-18

> Not a spec, not a decision doc — a paper-trail research artifact (per this folder's convention).
> The one real decision that came out of it (adopt Supabase Realtime) is `ADR-058`, not this file.

**Question asked:** given Weeber already pays for Supabase Pro, Vercel Pro, and Railway Pro, is there
a bundle of external vendor apps that could be cancelled/consolidated onto those three platforms
instead?

## Punchline

Weeber is already one of the more tightly-consolidated stacks for a pre-launch product — someone
(Audit #7, 2026-07-17) already collapsed almost everything onto the three paid platforms. This is
less "what to add" and more "confirm what's optimal + 3 real moves."

## What's already consolidated correctly

| Need | What's actually used | Verdict |
|---|---|---|
| LLM | Vercel AI Gateway (model-agnostic + native cross-provider failover), Groq as alt | Optimal — right way to avoid single-LLM-vendor lock-in |
| Embeddings | Vercel AI Gateway (`text-embedding-3-small`) | Optimal — no separate embedding vendor |
| Vector / RAG | Postgres `pgvector` (HNSW, in Supabase) | Correct — no reason for Pinecone/Qdrant at this scale |
| File storage | None needed — KB docs are chunked+embedded straight into Postgres, no files kept | Don't need S3, Cloudinary, or Supabase Storage — the config for these is dead, see below |
| Email | Resend (silently no-ops if unset) | Correct — free tier covers pre-launch |
| Queue / background jobs | DB-backed (`scheduled_calls` table + webhook outbox) polled by in-process `setInterval` | Correct for 1 replica — no Inngest/Trigger.dev needed |
| Auth | Supabase Auth (JWKS, no shared secret) | Optimal, modern path |
| DB | Supabase Postgres (Small compute, pooled port 6543) | Correct over Railway PG — auth + pgvector in one place |
| Session state | In-memory Map, Redis optional (deferred) | Correct decision at ~10 calls total |

**Bottom line:** no bundle of external apps to cancel — already there. Weeber pays ~$65/mo
(Supabase Pro $25 + Vercel Pro $20 + Railway Pro $20) and that genuinely covers the whole surface.

## The 3 real moves

**1. Delete dead deps/config (hygiene, not cost).** Wired to nothing:
- `@aws-sdk/client-s3` and `cloudflare` in root `package.json` — zero imports in `packages/`
- `S3_ENDPOINT` / `S3_BUCKET` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` and `SUPABASE_KB_BUCKET`
  in `.env.example` — dead since the KB went pure-Postgres

Removing them shrinks install time and attack surface. No behavior change. **Not yet done** — a
follow-up cleanup pass, same shape as the confirmed-dead-code removal from earlier this session
(2026-07-18, unused frontend/backend deps + UI primitives).

**2. Error monitoring — the one genuine gap.** Errors currently go `console.error` → Railway logs
(30-day retention, no aggregation, no alerts). None of the 3 paid platforms replace real error
tracking. A voice call failing at 2am currently produces zero signal to anyone. Options, cheapest
first:
- **Sentry free tier** (5K errors/mo) — standard, works fine, $0 until real volume
- Vercel Observability — already on Pro, but only sees the *frontend*, not the Railway Hono API
  where the voice pipeline actually lives — not a substitute
- **Verdict: add Sentry free.** The only genuinely new vendor worth introducing, and it's $0.
  **Not yet done.**

**3. Vercel Pro $20 — keep it, deliberately.** The Bun server already serves the frontend in
single-deploy mode, so technically Railway alone could serve everything and Vercel Pro could be
dropped. Don't, for two reasons:
- Vercel Hobby forbids commercial use — "just downgrade" isn't legal for a real product
- The marketing site needs edge-CDN speed + SEO for the grant/investor credibility goal; Railway is
  single-region Singapore

Important: **Vercel AI Gateway bills separately (usage-based) and doesn't require Vercel hosting** —
so even if the frontend ever moved off Vercel, the Gateway relationship stays. Keep Vercel Pro, it's
earning its $20.

## On Supabase Foreign Data Wrappers (FDW) — specifically asked about

FDWs let you query an external service (Stripe, S3, another Postgres) as if it were a Postgres table.
- **Not useful now** — nothing in the current code needs to query an external API as a table.
- **One theoretical future case:** a Stripe FDW would let billing data (subscriptions/invoices) be
  read via SQL instead of syncing once billing is wired — but Stripe was already rejected for the
  Indian entity, and there's no Dodo/Razorpay wrapper. Skip it; doesn't apply here.

## What's worth turning on from platforms already paid for

- **Supabase Realtime** — the dashboard currently polls every 4-5s (`refetchInterval` on
  call-detail, calls-list, workflow-runs). `postgres_changes` would push live call updates instead:
  instant UX, less DB load, and demos far better to investors ("watch the call happen live"). Already
  paid for, not used. **Highest-value adoption here — see `ADR-058` for the actual decision.**
- **Supabase `pg_cron` + Queues (`pgmq`)** — only relevant once sweeps need to move off in-process
  `setInterval` (the day Weeber goes to 2+ replicas, so a timer doesn't double-fire). Not now, but
  it's the consolidated path when that day comes — no Inngest needed then either.
- **Supabase Vault** — for storing per-org provider keys/secrets encrypted at rest, relevant if
  merchants are ever let to BYO their own Twilio/provider keys.
- **Vercel Speed Insights / Analytics** — included-ish on Pro; worth turning on for the marketing
  site since perf + SEO directly serve the grant-credibility goal.

## Net

Not overpaying anyone. The only money question (Vercel Pro) is justified. The only *capability* gap
is error monitoring (fix: free Sentry, not yet done). The only *free upgrade sitting unused* is
Supabase Realtime (decision made, see `ADR-058`; not yet built).
