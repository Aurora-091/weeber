import { resilientCall } from "./resilient-fetch";

export type GoHighLevelSyncResult =
  | { synced: true; contactId: string | null }
  | { synced: false; message: string };

export async function syncToGoHighLevel(
  phoneNumber: string,
  callerName: string | undefined,
  notes: string,
  apiKey?: string,
  locationId?: string,
): Promise<GoHighLevelSyncResult> {
  if (!apiKey) {
    return {
      synced: false,
      message: "(not configured) No GoHighLevel API key provided.",
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
          locationId: locationId ?? undefined,
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
