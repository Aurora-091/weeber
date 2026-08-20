CREATE TABLE "tool_call_latency" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tool_call_latency_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"call_id" integer NOT NULL,
	"tool_name" text NOT NULL,
	"tool_call_id" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"duration_ms" integer,
	"success" boolean,
	"timed_out" boolean,
	"captured_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tool_call_latency" ADD CONSTRAINT "tool_call_latency_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tool_call_latency_call_id_idx" ON "tool_call_latency" USING btree ("call_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_call_latency_tool_call_id_idx" ON "tool_call_latency" USING btree ("tool_call_id");