/*
# Create org_integrations table

## Summary
Stores per-org CRM and Calendar integration credentials, replacing the unsafe global
env-var-based pattern that shares a single set of credentials across all orgs.

## New Table: org_integrations
- `id` (int, auto-increment primary key)
- `org_id` (text, NOT NULL) — references the org this integration belongs to
- `provider` (text, NOT NULL) — one of: gohighlevel, salesforce, hubspot, google_calendar
- `credentials` (jsonb, NOT NULL) — provider-specific credential fields (API keys, tokens)
- `enabled` (boolean, default true) — whether this integration is active
- `created_at` (timestamptz)
- `updated_at` (timestamptz)

## Constraints
- Unique index on (org_id, provider) — one row per org per provider

## Security
- RLS enabled
- Only service_role can access (backend-only table, no direct client access)

## Notes
1. This table is accessed exclusively by the backend (packages/api) via the service role key.
2. The credentials JSON shape varies by provider:
   - gohighlevel: { "api_key": "..." }
   - salesforce: { "access_token": "..." }
   - hubspot: { "api_key": "..." }
   - google_calendar: { "access_token": "...", "calendar_id": "..." }
3. Credentials should be rotated/refreshed by the org owner via the app UI.
*/

CREATE TABLE IF NOT EXISTS org_integrations (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id text NOT NULL,
  provider text NOT NULL,
  credentials jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS org_integrations_org_provider_idx
  ON org_integrations (org_id, provider);

ALTER TABLE org_integrations ENABLE ROW LEVEL SECURITY;

-- Backend-only table: no anon/authenticated access. Only service_role (used by packages/api) can read/write.
DROP POLICY IF EXISTS "service_role_full_access" ON org_integrations;
CREATE POLICY "service_role_full_access" ON org_integrations
  FOR ALL TO service_role USING (true) WITH CHECK (true);
