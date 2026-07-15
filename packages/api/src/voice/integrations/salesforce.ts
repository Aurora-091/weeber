import { resilientCall } from "./resilient-fetch";

export type SalesforceSyncResult =
  | { synced: true; contactId: string | null }
  | { synced: false; message: string };

export async function syncToSalesforce(
  phoneNumber: string,
  callerName: string | undefined,
  notes: string,
  accessTokenOverride?: string,
): Promise<SalesforceSyncResult> {
  const accessToken = accessTokenOverride || process.env.SALESFORCE_ACCESS_TOKEN;
  const instanceUrl = process.env.SALESFORCE_INSTANCE_URL || "https://login.salesforce.com";
  if (!accessToken) {
    return {
      synced: false,
      message: "(not configured) No Salesforce access token provided.",
    };
  }

  const result = await resilientCall(
    async (signal) => {
      const searchRes = await fetch(
        `${instanceUrl}/services/data/v59.0/query?q=${encodeURIComponent(`SELECT Id FROM Contact WHERE Phone = '${phoneNumber}' LIMIT 1`)}`,
        { headers: { Authorization: `Bearer ${accessToken}` }, signal },
      );
      const searchData = (await searchRes.json().catch(() => null)) as any;
      let contactId = (searchData?.records?.[0]?.Id as string) ?? null;

      if (!contactId) {
        const createRes = await fetch(`${instanceUrl}/services/data/v59.0/sobjects/Contact`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            Phone: phoneNumber,
            FirstName: callerName ?? "Unknown",
            LastName: callerName ? "(via Weeber)" : "Caller",
          }),
          signal,
        });
        const created = (await createRes.json().catch(() => null)) as any;
        contactId = (created?.id as string) ?? null;
      }

      if (contactId && notes) {
        await fetch(`${instanceUrl}/services/data/v59.0/sobjects/Task`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            Subject: "Weeber voice call",
            Description: notes,
            WhoId: contactId,
            Status: "Completed",
          }),
          signal,
        });
      }

      return contactId;
    },
    { integration: "salesforce" },
  );

  if (!result.ok) {
    return { synced: false, message: `Salesforce sync failed: ${result.message}` };
  }
  return { synced: true, contactId: result.data };
}
