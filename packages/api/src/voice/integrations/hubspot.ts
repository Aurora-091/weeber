import { resilientCall } from "./resilient-fetch";

export type HubspotSyncResult =
  | { synced: true; contactId: string | null }
  | { synced: false; message: string };

export async function syncToHubspot(
  phoneNumber: string,
  callerName: string | undefined,
  notes: string,
  apiKeyOverride?: string,
): Promise<HubspotSyncResult> {
  const apiKey = apiKeyOverride || process.env.HUBSPOT_API_KEY;
  if (!apiKey) {
    return {
      synced: false,
      message: "(not configured) No HubSpot API key provided.",
    };
  }

  const result = await resilientCall(
    async (signal) => {
      const searchRes = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          filterGroups: [
            { filters: [{ propertyName: "phone", operator: "EQ", value: phoneNumber }] },
          ],
        }),
        signal,
      });
      const searchData = (await searchRes.json().catch(() => null)) as any;
      let contactId = (searchData?.results?.[0]?.id as string) ?? null;

      if (!contactId) {
        const createRes = await fetch("https://api.hubapi.com/crm/v3/objects/contacts", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            properties: {
              phone: phoneNumber,
              firstname: callerName ?? "Unknown caller",
            },
          }),
          signal,
        });
        const created = (await createRes.json().catch(() => null)) as any;
        contactId = (created?.id as string) ?? null;
      }

      if (contactId && notes) {
        await fetch("https://api.hubapi.com/crm/v3/objects/notes", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            properties: { hs_note_body: notes, hs_timestamp: new Date().toISOString() },
            associations: [
              { to: { id: contactId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }] },
            ],
          }),
          signal,
        });
      }

      return contactId;
    },
    { integration: "hubspot" },
  );

  if (!result.ok) {
    return { synced: false, message: `HubSpot sync failed: ${result.message}` };
  }
  return { synced: true, contactId: result.data };
}
