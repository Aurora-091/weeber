-- D2 fix (audit #01): callerMemory GDPR erasure was scoped by phoneNumber
-- only, so an erasure request from one org could delete another org's
-- memory of the same phone number. This migration adds org_id and makes
-- the primary key (org_id, phone_number) so memory (and its erasure) is
-- correctly scoped per org. No production data exists yet (ADR-034), so
-- this is a clean structural change rather than an additive-only one.
ALTER TABLE "caller_memory" ADD COLUMN IF NOT EXISTS "org_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "caller_memory" DROP CONSTRAINT IF EXISTS "caller_memory_pkey";--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "caller_memory" ADD CONSTRAINT "caller_memory_org_id_phone_number_pk" PRIMARY KEY("org_id","phone_number");
EXCEPTION
 WHEN duplicate_object OR invalid_table_definition OR duplicate_table THEN null;
END $$;