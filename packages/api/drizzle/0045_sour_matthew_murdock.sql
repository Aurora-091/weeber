CREATE TABLE "guardrail_events" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "guardrail_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"call_id" integer NOT NULL,
	"org_id" text,
	"category" text NOT NULL,
	"source" text NOT NULL,
	"detail" text,
	"fired_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "guardrail_events" ADD CONSTRAINT "guardrail_events_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "guardrail_events_call_id_idx" ON "guardrail_events" USING btree ("call_id");--> statement-breakpoint
CREATE INDEX "guardrail_events_org_fired_idx" ON "guardrail_events" USING btree ("org_id","fired_at");