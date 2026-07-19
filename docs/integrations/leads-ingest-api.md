# Leads Ingest API

**The one inbound contract for the native leads layer.** Every external lead source — a web form, a client's CRM, a Pipedream workflow, a Facebook Lead Ad — POSTs to the same endpoint. Get a lead in with one call; no source is special-cased.

> Design: `docs/product-strategy/native-leads-layer-plan-2026-07-19.md` §7. Router: `packages/api/src/voice/leads/ingest.ts`.

---

## Endpoint

```
POST /api/leads/ingest
```

### Auth — per-org API key

Send a per-org lead API key one of two ways:

```
Authorization: Bearer wlk_xxxxxxxxxxxx
```
or
```
X-Api-Key: wlk_xxxxxxxxxxxx
```

- Keys are prefixed `wlk_`, hashed at rest (sha256), and scoped to **exactly one org**. A request can only ever write to the org the key belongs to — the payload cannot name a different org.
- Manage keys in the app: **Leads → API keys** (create / list / revoke). The full key is shown **once** at creation — store it then.
- A leaked key affects one org, is revocable, and can't read any org's data (ingest is write-only).

### Request body

```jsonc
{
  "phone": "+15551234567",   // REQUIRED. Normalize to E.164 for reliable dedup.
  "name": "Jane Doe",         // optional
  "fields": {                  // optional — validated against the org's intake schema
    "city": "Pune",
    "product_interest": "health",
    "best_callback_time": "evening"
  },
  "source": "form",           // optional — one of: form | webhook | pipedream | crm | manual
  "externalId": "typeform-abc123", // optional — echoed back for your reconciliation
  "triggerWorkflow": false    // optional — accepted but NOT wired yet (see below)
}
```

Notes:
- **`phone` is the dedup key** (with the key's org). Sending a phone that already exists **merges** into that lead — it never duplicates.
- **`source`** defaults to `webhook` when absent/unknown. An external caller can **never** claim `source: "call"` — that's reserved for in-process agent-call promotion.
- **`fields`** are validated against the org's intake schema (`resolveIntakeSchema` — per-org/per-agent override, else the vertical default). Unknown keys are dropped; **regulated keys are rejected** (see Compliance).

### Response

`201 Created` on a new lead, `200 OK` when it merged into an existing one:

```jsonc
{
  "ok": true,
  "leadId": 4821,
  "created": true,
  "externalId": "typeform-abc123",        // echoed if you sent it
  "rejectedRegulated": ["pan_number"],     // present only if you sent regulated keys
  "droppedUnknown": ["favourite_colour"],  // present only if you sent unknown keys
  "note": "triggerWorkflow is not yet supported — ..." // present only if you sent triggerWorkflow
}
```

### Errors

| Status | When |
|---|---|
| `401` | Missing API key / invalid or revoked key |
| `400` | Body isn't a JSON object, or `phone` missing/blank |

---

## Idempotency

Idempotency is guaranteed by the **`(orgId, phone)` upsert**: a retrying source that sends the same phone converges on the same `leadId` instead of creating duplicates. You do **not** need `externalId` for this — it's echoed purely for your own reconciliation and is **not stored** in v1.

---

## Compliance — regulated fields are blocked on every path

The ingest endpoint enforces the **same regulatory boundary as the agents**. These are rejected write-side, before anything is stored: SSN, PAN, Aadhaar, bank/card, full DOB, health condition, exact policy financials.

- Rejected keys are returned in `rejectedRegulated` **by key name only** — their **values are never logged or echoed back**.
- This holds for *every* source (form, CRM, Pipedream, webhook) — the native layer can't become a backdoor that collects what agents are forbidden to.

---

## `triggerWorkflow` (accepted, not yet wired)

`triggerWorkflow` is part of the contract so integrators can code against it now, but in v1 it does **not** place a call. An ingest-triggered call must first respect the same **DNC / TCPA / quiet-hours** dial-gates as agent-initiated calls. Until that's wired, the endpoint acknowledges the flag with a `note` rather than silently dialing ungated. Poll/read leads and drive calls from the app in the meantime.

---

## Example

```bash
curl -X POST https://app.weeber.ai/api/leads/ingest \
  -H "Authorization: Bearer wlk_live_xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "+15551234567",
    "name": "Jane Doe",
    "fields": { "city": "Pune", "product_interest": "health" },
    "source": "form",
    "externalId": "web-2026-07-19-001"
  }'
```

## Related

- Hosted intake form (no API key, public) — `/f/:orgId`, backed by `GET/POST /api/public/leads/:orgId/form`. A thin, honeypot- and rate-limited client of this same ingest core.
- Pipedream inbound recipe — `./pipedream-inbound-recipe.md`.
- Outbound (leads → CRM) — the "Sync to CRM" mirror, on-demand only; `packages/api/src/voice/leads/crm-mirror.ts`.
