/*
# Create platform_settings table

1. New Tables
  - `platform_settings` — generic key-value store for platform-level configuration
    - `key` (text, primary key) — setting identifier (e.g. 'gtm_container_id', 'ga4_measurement_id')
    - `value` (text, nullable) — the setting value, null means unset
    - `updated_at` (timestamptz) — last modification time

2. Security
  - Enable RLS on `platform_settings`.
  - Allow service_role full access (backend reads/writes via service key).
  - Allow anon + authenticated SELECT for the public tracking-config endpoint.

3. Notes
  - This table is managed exclusively by admins via the backend API.
  - The frontend reads it via a public API endpoint, not directly via Supabase client.
  - Generic design: any future platform-level setting can use this table without a migration.
*/

CREATE TABLE IF NOT EXISTS platform_settings (
  key text PRIMARY KEY,
  value text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE platform_settings ENABLE ROW LEVEL SECURITY;

-- Service role has full access (backend uses service role key)
DROP POLICY IF EXISTS "service_role_all" ON platform_settings;
CREATE POLICY "service_role_all" ON platform_settings FOR ALL
  TO service_role USING (true) WITH CHECK (true);

-- Public read access (anon can read settings for the tracking-config endpoint)
DROP POLICY IF EXISTS "anon_select_platform_settings" ON platform_settings;
CREATE POLICY "anon_select_platform_settings" ON platform_settings FOR SELECT
  TO anon, authenticated USING (true);

-- Seed initial tracking keys
INSERT INTO platform_settings (key, value, updated_at) VALUES
  ('gtm_container_id', null, now()),
  ('ga4_measurement_id', null, now())
ON CONFLICT (key) DO NOTHING;
