ALTER TABLE "waitlist_signups" ADD COLUMN "own_referral_code" text;--> statement-breakpoint
ALTER TABLE "waitlist_signups" ADD COLUMN "referral_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "waitlist_signups" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "waitlist_signups" ADD COLUMN "unsubscribed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "waitlist_signups" ADD COLUMN "unsubscribe_token" text;--> statement-breakpoint
ALTER TABLE "waitlist_signups" ADD CONSTRAINT "waitlist_signups_own_referral_code_unique" UNIQUE("own_referral_code");--> statement-breakpoint
ALTER TABLE "waitlist_signups" ADD CONSTRAINT "waitlist_signups_unsubscribe_token_unique" UNIQUE("unsubscribe_token");