/*
# Create platform_admins table

1. New Tables
  - `platform_admins` — allowlist of admin users who can access /dashboard
    - `email` (text, primary key) — the admin's email address (must match Supabase Auth user)
    - `role` (text, default 'superadmin') — admin privilege level
    - `added_at` (timestamptz, default now()) — when the admin was added

2. Security
  - Enable RLS.
  - Only service_role can read/write (backend manages this table; never queried from frontend directly).

3. Notes
  - Admins authenticate via Supabase Auth (email/password), then the backend checks membership here.
  - The old ADMIN_API_KEY path remains valid for scripts/CI — this is additive, not a replacement.
*/

CREATE TABLE IF NOT EXISTS platform_admins (
  email text PRIMARY KEY,
  role text NOT NULL DEFAULT 'superadmin',
  added_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE platform_admins ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_all_admins" ON platform_admins;
CREATE POLICY "service_role_all_admins" ON platform_admins FOR ALL
  TO service_role USING (true) WITH CHECK (true);
