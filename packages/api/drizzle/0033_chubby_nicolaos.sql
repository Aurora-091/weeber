ALTER TABLE "calls" ADD COLUMN "provider_failover_count" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "org_agent_configs" ADD COLUMN "stt_fallback_order" jsonb;--> statement-breakpoint
ALTER TABLE "org_agent_configs" ADD COLUMN "tts_fallback_order" jsonb;--> statement-breakpoint
ALTER TABLE "org_agent_configs" ADD COLUMN "llm_fallback_models" jsonb;