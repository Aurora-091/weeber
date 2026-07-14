CREATE TABLE "turn_latency" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "turn_latency_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"call_id" integer NOT NULL,
	"turn_index" integer NOT NULL,
	"llm_ttft_ms" integer,
	"tts_first_byte_ms" integer,
	"voice_to_voice_ms" integer,
	"captured_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "turn_latency" ADD CONSTRAINT "turn_latency_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "turn_latency_call_id_idx" ON "turn_latency" USING btree ("call_id");--> statement-breakpoint
CREATE INDEX "turn_latency_captured_at_idx" ON "turn_latency" USING btree ("captured_at");