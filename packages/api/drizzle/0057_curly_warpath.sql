CREATE TABLE IF NOT EXISTS "demo_widget_rate_limit_windows" (
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"call_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "demo_widget_rate_limit_windows_scope_key_pk" PRIMARY KEY("scope","key")
);
--> statement-breakpoint
ALTER TABLE "consent_records" ADD COLUMN IF NOT EXISTS "ip_address" text;--> statement-breakpoint
ALTER TABLE "consent_records" ADD COLUMN IF NOT EXISTS "user_agent" text;