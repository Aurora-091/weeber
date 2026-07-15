ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "telephony_provider" text DEFAULT 'twilio' NOT NULL;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "plivo_auth_id" text;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "plivo_auth_token" text;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "exotel_sid" text;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "exotel_api_key" text;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "exotel_api_token" text;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "exotel_subdomain" text;