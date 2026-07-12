-- platform_admins existed in the schema (added alongside admin SSO,
-- 2026-07-12) but was never captured in a Drizzle migration — it was applied
-- directly against Supabase via supabase/migrations/20260712090141_create_platform_admins.sql
-- (same class of gap as platform_settings, see 0014). IF NOT EXISTS keeps
-- this safe on databases where that migration already ran.
CREATE TABLE IF NOT EXISTS "platform_admins" (
	"email" text PRIMARY KEY NOT NULL,
	"role" text DEFAULT 'superadmin' NOT NULL,
	"added_at" timestamp with time zone NOT NULL
);
