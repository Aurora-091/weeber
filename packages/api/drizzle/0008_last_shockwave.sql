ALTER TABLE "waitlist_signups" ADD COLUMN IF NOT EXISTS "own_referral_code" text;--> statement-breakpoint
ALTER TABLE "waitlist_signups" ADD COLUMN IF NOT EXISTS "referral_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "waitlist_signups" ADD COLUMN IF NOT EXISTS "phone" text;--> statement-breakpoint
ALTER TABLE "waitlist_signups" ADD COLUMN IF NOT EXISTS "unsubscribed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "waitlist_signups" ADD COLUMN IF NOT EXISTS "unsubscribe_token" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "waitlist_signups" ADD CONSTRAINT "waitlist_signups_own_referral_code_unique" UNIQUE("own_referral_code");
EXCEPTION
 WHEN duplicate_object OR invalid_table_definition OR duplicate_table THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "waitlist_signups" ADD CONSTRAINT "waitlist_signups_unsubscribe_token_unique" UNIQUE("unsubscribe_token");
EXCEPTION
 WHEN duplicate_object OR invalid_table_definition OR duplicate_table THEN null;
END $$;