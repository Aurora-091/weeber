# Configuration

## Workflows

Call outcomes can trigger automated follow-up actions — the call equivalent of an email-marketing flow
builder, defined as JSON (no dashboard needed):

```json
[{
  "name": "lead-followup",
  "onOutcome": {
    "no-answer": { "action": "retry", "delayMinutes": 60, "maxRetries": 3 },
    "not-interested": { "action": "addToDnc" },
    "interested": { "action": "webhook", "url": "https://your-n8n-instance/webhook/abc" }
  }
}]
```
Set this as the `WORKFLOWS` env var (a JSON array). The agent records the outcome via its `setDisposition`
tool; Twilio-level outcomes (no-answer/busy/failed) trigger workflows automatically even if the call never
connected. A background sweep executes due retries on its own.

## Per-number configuration

Different Twilio numbers can run different behavior without touching code, via `NUMBER_CONFIG`:
```json
{ "+15551234567": { "ttsProvider": "cartesia", "llmProvider": "groq", "maxDurationSeconds": 300 } }
```

## Agent tools

Tools live in `packages/api/src/voice/tools/`:

- `lookupInfo` — answers factual questions (stub — wire to a real KB/CRM)
- `bookAppointment` — books a real Google Calendar event once `GOOGLE_CALENDAR_ACCESS_TOKEN` is set (falls
  back to a clear "not configured" result otherwise — never pretends to book)
- `setDisposition` — records how a call ended; drives the workflow engine
- `crmSync` — syncs to whichever CRM is configured, in priority order: GoHighLevel → Salesforce → HubSpot
  (set `GOHIGHLEVEL_API_KEY`+`GOHIGHLEVEL_LOCATION_ID`, `SALESFORCE_ACCESS_TOKEN`+`SALESFORCE_INSTANCE_URL`,
  or `HUBSPOT_API_KEY` respectively)
- `captureField` — records a durable fact (email, order ID, name, etc.) as structured state — see
  [State engine](./state-engine.md)
- `setIntent` — records *why* the caller called, as soon as it's clear (distinct from the outcome)
- `hangUp` — ends the call, only alongside a spoken closing line
- `transferToHuman` — warm-transfers the call to a real person, only after telling the caller
- `sendSms` — texts the caller mid-call (checkout link, confirmation, callback number)
- `sendDtmf` — presses keys on the other side's phone menu when calling into an automated tree
- `flagGuardrailEvent` — records that the agent held a guardrail boundary this turn, alongside the
  spoken reply; writes to the `guardrail_events` audit table
- `confirmCodOrder` — records a yes/no on a cash-on-delivery order; a `false` tags and cancels the
  order via webbersh (see [contract.md](./contract.md))
- `offerCartRecoveryDiscount` — offers the merchant's pre-approved discount code for an abandoned
  checkout; the amount and the checkout it applies to are fixed by the merchant, the agent only
  decides when to offer it

Which tools an agent may call is not global — it's part of the agent frame (`voice/agent-frame.ts`),
set per org+template on the dashboard's Agents page.

## Integrations

Every integration (`packages/api/src/voice/integrations/`) is wrapped in a shared resilience layer
(`resilient-fetch.ts`) — timeout, retry with backoff, and a per-integration circuit breaker — so a slow or
down third-party API can never stall or crash a live call turn. A tripped breaker skips the network call
entirely for a cooldown window and returns a clear "temporarily skipped" result instead.

| Integration | Env vars | Used by |
|---|---|---|
| GoHighLevel | `GOHIGHLEVEL_API_KEY`, `GOHIGHLEVEL_LOCATION_ID` | `crmSync` |
| Salesforce | `SALESFORCE_ACCESS_TOKEN`, `SALESFORCE_INSTANCE_URL` | `crmSync` |
| HubSpot | `HUBSPOT_API_KEY` | `crmSync` |
| Google Calendar | `GOOGLE_CALENDAR_ACCESS_TOKEN`, `GOOGLE_CALENDAR_ID` (optional, defaults to `primary`) | `bookAppointment` |

Salesforce and Google Calendar expect an already-valid access token — OAuth/token-refresh is your own
app's responsibility, not something Weeber handles for you (see [`docs/reference/testing.md`](./testing.md) for
what is and isn't covered by tests here).

## Personas

Different Twilio numbers can run different agent personalities without a redeploy, via `AGENT_PERSONAS`:
```json
{ "+15551234567": "You are a scheduling assistant for a dental clinic. Keep it warm and brief." }
```

## Scaling to multiple instances

By default, per-call session state (`session-store.ts` — persona/provider overrides, workflow retry
metadata, in-progress `capturedState`) lives in an in-memory `Map`. That's fine, and requires zero
configuration, for a single running instance — which is almost certainly what you have if you're
self-hosting solo or for one team. It stops being enough the moment you run more than one instance behind
a load balancer: an outbound call triggered against instance A, whose Twilio webhook then lands on
instance B, won't find the session instance A set up for it.

If you do need more than one instance, set `REDIS_URL` and the session store automatically switches to a
Redis-backed implementation (ADR-026) — same interface, shared across every instance, native TTL instead
of the in-memory backend's manual sweep. Nothing else changes; this is a config flag, not a code change,
and you don't need to touch it at all if you're running a single instance.

Any Redis-compatible service works — this is a plain `REDIS_URL` connection string, no vendor lock-in.
If you don't already run Redis somewhere, [Upstash](https://upstash.com)'s free tier is the least-setup
option (serverless, no server to run yourself); a self-hosted Redis or any other managed Redis works
identically.

```bash
REDIS_URL=redis://user:password@host:6379
# or, from Upstash's dashboard:
REDIS_URL=rediss://default:<token>@<endpoint>.upstash.io:6379
```
