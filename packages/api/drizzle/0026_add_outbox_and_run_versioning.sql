CREATE TABLE IF NOT EXISTS "twilio_status_events" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "twilio_status_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"call_sid" text NOT NULL,
	"status" text NOT NULL,
	"processed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webhook_outbox" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "webhook_outbox_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"org_id" text,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"target_url" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"next_retry_at" timestamp with time zone NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone NOT NULL,
	"delivered_at" timestamp with time zone,
	"alerted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "twilio_status_events_sid_status_idx" ON "twilio_status_events" USING btree ("call_sid","status");