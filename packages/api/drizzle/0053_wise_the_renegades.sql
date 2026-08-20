ALTER TABLE "turn_latency" ADD COLUMN "llm_input_tokens" integer;--> statement-breakpoint
ALTER TABLE "turn_latency" ADD COLUMN "llm_cached_input_tokens" integer;--> statement-breakpoint
ALTER TABLE "turn_latency" ADD COLUMN "llm_output_tokens" integer;