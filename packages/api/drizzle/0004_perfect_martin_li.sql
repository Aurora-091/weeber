ALTER TABLE "org_agent_configs" ADD COLUMN IF NOT EXISTS "name" text;--> statement-breakpoint
ALTER TABLE "org_agent_configs" ADD COLUMN IF NOT EXISTS "greeting_line" text;--> statement-breakpoint
ALTER TABLE "org_agent_configs" ADD COLUMN IF NOT EXISTS "closing_line" text;--> statement-breakpoint
ALTER TABLE "org_agent_configs" ADD COLUMN IF NOT EXISTS "tone_style" text;--> statement-breakpoint
ALTER TABLE "org_agent_configs" ADD COLUMN IF NOT EXISTS "voice_provider" text;--> statement-breakpoint
ALTER TABLE "org_agent_configs" ADD COLUMN IF NOT EXISTS "voice_id" text;--> statement-breakpoint
ALTER TABLE "org_agent_configs" ADD COLUMN IF NOT EXISTS "language" text;--> statement-breakpoint
ALTER TABLE "org_agent_configs" ADD COLUMN IF NOT EXISTS "llm_provider" text;--> statement-breakpoint
ALTER TABLE "org_agent_configs" ADD COLUMN IF NOT EXISTS "llm_model" text;--> statement-breakpoint
ALTER TABLE "org_agent_configs" ADD COLUMN IF NOT EXISTS "tools_enabled" jsonb;--> statement-breakpoint
ALTER TABLE "org_agent_configs" ADD COLUMN IF NOT EXISTS "guardrails" jsonb;