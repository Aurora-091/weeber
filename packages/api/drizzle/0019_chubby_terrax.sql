DROP INDEX "org_members_user_org_idx";--> statement-breakpoint
DROP INDEX "org_members_user_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "org_members_user_idx" ON "org_members" USING btree ("supabase_user_id");