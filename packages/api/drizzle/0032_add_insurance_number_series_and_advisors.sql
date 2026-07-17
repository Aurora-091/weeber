CREATE TABLE "insurance_advisors" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "insurance_advisors_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"npn" text,
	"licensed_states" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"lines_of_authority" jsonb,
	"source" text DEFAULT 'manual' NOT NULL,
	"last_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org_phone_numbers" ADD COLUMN "number_series" text;--> statement-breakpoint
ALTER TABLE "insurance_advisors" ADD CONSTRAINT "insurance_advisors_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "insurance_advisors_org_id_idx" ON "insurance_advisors" USING btree ("org_id");