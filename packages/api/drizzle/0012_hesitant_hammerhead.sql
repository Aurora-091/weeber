ALTER TABLE "orgs" ADD COLUMN "telephony_provider" text DEFAULT 'twilio' NOT NULL;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "plivo_auth_id" text;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "plivo_auth_token" text;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "exotel_sid" text;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "exotel_api_key" text;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "exotel_api_token" text;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "exotel_subdomain" text;