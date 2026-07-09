import z from "zod";
import { tool } from "ai";
import { syncToGoHighLevel } from "../integrations/gohighlevel";
import { syncToSalesforce } from "../integrations/salesforce";
import { syncToHubspot } from "../integrations/hubspot";

/**
 * CRM integration — upserts a contact and logs a call engagement mid-
 * conversation, for when the agent needs to act on CRM data live during the
 * call (complementing, not replacing, the generic outbound webhook system
 * used for after-the-fact sync via n8n/Zapier).
 *
 * Tries whichever CRM is actually configured, in this priority order:
 * GoHighLevel -> Salesforce -> HubSpot. This order follows what came up most
 * in community feedback (GoHighLevel specifically was named repeatedly as a
 * tool this audience already runs). Each integration lives in
 * ../integrations/ and is wrapped in the shared resilience layer
 * (../integrations/resilient-fetch.ts) — a slow/down CRM degrades to a clear
 * "not synced" result instead of stalling or crashing the call.
 *
 * None configured -> a plain "no CRM connected" result, same as before.
 */
export const crmSync = tool({
  description:
    "Log this call to the CRM and create or update the caller's contact record. Use this once you have " +
    "the caller's name and enough context to be worth recording — not on every turn.",
  inputSchema: z.object({
    callerName: z.string().optional(),
    phoneNumber: z.string(),
    notes: z.string().describe("Brief summary of what this call was about"),
  }),
  async execute({ callerName, phoneNumber, notes }) {
    if (process.env.GOHIGHLEVEL_API_KEY) {
      const result = await syncToGoHighLevel(phoneNumber, callerName, notes);
      return { crm: "gohighlevel", ...result };
    }
    if (process.env.SALESFORCE_ACCESS_TOKEN) {
      const result = await syncToSalesforce(phoneNumber, callerName, notes);
      return { crm: "salesforce", ...result };
    }
    if (process.env.HUBSPOT_API_KEY) {
      const result = await syncToHubspot(phoneNumber, callerName, notes);
      return { crm: "hubspot", ...result };
    }
    return {
      crm: null,
      synced: false,
      message:
        "(not configured) No CRM connected — set GOHIGHLEVEL_API_KEY, SALESFORCE_ACCESS_TOKEN, or HUBSPOT_API_KEY.",
    };
  },
});
