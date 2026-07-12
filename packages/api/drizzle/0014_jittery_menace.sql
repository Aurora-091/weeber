-- platform_settings existed in the schema but was never captured in a
-- migration (it was applied via `db:push` in dev). IF NOT EXISTS keeps this
-- safe on databases where push already created it. The recovered_amount type
-- change below is the intended F4 fix (text -> numeric).
CREATE TABLE IF NOT EXISTS "platform_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scheduled_calls" ALTER COLUMN "recovered_amount" SET DATA TYPE numeric(12, 2);