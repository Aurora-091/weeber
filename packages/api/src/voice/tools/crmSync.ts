import z from "zod";
import { tool } from "ai";
import { syncToGoHighLevel } from "../integrations/gohighlevel";
import { syncToSalesforce } from "../integrations/salesforce";
import { syncToHubspot } from "../integrations/hubspot";
import { db } from "../../database";
import { orgIntegrations } from "../../database/schema";
import { eq, and } from "drizzle-orm";

async function getOrgCrmCredentials(orgId: string): Promise<{
  provider: "gohighlevel" | "salesforce" | "hubspot";
  credentials: Record<string, string>;
} | null> {
  const providers = ["gohighlevel", "salesforce", "hubspot"] as const;
  for (const provider of providers) {
    const [row] = await db
      .select()
      .from(orgIntegrations)
      .where(and(eq(orgIntegrations.orgId, orgId), eq(orgIntegrations.provider, provider), eq(orgIntegrations.enabled, true)))
      .limit(1);
    if (row && row.credentials) {
      return { provider, credentials: row.credentials as Record<string, string> };
    }
  }
  return null;
}

export function createCrmSyncTool(orgId: string | undefined) {
  return tool({
    description:
      "Log this call to the CRM and create or update the caller's contact record. Use this once you have " +
      "the caller's name and enough context to be worth recording — not on every turn.",
    inputSchema: z.object({
      callerName: z.string().optional(),
      phoneNumber: z.string(),
      notes: z.string().describe("Brief summary of what this call was about"),
    }),
    async execute({ callerName, phoneNumber, notes }) {
      if (!orgId) {
        return {
          crm: null,
          synced: false,
          message: "(not configured) No org context — cannot look up CRM credentials.",
        };
      }

      const crmConfig = await getOrgCrmCredentials(orgId);
      if (!crmConfig) {
        return {
          crm: null,
          synced: false,
          message: "(not configured) No CRM connected for this organization. Connect one in Settings > Integrations.",
        };
      }

      const { provider, credentials } = crmConfig;
      switch (provider) {
        case "gohighlevel": {
          const result = await syncToGoHighLevel(phoneNumber, callerName, notes, credentials.api_key, credentials.location_id);
          return { crm: "gohighlevel", ...result };
        }
        case "salesforce": {
          const result = await syncToSalesforce(phoneNumber, callerName, notes, credentials.access_token, credentials.instance_url);
          return { crm: "salesforce", ...result };
        }
        case "hubspot": {
          const result = await syncToHubspot(phoneNumber, callerName, notes, credentials.api_key);
          return { crm: "hubspot", ...result };
        }
      }
    },
  });
}

export const crmSync = createCrmSyncTool(undefined);
