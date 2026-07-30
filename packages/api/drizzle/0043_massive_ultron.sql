CREATE TABLE "opt_out_events" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "opt_out_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"call_id" integer NOT NULL,
	"org_id" text,
	"phone_number" text NOT NULL,
	"trigger_phrase" text,
	"fired_at" timestamp with time zone NOT NULL,
	"dnc_propagated_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "disclosure_fired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "opt_out_events" ADD CONSTRAINT "opt_out_events_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "opt_out_events_call_id_idx" ON "opt_out_events" USING btree ("call_id");--> statement-breakpoint
CREATE INDEX "opt_out_events_phone_number_idx" ON "opt_out_events" USING btree ("phone_number");