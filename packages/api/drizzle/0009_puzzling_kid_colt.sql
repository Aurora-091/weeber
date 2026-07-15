ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "twilio_mode" text DEFAULT 'platform' NOT NULL;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "twilio_account_sid" text;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "twilio_auth_token" text;