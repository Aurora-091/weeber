/**
 * Outbound CRM mirror — push one native lead to the org's connected CRM
 * (Phase 3 of the native leads layer,
 * docs/product-strategy/native-leads-layer-plan-2026-07-19.md §10).
 *
 * The leads table stays the source of truth; the CRM is a projection/mirror.
 * This is ON-DEMAND ONLY (a button on the lead detail → POST /leads/:id/sync-crm)
 * — it must never auto-fire an external network call as a side effect of ingest
 * or promotion. It reuses the same native adapters (HubSpot/Salesforce/
 * GoHighLevel) the in-call crmSync tool uses, resolved through the shared
 * getOrgCrmCredentials so provider priority never drifts between the two paths.
 *
 * COMPLIANCE: a lead's `fields` can only ever contain non-regulated values
 * (regulated identifiers are stripped write-side by validateFields /
 * validateSchemaDefs before anything is stored), so the note built here is
 * already clean. We still build it only from stored `fields` + status/source —
 * we never re-derive or echo anything the leads layer rejected.
 */
import { getOrgCrmCredentials } from "../integrations/resolve-crm";
import { syncToGoHighLevel } from "../integrations/gohighlevel";
import { syncToSalesforce } from "../integrations/salesforce";
import { syncToHubspot } from "../integrations/hubspot";
import { getOrgLead } from "./leads";

export type CrmMirrorResult = {
  ok: boolean;
  crm?: string;
  message: string;
  statusCode: 200 | 400 | 404 | 502;
};

/** Human-readable label for a field key when the schema label isn't handy —
 * turns `order_number` into `Order number`. */
function humanizeKey(key: string): string {
  const s = key.replace(/[_-]+/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : key;
}

/** Build the CRM note body from the lead's stored (already clean) fields plus
 * its status/source and recent-call count. Kept compact — this is a mirror
 * summary, not the full record. */
function buildNote(args: {
  status: string;
  source: string;
  fields: Record<string, string>;
  callCount: number;
}): string {
  const lines: string[] = ["Synced from Weeber", `Status: ${args.status} · Source: ${args.source}`];
  const entries = Object.entries(args.fields).filter(([, v]) => v != null && String(v).trim() !== "");
  for (const [k, v] of entries) {
    lines.push(`${humanizeKey(k)}: ${v}`);
  }
  if (args.callCount > 0) {
    lines.push(`Calls on record: ${args.callCount}`);
  }
  return lines.join("\n");
}

/**
 * Mirror a single lead to the org's connected CRM. Returns a discriminated
 * result the route maps straight to an HTTP response:
 * - 404 if the lead doesn't exist for this org
 * - 400 if no CRM is connected (nothing to mirror to) or the phone is missing
 * - 502 if the CRM adapter reports the sync failed
 * - 200 on a successful sync
 *
 * Never throws for an expected failure (no CRM, adapter error) — those are
 * returned as results so the route stays a thin mapper. Only truly unexpected
 * errors propagate.
 */
export async function mirrorLeadToCrm(
  orgId: string,
  leadId: number,
  _vertical?: string | null,
): Promise<CrmMirrorResult> {
  const record = await getOrgLead(orgId, leadId);
  if (!record) {
    return { ok: false, message: "Lead not found.", statusCode: 404 };
  }

  const { lead, calls } = record;
  if (!lead.phone) {
    return { ok: false, message: "Lead has no phone number to sync.", statusCode: 400 };
  }

  const crm = await getOrgCrmCredentials(orgId);
  if (!crm) {
    return {
      ok: false,
      message: "No CRM connected for this organization. Connect one in Settings → Integrations.",
      statusCode: 400,
    };
  }

  const fields = (lead.fields ?? {}) as Record<string, string>;
  const name = lead.name ?? undefined;
  const note = buildNote({
    status: lead.status,
    source: lead.source,
    fields,
    callCount: calls.length,
  });

  const { provider, credentials } = crm;
  let synced = false;
  let message = "";

  switch (provider) {
    case "gohighlevel": {
      const result = await syncToGoHighLevel(lead.phone, name, note, credentials.api_key, credentials.location_id);
      synced = result.synced;
      message = result.synced ? "Synced to GoHighLevel." : result.message;
      break;
    }
    case "salesforce": {
      const result = await syncToSalesforce(lead.phone, name, note, credentials.access_token, credentials.instance_url);
      synced = result.synced;
      message = result.synced ? "Synced to Salesforce." : result.message;
      break;
    }
    case "hubspot": {
      const result = await syncToHubspot(lead.phone, name, note, credentials.api_key);
      synced = result.synced;
      message = result.synced ? "Synced to HubSpot." : result.message;
      break;
    }
  }

  if (!synced) {
    return { ok: false, crm: provider, message, statusCode: 502 };
  }
  return { ok: true, crm: provider, message, statusCode: 200 };
}
