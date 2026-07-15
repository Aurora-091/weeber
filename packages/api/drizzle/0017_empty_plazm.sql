CREATE TABLE IF NOT EXISTS "support_replies" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "support_replies_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"ticket_id" integer NOT NULL,
	"message" text NOT NULL,
	"sent_by" text NOT NULL,
	"email_sent" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "support_replies" ADD CONSTRAINT "support_replies_ticket_id_support_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object OR invalid_table_definition OR duplicate_table THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_replies_ticket_id_idx" ON "support_replies" USING btree ("ticket_id");