-- platform_settings existed in the schema but was never captured in a
-- migration (it was applied via `db:push` in dev). IF NOT EXISTS keeps this
-- safe on databases where push already created it. The recovered_amount type
-- change below is the intended F4 fix (text -> numeric).
--
-- USING clause added retroactively (2026-07-15): text -> numeric has no
-- implicit Postgres cast, so the original bare ALTER COLUMN here could never
-- have succeeded against a genuinely fresh database with any actual text in
-- the column (confirmed by reproducing the exact error locally) — it only
-- ever "worked" in production because that column had already drifted to
-- numeric via a separate `db:push` before this file's ALTER ran, making it a
-- harmless numeric-to-numeric precision change instead of a real text cast.
-- NULLIF(..., '') treats empty-string values (recoveredAmount starts as
-- Shopify webhook text, parsed defensively elsewhere — see
-- org-queries.test.ts) as NULL rather than an invalid numeric literal.
--
-- Wrapped in a type-check guard (2026-07-15, same pass): re-running this
-- exact statement a second time against a column that's already numeric
-- (i.e. this migration already applied) fails differently — NULLIF's ''
-- comparand can't itself be cast to numeric once the column is no longer
-- text, "invalid input syntax for type numeric: \"\"" — reproduced locally
-- doing a full disaster-recovery replay (wipe drizzle's tracking table,
-- re-run every migration against an already-migrated database). Only
-- attempt the conversion while the column is still actually text.
CREATE TABLE IF NOT EXISTS "platform_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 IF (SELECT data_type FROM information_schema.columns WHERE table_name = 'scheduled_calls' AND column_name = 'recovered_amount') = 'text' THEN
  ALTER TABLE "scheduled_calls" ALTER COLUMN "recovered_amount" SET DATA TYPE numeric(12, 2) USING (NULLIF("recovered_amount", '')::numeric(12, 2));
 END IF;
END $$;