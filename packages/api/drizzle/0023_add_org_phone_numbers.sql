CREATE TABLE "org_phone_numbers" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "org_phone_numbers_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"org_id" text NOT NULL,
	"provider" text NOT NULL,
	"phone_number" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"purchased_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org_agent_configs" ADD COLUMN "phone_number_id" integer;--> statement-breakpoint
ALTER TABLE "org_phone_numbers" ADD CONSTRAINT "org_phone_numbers_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "org_phone_numbers_org_id_idx" ON "org_phone_numbers" USING btree ("org_id");--> statement-breakpoint
ALTER TABLE "org_agent_configs" ADD CONSTRAINT "org_agent_configs_phone_number_id_org_phone_numbers_id_fk" FOREIGN KEY ("phone_number_id") REFERENCES "public"."org_phone_numbers"("id") ON DELETE set null ON UPDATE no action;