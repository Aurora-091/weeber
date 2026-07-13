ALTER TABLE "org_agent_configs" ADD COLUMN "first_call_delay_minutes" integer;--> statement-breakpoint
ALTER TABLE "org_agent_configs" ADD COLUMN "retry_delay_minutes" integer;--> statement-breakpoint
ALTER TABLE "org_agent_configs" ADD COLUMN "max_attempts" integer;