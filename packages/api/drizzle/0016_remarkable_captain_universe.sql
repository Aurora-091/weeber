DO $$ BEGIN
 ALTER TABLE "platform_admins" ADD CONSTRAINT "platform_admins_role_check" CHECK ("platform_admins"."role" in ('superadmin', 'admin', 'support', 'finance', 'developer'));
EXCEPTION
 WHEN duplicate_object OR invalid_table_definition OR duplicate_table THEN null;
END $$;