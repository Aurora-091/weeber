import { resilientCall } from "./resilient-fetch";

/**
 * Salesforce CRM integration — the default "enterprise CRM" ask. Uses the
 * REST API with a pre-obtained access token (OAuth flow itself is out of
 * scope here — set SALESFORCE_ACCESS_TOKEN + SALESFORCE_INSTANCE_URL from
 * whatever auth flow your org already uses, e.g. a connected app's refresh
 * token exchanged on a schedule). Upserts a Contact by phone (SOQL lookup +
 * create-or-update) and logs a Task as the call note.
 *
 * Wrapped in resilientCall like every other integration — see
 * ./resilient-fetch.ts.
 */
export type SalesforceSyncResult =
  | { synced: true; contactId: string | null }
  | { synced: false; message: string };

export async function syncToSalesforce(
  phoneNumber: string,
  callerName: string | undefined,
  notes: string,
): Promise<SalesforceSyncResult> {
  const accessToken = process.env.SALESFORCE_ACCESS_TOKEN;
  const instanceUrl = process.env.SALESFORCE_INSTANCE_URL;
  if (!accessToken || !instanceUrl) {
    return {
      synced: false,
      message:
        "(not configured) SALESFORCE_ACCESS_TOKEN / SALESFORCE_INSTANCE_URL not set — no real CRM connected.",
    };
  }

  const result = await resilientCall(
    async (signal) => {
      const soql = encodeURIComponent(`SELECT Id FROM Contact WHERE Phone = '${phoneNumber}' LIMIT 1`);
      const searchRes = await fetch(`${instanceUrl}/services/data/v60.0/query?q=${soql}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal,
      });
      const searchData = (await searchRes.json().catch(() => null)) as any;
      let contactId: string | null = searchData?.records?.[0]?.Id ?? null;

      if (!contactId) {
        const nameParts = (callerName ?? "Unknown Caller").split(" ");
        const createRes = await fetch(`${instanceUrl}/services/data/v60.0/sobjects/Contact`, {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            FirstName: nameParts[0],
            LastName: nameParts.slice(1).join(" ") || nameParts[0],
            Phone: phoneNumber,
          }),
          signal,
        });
        const created = (await createRes.json().catch(() => null)) as any;
        contactId = created?.id ?? null;
      }

      if (contactId) {
        await fetch(`${instanceUrl}/services/data/v60.0/sobjects/Task`, {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            WhoId: contactId,
            Subject: "OpenVent voice agent call",
            Description: notes,
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
