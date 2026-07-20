CREATE TABLE "outbound_rate_limit_windows" (
	"org_id" text PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"call_count" integer DEFAULT 0 NOT NULL
);
