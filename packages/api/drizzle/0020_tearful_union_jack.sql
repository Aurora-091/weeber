ALTER TABLE "org_agent_configs" ADD COLUMN IF NOT EXISTS "first_call_delay_minutes" integer;--> statement-breakpoint
ALTER TABLE "org_agent_configs" ADD COLUMN IF NOT EXISTS "retry_delay_minutes" integer;--> statement-breakpoint
ALTER TABLE "org_agent_configs" ADD COLUMN IF NOT EXISTS "max_attempts" integer;