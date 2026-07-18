# Changelog — undated reference sections

> Non-dated summary sections from the original changelog (completed workstreams, schema modifications, API/param updates). Kept together for reference.

## Completed Backend Workstreams

| Workstream | Module / Component | Focus / Goal | Core Changes & Files |
| :--- | :--- | :--- | :--- |
| **Workstream A** | Config & Seeding | Database-backed agent template config overrides & hierarchical prompt resolution | - Created `agent_templates` and `org_agent_configs` tables<br>- Idempotent catalog seeder inside `seed.ts` executing at boot<br>- Hierarchical lookup logic inside `agent.ts`<br>- Dynamic voice stream prompt loading |
| **Workstream J** | Webhook Cancellation | Cancel pending Shopify cart-recovery scheduled calls by `checkoutToken` first | - Added `checkout_token` column & index to `scheduled_calls`<br>- Populated token on webhooks and workflow retry engines<br>- Cancel by token with fallback to phone in `/orders/create` |
| **Workstream K** | Order Attribution | Matching executed recovery calls with orders within 7-day conversion window | - Populates `recovered_order_id` and `recovered_amount` on successful order conversion webhooks |
| **Workstream L & M** | Scoped GDPR Erasure | Erasure of Shopify customer data and GDPR Edge function notification | - Scoped Drizzle deletions inside `adapters.ts` (calls, transcripts, callerMemory)<br>- Protected edge function call using `resilientCall` inside `/customers/redact` |
| **Workstream N** | Per-Org Outbound Caller ID | Dynamic resolution of outbound dial-time caller ID | - Added `outbound_number` to `orgs` table<br>- Gated POST `/calls/outbound` and scheduler sweeps to resolve phone number priority |

---

## Database Schema Modifications

| Table Name | Column Name | Data Type | Modifiers / Indexing / Description |
| :--- | :--- | :--- | :--- |
| **`orgs`** | `outbound_number` | `text` | Org-specific outbound Twilio dial-time phone number |
| **`scheduled_calls`** | `checkout_token` | `text` | Shopify cart token; indexed for checkout match performance |
| **`scheduled_calls`** | `recovered_order_id` | `text` | Shopify converted order ID |
| **`scheduled_calls`** | `recovered_amount` | `text` | Converted checkout amount |
| **`agent_templates`** | *New Table* | - | Static catalog of Shopify agent prompt configurations |
| **`org_agent_configs`**| *New Table* | - | Organization specific prompt overrides matching templates |

---

## API & Parameter Updates

- **POST `/calls/outbound`**:
  - Accept optional parameter `orgId` (string) in JSON body payload.
  - Automatically sets Twilio outbound caller ID parameter to the org's configured `outboundNumber` if present, with TWILIO_PHONE_NUMBER env fallback.
- **POST `/integrations/shopify/orders/create`**:
  - Validates `checkout_token` along with `phone` to identify recovery opportunities.
- **POST `/integrations/shopify/customers/redact`**:
  - Erases all customer recordings/transcripts within the organization bounds, and fires the `gdpr-redact-notify` edge function.

---
