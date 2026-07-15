CREATE TABLE IF NOT EXISTS "org_agent_configs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "org_agent_configs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"org_id" text NOT NULL,
	"template_key" text NOT NULL,
	"persona_prompt" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "outbound_number" text;--> statement-breakpoint
ALTER TABLE "scheduled_calls" ADD COLUMN IF NOT EXISTS "checkout_token" text;--> statement-breakpoint
ALTER TABLE "scheduled_calls" ADD COLUMN IF NOT EXISTS "recovered_order_id" text;--> statement-breakpoint
ALTER TABLE "scheduled_calls" ADD COLUMN IF NOT EXISTS "recovered_amount" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "org_agent_configs" ADD CONSTRAINT "org_agent_configs_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object OR invalid_table_definition OR duplicate_table THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "org_agent_configs_org_key_idx" ON "org_agent_configs" USING btree ("org_id","template_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scheduled_calls_checkout_token_idx" ON "scheduled_calls" USING btree ("checkout_token");