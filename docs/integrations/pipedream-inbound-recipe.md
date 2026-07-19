# Pipedream Inbound Recipe — any app → Weeber leads

A ready-to-activate template that turns **any of Pipedream's 1000s of supported apps** (Typeform, Google Sheets, a CRM, a Facebook Lead Ad, Calendly, …) into a lead source for Weeber — without us writing a per-source adapter.

> **Pipedream lives on the inbound *edge*, never in the middle.** It just calls our owned `ingest` contract. The `leads` table is the data-of-record; Pipedream is one of many callers. See `docs/product-strategy/native-leads-layer-plan-2026-07-19.md` §9.

---

## When to use this

Reach for Pipedream only when a client's leads originate in a tool we don't natively cover and don't want to build an adapter for. For a plain web form, prefer the **hosted intake form** (`/f/:orgId`) or a direct POST to `/api/leads/ingest` — no third party in the path.

---

## Prerequisites

1. A Weeber **lead API key** for the org — create it in the app under **Leads → API keys** (prefix `wlk_`). Copy it once at creation.
2. A Pipedream account (Connect is SOC 2 Type II / HIPAA-BAA / GDPR — fine for the edge, but **never route regulated fields through it**; the ingest schema blocks them regardless).

---

## The recipe (2 steps)

**Trigger** — the source app's "new record" event, e.g.:
- *Typeform* → "New Submission"
- *Google Sheets* → "New Row Added"
- *Facebook Lead Ads* → "New Lead"
- *Calendly* → "Invitee Created"

**Action** — "HTTP / Webhook → POST", configured as:

```
Method:  POST
URL:     https://app.weeber.ai/api/leads/ingest
Headers:
  Authorization: Bearer wlk_YOUR_KEY
  Content-Type:  application/json
Body (map trigger fields → these keys):
{
  "phone": "{{steps.trigger.event.phone}}",
  "name":  "{{steps.trigger.event.name}}",
  "source": "pipedream",
  "externalId": "{{steps.trigger.event.id}}",
  "fields": {
    "city": "{{steps.trigger.event.city}}",
    "product_interest": "{{steps.trigger.event.interest}}"
  }
}
```

That's it. Weeber validates `fields` against the org's intake schema, deduplicates by phone, and returns the `leadId`.

---

## Mapping tips

- **Always map `phone`** and normalize to **E.164** (`+15551234567`) in a small Pipedream code step if the source gives a local format — dedup keys on it.
- Set **`source: "pipedream"`** so leads are attributed correctly on the Leads page.
- Pass the source record's id as **`externalId`** for your own reconciliation (it's echoed back; not stored).
- Only map keys that exist in the org's **intake schema** — unknown keys are dropped, and regulated keys (PAN/Aadhaar/SSN/bank/full DOB/health) are rejected and returned in `rejectedRegulated` (by name only).

---

## Idempotency & retries

Pipedream retries are safe: ingest upserts by `(orgId, phone)`, so a retried event converges on the same lead instead of creating a duplicate. No dedup logic needed on the Pipedream side.

---

## Testing the recipe

1. In Pipedream, use the trigger's "Generate Test Event".
2. Run the HTTP step — expect `201` (new) or `200` (merged) with `{ "ok": true, "leadId": ... }`.
3. Confirm the lead appears on the Weeber **Leads** page with source **Pipedream**.

If the endpoint is being tested standalone (no Pipedream), the ingest API has full curl/unit coverage — see `./leads-ingest-api.md`.

## Related

- `./leads-ingest-api.md` — the underlying contract (auth, body, responses, compliance).
