ALTER TABLE "scheduled_calls" ADD COLUMN "last_block_reason" text;--> statement-breakpoint
ALTER TABLE "scheduled_calls" ADD COLUMN "last_block_detail" text;--> statement-breakpoint
ALTER TABLE "scheduled_calls" ADD COLUMN "blocked_at" timestamp with time zone;