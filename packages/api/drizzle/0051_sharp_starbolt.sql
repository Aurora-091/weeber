ALTER TABLE "turn_latency" ADD COLUMN "llm_provider_used" text;--> statement-breakpoint
ALTER TABLE "turn_latency" ADD COLUMN "endpoint_signal" text;--> statement-breakpoint
ALTER TABLE "turn_latency" ADD COLUMN "endpointing_delay_ms" integer;--> statement-breakpoint
ALTER TABLE "turn_latency" ADD COLUMN "tts_socket_open_ms" integer;