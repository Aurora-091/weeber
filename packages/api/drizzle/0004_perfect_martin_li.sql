ALTER TABLE "org_agent_configs" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "org_agent_configs" ADD COLUMN "greeting_line" text;--> statement-breakpoint
ALTER TABLE "org_agent_configs" ADD COLUMN "closing_line" text;--> statement-breakpoint
ALTER TABLE "org_agent_configs" ADD COLUMN "tone_style" text;--> statement-breakpoint
ALTER TABLE "org_agent_configs" ADD COLUMN "voice_provider" text;--> statement-breakpoint
ALTER TABLE "org_agent_configs" ADD COLUMN "voice_id" text;--> statement-breakpoint
ALTER TABLE "org_agent_configs" ADD COLUMN "language" text;--> statement-breakpoint
ALTER TABLE "org_agent_configs" ADD COLUMN "llm_provider" text;--> statement-breakpoint
ALTER TABLE "org_agent_configs" ADD COLUMN "llm_model" text;--> statement-breakpoint
ALTER TABLE "org_agent_configs" ADD COLUMN "tools_enabled" jsonb;--> statement-breakpoint
ALTER TABLE "org_agent_configs" ADD COLUMN "guardrails" jsonb;