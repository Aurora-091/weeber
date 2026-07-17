# Security

- **Ops endpoints require an admin key.** `GET/POST /calls`, `/dnc`, `/callers`, `/webhooks/test` all check
  the `X-OpenVent-Admin-Key` header against `ADMIN_API_KEY`. If `ADMIN_API_KEY` is unset, these endpoints run
  unauthenticated with a loud startup warning — fine for local testing, **not fine for anything public**.
  Set `ADMIN_API_KEY` and send it as a header on every ops request:
  ```bash
  curl -H "X-OpenVent-Admin-Key: $ADMIN_API_KEY" {PUBLIC_APP_URL}/api/voice/calls
  ```
- **Twilio webhooks are signature-verified.** `/incoming`, `/status-callback`, and `/recording-status`
  validate the `X-Twilio-Signature` header against `TWILIO_AUTH_TOKEN` using Twilio's official signing
  scheme — a request that doesn't come from Twilio (or is missing/forged the signature) is rejected with
  `403` before any call/database logic runs. This prevents forged webhook calls from corrupting call
  records or triggering workflow actions (e.g. a fake "not-interested" outcome auto-adding a number to DNC).
- **Outbound calls are rate-limited** (`OUTBOUND_CALL_RATE_LIMIT`, default 30/minute) — a basic
  fixed-window guard against a leaked key or integration bug placing a runaway number of calls. This is on
  top of, not instead of, the compliance calling-window/DNC checks.
- **SMS is wired to real delivery.** Workflow actions that send an SMS (e.g. a follow-up text after a
  missed call) go through `twilioClient.messages.create()` — this used to be a stub that only logged.
  Failures are caught and logged per-recipient; they don't crash the workflow run.
- **Retry attempts are actually capped now.** Each workflow action can define `maxRetries`; the scheduler
  tracks `previousAttempt` and refuses to schedule another retry once `nextAttempt > maxRetries`.
- **National DNC registry: adapter only, not a live sync.** `packages/openvent-compliance/src/national-dnc.ts`
  defines `syncNationalDncRegistry` and a `NationalRegistryFetcher` interface so a real registry (e.g. the
  US National DNC Registry, which requires a SAN — Subscription Account Number — to query) can be plugged
  in later. It currently ships with `noopNationalRegistryFetcher`, i.e. it's a documented stub, not a
  working integration. Wire in a real fetcher before relying on this for legal compliance beyond the app's
  own DNC list.

## Tunneling / going public

For anything beyond local testing, your app needs a public URL Twilio can reach.

- **Quick tunnel (default, zero-account).** `scripts/tunnel-supervisor.sh` runs `cloudflared`'s free quick
  tunnel, restarts it on crash, and auto-updates `PUBLIC_APP_URL` + the Twilio Voice webhook whenever the
  tunnel's (rotating) URL changes. This is what runs out of the box — good for development and this
  project's current pre-launch phase.
- **Named Cloudflare Tunnel (optional, for a stable public domain).** Gives you a fixed hostname instead of
  a rotating one. Requires either your DNS zone to actually live on Cloudflare, or Cloudflare's Partial
  (CNAME) Setup — which is no longer self-serve on the free tier as of this writing (see
  [`DECISIONS.md`](../DECISIONS.md) ADR-013/ADR-014 for what was tried and why it was reverted). Worth
  setting up once you have a real reason for a stable domain (real user traffic, a production launch), not
  before.
