ALTER TABLE "orgs" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "last_activity_at" timestamp with time zone DEFAULT now() NOT NULL;