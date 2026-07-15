/*
# Create webhook_outbox table for reliable event delivery

## Summary
Implements the outbox pattern for merchant webhook delivery. Events are persisted
durably before delivery is attempted, with automatic retry and dead-letter handling.
Replaces the fire-and-forget fetch() in webhooks.ts that permanently lost events
on any delivery failure.

## New Table: webhook_outbox
- `id` (integer, auto-increment primary key)
- `org_id` (text) — the org that owns this webhook event
- `event_type` (text, NOT NULL) — e.g. call.completed, call.transcript, call.tool_call
- `payload` (jsonb, NOT NULL) — the event data to deliver
- `target_url` (text, NOT NULL) — the merchant's webhook endpoint
- `status` (text, NOT NULL, default 'pending') — pending/delivering/delivered/failed/dead
- `attempts` (integer, default 0) — number of delivery attempts made
- `max_attempts` (integer, default 5) — give up after this many failures
- `next_retry_at` (timestamptz) — when to next attempt delivery (exponential backoff)
- `last_error` (text) — most recent delivery failure message
- `created_at` (timestamptz, NOT NULL)
- `delivered_at` (timestamptz) — when successfully delivered
- `alerted_at` (timestamptz) — when the merchant was alerted about failure (null = not yet)

## Indexes
- Status + next_retry_at for the delivery worker's claim query
- Org_id for merchant-facing webhook log queries

## Security
- RLS enabled
- Only service_role can access (backend-only table)

## Notes
1. Delivery worker claims rows using the same CAS pattern as the scheduler
   (UPDATE ... SET status='delivering' WHERE status='pending' AND next_retry_at <= now()).
2. Dead-letter events (attempts >= max_attempts) surface as alerts to the merchant.
3. Retention: delivered rows older than 7 days can be pruned by a periodic cleanup.
*/

CREATE TABLE IF NOT EXISTS webhook_outbox (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id text,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  target_url text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  next_retry_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  alerted_at timestamptz
);

CREATE INDEX IF NOT EXISTS webhook_outbox_delivery_idx
  ON webhook_outbox (status, next_retry_at)
  WHERE status IN ('pending', 'failed');

CREATE INDEX IF NOT EXISTS webhook_outbox_org_idx
  ON webhook_outbox (org_id, created_at DESC);

ALTER TABLE webhook_outbox ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_full_access" ON webhook_outbox;
CREATE POLICY "service_role_full_access" ON webhook_outbox
  FOR ALL TO service_role USING (true) WITH CHECK (true);
