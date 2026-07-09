import { resilientCall } from "./resilient-fetch";

/**
 * GoHighLevel (a.k.a. "GHL", "LeadConnector") CRM integration — came up
 * repeatedly in community feedback as a tool this audience already runs
 * day to day, so it's one of the first pre-built integrations shipped
 * (see ROADMAP.md). Upserts a contact by phone number and logs a call note.
 *
 * GHL's v2 API is namespaced under a "location" (sub-account) — both
 * GOHIGHLEVEL_API_KEY and GOHIGHLEVEL_LOCATION_ID are required. Wrapped in
 * resilientCall like every other integration — see ./resilient-fetch.ts.
 */
export type GoHighLevelSyncResult =
  | { synced: true; contactId: string | null }
  | { synced: false; message: string };

export async function syncToGoHighLevel(
  phoneNumber: string,
  callerName: string | undefined,
  notes: string,
): Promise<GoHighLevelSyncResult> {
  const apiKey = process.env.GOHIGHLEVEL_API_KEY;
  const locationId = process.env.GOHIGHLEVEL_LOCATION_ID;
  if (!apiKey || !locationId) {
    return {
      synced: false,
      message: "(not configured) GOHIGHLEVEL_API_KEY / GOHIGHLEVEL_LOCATION_ID not set — no real CRM connected.",
    };
  }

  const result = await resilientCall(
    async (signal) => {
      const contactRes = await fetch("https://services.leadconnectorhq.com/contacts/upsert", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Version: "2021-07-28",
        },
        body: JSON.stringify({
          locationId,
          phone: phoneNumber,
          firstName: callerName ?? "Unknown caller",
        }),
        signal,
      });
      const contact = (await contactRes.json().catch(() => null)) as any;
      const contactId = (contact?.contact?.id as string | undefined) ?? null;

      if (contactId) {
        await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/notes`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            Version: "2021-07-28",
          },
          body: JSON.stringify({ body: notes }),
          signal,
        });
      }

      return contactId;
    },
    { integration: "gohighlevel" },
  );

  if (!result.ok) {
    return { synced: false, message: `GoHighLevel sync failed: ${result.message}` };
  }
  return { synced: true, contactId: result.data };
}
