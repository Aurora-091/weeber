ALTER TABLE "orgs" ADD COLUMN "twilio_mode" text DEFAULT 'platform' NOT NULL;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "twilio_account_sid" text;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "twilio_auth_token" text;