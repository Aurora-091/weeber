/**
 * Admin Users list — individual accounts (org_members rows), each with
 * their org name/vertical for context. Distinct from the Orgs page (which
 * is workspace-centric): this is person-centric, matching Vocalist's real
 * admin nav split between "Users" and org-level views.
 */
import { desc, eq } from "drizzle-orm";
import { db } from "../database";
import { orgMembers, orgs } from "../database/schema";

export async function listUsers(limit = 500) {
  const bounded = Math.min(Math.max(limit, 1), 2000);
  const rows = await db
    .select({
      id: orgMembers.id,
      supabaseUserId: orgMembers.supabaseUserId,
      email: orgMembers.email,
      role: orgMembers.role,
      createdAt: orgMembers.createdAt,
      orgId: orgMembers.orgId,
      orgName: orgs.name,
      orgVertical: orgs.vertical,
    })
    .from(orgMembers)
    .innerJoin(orgs, eq(orgMembers.orgId, orgs.id))
    .orderBy(desc(orgMembers.createdAt))
    .limit(bounded);
  return rows;
}
