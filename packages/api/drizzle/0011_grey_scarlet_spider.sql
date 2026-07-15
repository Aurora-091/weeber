CREATE TABLE IF NOT EXISTS "onboarding_state" (
	"org_id" text PRIMARY KEY NOT NULL,
	"steps" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dismissed" boolean DEFAULT false NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "org_workflow_configs" (
	"org_id" text NOT NULL,
	"template_key" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"overrides" jsonb,
	CONSTRAINT "org_workflow_configs_org_id_template_key_pk" PRIMARY KEY("org_id","template_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workflow_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text,
	"template_key" text NOT NULL,
	"context" jsonb NOT NULL,
	"current_node_id" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"next_run_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workflow_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"vertical" text NOT NULL,
	"name" text NOT NULL,
	"graph" jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "webhook_url" text;--> statement-breakpoint
ALTER TABLE "scheduled_calls" ADD COLUMN IF NOT EXISTS "workflow_run_id" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "onboarding_state" ADD CONSTRAINT "onboarding_state_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object OR invalid_table_definition OR duplicate_table THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_runs_org_id_idx" ON "workflow_runs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_runs_status_next_run_at_idx" ON "workflow_runs" USING btree ("status","next_run_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_runs_template_key_idx" ON "workflow_runs" USING btree ("template_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calls_org_id_idx" ON "calls" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scheduled_calls_org_id_idx" ON "scheduled_calls" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scheduled_calls_status_run_at_idx" ON "scheduled_calls" USING btree ("status","run_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scheduled_calls_workflow_run_id_idx" ON "scheduled_calls" USING btree ("workflow_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transcripts_call_id_idx" ON "transcripts" USING btree ("call_id");