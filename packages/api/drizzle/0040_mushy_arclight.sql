CREATE TABLE "lead_api_keys" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "lead_api_keys_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"org_id" text NOT NULL,
	"label" text NOT NULL,
	"key_hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "lead_api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "lead_intake_schemas" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "lead_intake_schemas_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"org_id" text NOT NULL,
	"agent_id" integer,
	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "leads_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"org_id" text NOT NULL,
	"phone" text NOT NULL,
	"name" text,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"assigned_advisor_id" integer,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_activity_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "lead_id" integer;--> statement-breakpoint
CREATE INDEX "lead_api_keys_org_id_idx" ON "lead_api_keys" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lead_intake_schemas_org_agent_idx" ON "lead_intake_schemas" USING btree ("org_id","agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "leads_org_phone_idx" ON "leads" USING btree ("org_id","phone");--> statement-breakpoint
CREATE INDEX "leads_org_status_idx" ON "leads" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "calls_lead_id_idx" ON "calls" USING btree ("lead_id");