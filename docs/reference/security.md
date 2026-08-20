# Security

- **Ops endpoints require an admin key.** `GET/POST /calls`, `/dnc`, `/callers`, `/webhooks/test` all check
  the `X-Weeber-Admin-Key` header against `ADMIN_API_KEY`. The former name, `X-OpenVent-Admin-Key`, is still
  accepted permanently (not on a deprecation timer) so existing scripts and saved API collections keep
  working — see `voice/middleware/admin-auth.ts`. If `ADMIN_API_KEY` is unset, these endpoints run
  unauthenticated with a loud startup warning — fine for local testing, **not fine for anything public**.
  Set `ADMIN_API_KEY` and send it as a header on every ops request:
  ```bash
  curl -H "X-Weeber-Admin-Key: $ADMIN_API_KEY" {PUBLIC_APP_URL}/api/voice/calls
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
- **National DNC registry: adapter only, not a live sync.** `packages/weeber-compliance/src/national-dnc.ts`
  defines `syncNationalDncRegistry` and a `NationalRegistryFetcher` interface so a real registry (e.g. the
  US National DNC Registry, which requires a SAN — Subscription Account Number — to query) can be plugged
  in later. It currently ships with `noopNationalRegistryFetcher`, i.e. it's a documented stub, not a
  working integration. Wire in a real fetcher before relying on this for legal compliance beyond the app's
  own DNC list.

## Public reachability

Telephony webhooks and the media-stream WebSocket only work if the carrier can reach the backend, so
`PUBLIC_APP_URL` must be a real public https URL (the `wss://` stream URL is derived from it).

- **Deployed.** The API runs on Railway (`railway.json`, single instance) and the frontend on Vercel
  (`vercel.json`). `PUBLIC_APP_URL` points at the API's public hostname; each org's number webhooks are
  re-pointed at it by `POST /api/voice/orgs/:orgId/twilio/sync-webhooks`. `CORS_ALLOWED_ORIGINS` must
  list the real frontend origins — see `middleware/cors-config.ts`, which refuses to fall back to a
  permissive default in production.
- **Local development.** `PUBLIC_APP_URL=http://localhost:4200` is fine for everything except a live
  phone call: REST endpoints, the dashboards, test-chat and synthetic scenarios all work, but a real
  inbound/outbound call needs a public URL and a matching change in the carrier console. There is no
  tunnel script in this repo — `scripts/` is local-only and gitignored. Bring your own tunnel
  (`cloudflared tunnel --url http://localhost:4200`, ngrok, or equivalent), set `PUBLIC_APP_URL` to the
  hostname it prints, and update the number's "A call comes in" webhook.
- **Named Cloudflare Tunnel** was evaluated and reverted for the pre-launch phase — see
  [`docs/decisions/`](../decisions/README.md) ADR-013/ADR-014 for what was tried and why.
