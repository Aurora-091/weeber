/**
 * Shared CRM-credential resolution for an org.
 *
 * A single place that answers "which CRM (if any) is connected for this org,
 * and with what credentials?" — used by both the in-call crmSync tool
 * (voice/tools/crmSync.ts) and the on-demand leads CRM mirror
 * (voice/leads/crm-mirror.ts). Kept as one function so the provider priority
 * order and the `enabled` gate can never drift between the two call sites.
 *
 * Priority order is deliberate and fixed: gohighlevel → salesforce → hubspot.
 * The first enabled row with credentials wins; an org is expected to connect
 * at most one CRM.
 */
import { and, eq } from "drizzle-orm";
import { db } from "../../database";
import { orgIntegrations } from "../../database/schema";

export type CrmProvider = "gohighlevel" | "salesforce" | "hubspot";

export type OrgCrmCredentials = {
  provider: CrmProvider;
  credentials: Record<string, string>;
};

const CRM_PROVIDERS: readonly CrmProvider[] = ["gohighlevel", "salesforce", "hubspot"] as const;

/** The org's connected CRM + credentials, or null if none is enabled. */
export async function getOrgCrmCredentials(orgId: string): Promise<OrgCrmCredentials | null> {
  for (const provider of CRM_PROVIDERS) {
    const [row] = await db
      .select()
      .from(orgIntegrations)
      .where(
        and(
          eq(orgIntegrations.orgId, orgId),
          eq(orgIntegrations.provider, provider),
          eq(orgIntegrations.enabled, true),
        ),
      )
      .limit(1);
    if (row && row.credentials) {
      return { provider, credentials: row.credentials as Record<string, string> };
    }
  }
  return null;
}
