CREATE INDEX IF NOT EXISTS "calls_org_id_idx" ON "calls" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transcripts_call_id_idx" ON "transcripts" USING btree ("call_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scheduled_calls_org_id_idx" ON "scheduled_calls" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scheduled_calls_status_run_at_idx" ON "scheduled_calls" USING btree ("status","run_at");