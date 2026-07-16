CREATE TABLE "consent_records" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "consent_records_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"org_id" text NOT NULL,
	"data_principal" text NOT NULL,
	"purpose" text NOT NULL,
	"granted" boolean DEFAULT true NOT NULL,
	"granted_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"version" text NOT NULL,
	"channel" text NOT NULL,
	"source" text NOT NULL,
	"withdrawn_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "consent_records_org_principal_purpose_idx" ON "consent_records" USING btree ("org_id","data_principal","purpose");