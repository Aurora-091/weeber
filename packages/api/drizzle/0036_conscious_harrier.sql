ALTER TABLE "calls" ADD COLUMN "stt_provider_used" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "tts_provider_used" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "llm_provider_used" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "estimated_cost_usd_cents" real;