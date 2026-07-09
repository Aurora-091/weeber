import { resilientCall } from "./resilient-fetch";

/**
 * HubSpot CRM integration — upsert a contact by phone number and log a call
 * engagement. Wrapped in `resilientCall` (timeout + retry + circuit breaker)
 * so a slow or down HubSpot never stalls a live call turn — see
 * ./resilient-fetch.ts for why that matters.
 */
export type HubspotSyncResult =
  | { synced: true; contactId: string | null }
  | { synced: false; message: string };

export async function syncToHubspot(
  phoneNumber: string,
  callerName: string | undefined,
  notes: string,
): Promise<HubspotSyncResult> {
  const apiKey = process.env.HUBSPOT_API_KEY;
  if (!apiKey) {
    return { synced: false, message: "(not configured) HUBSPOT_API_KEY not set — no real CRM connected." };
  }

  const result = await resilientCall(
    async (signal) => {
      const contactRes = await fetch("https://api.hubapi.com/crm/v3/objects/contacts", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          properties: { phone: phoneNumber, firstname: callerName ?? "Unknown caller" },
        }),
        signal,
      });
      const contact = (await contactRes.json().catch(() => null)) as any;

      await fetch("https://api.hubapi.com/crm/v3/objects/calls", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          properties: { hs_call_body: notes, hs_call_direction: "INBOUND", hs_timestamp: Date.now() },
        }),
        signal,
      });

      return (contact?.id as string | undefined) ?? null;
    },
    { integration: "hubspot" },
  );

  if (!result.ok) {
    return { synced: false, message: `HubSpot sync failed: ${result.message}` };
  }
  return { synced: true, contactId: result.data };
}
