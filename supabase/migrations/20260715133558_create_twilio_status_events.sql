/*
# Create twilio_status_events table for idempotency

## Summary
Prevents duplicate processing of Twilio status-callback webhooks. Twilio delivers
these at-least-once — a redelivered terminal status (completed/failed/busy/no-answer)
was previously causing double workflow advancement with reset retry-count state.

## New Table: twilio_status_events
- `id` (integer, auto-increment primary key)
- `call_sid` (text, NOT NULL) — Twilio CallSid
- `status` (text, NOT NULL) — the CallStatus value (completed, failed, busy, etc.)
- `processed_at` (timestamptz, NOT NULL) — when we first processed this status

## Constraints
- Unique index on (call_sid, status) — prevents reprocessing the same status

## Security
- RLS enabled
- Only service_role can access (backend-only table)

## Notes
1. Pattern mirrors integrations/shopify/idempotency.ts — check unique constraint before
   processing, return 200 immediately on duplicate.
2. Old rows can be cleaned up periodically (call_sids older than 7 days are safe to delete).
*/

CREATE TABLE IF NOT EXISTS twilio_status_events (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  call_sid text NOT NULL,
  status text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS twilio_status_events_sid_status_idx
  ON twilio_status_events (call_sid, status);

ALTER TABLE twilio_status_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_full_access" ON twilio_status_events;
CREATE POLICY "service_role_full_access" ON twilio_status_events
  FOR ALL TO service_role USING (true) WITH CHECK (true);
