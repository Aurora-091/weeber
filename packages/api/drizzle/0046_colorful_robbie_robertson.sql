ALTER TABLE "calls" ADD COLUMN "health_status" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "health_reasons" jsonb;--> statement-breakpoint
CREATE INDEX "calls_health_status_idx" ON "calls" USING btree ("health_status");