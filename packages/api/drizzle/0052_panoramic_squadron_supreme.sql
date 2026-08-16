DROP INDEX "calls_org_id_idx";--> statement-breakpoint
DROP INDEX "scheduled_calls_org_id_idx";--> statement-breakpoint
CREATE INDEX "calls_org_id_started_at_idx" ON "calls" USING btree ("org_id","started_at");--> statement-breakpoint
CREATE INDEX "org_members_org_id_idx" ON "org_members" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "scheduled_calls_org_id_run_at_idx" ON "scheduled_calls" USING btree ("org_id","run_at");--> statement-breakpoint
CREATE INDEX "support_tickets_status_created_idx" ON "support_tickets" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "tool_calls_call_id_idx" ON "tool_calls" USING btree ("call_id");--> statement-breakpoint
CREATE INDEX "webhook_outbox_status_next_retry_idx" ON "webhook_outbox" USING btree ("status","next_retry_at");