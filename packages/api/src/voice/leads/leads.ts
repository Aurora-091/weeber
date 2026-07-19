/**
 * Native Leads layer — core operations (2026-07-19,
 * docs/product-strategy/native-leads-layer-plan-2026-07-19.md).
 *
 * The person-of-record. One row per (orgId, phone). Every inbound source
 * (agent calls, forms, CRMs, Pipedream) converges here via `upsertLead`; the
 * Leads page + Excel export + CRM mirror read from here. This module owns the
 * dedup/upsert, the capturedState -> lead promotion, and the org-scoped reads
 * the dashboard uses. Every query is org-scoped — there is no path that reads
 * or writes another org's leads.
 */
import { and, desc, eq, or, ilike } from "drizzle-orm";
import { db } from "../../database";
import { leads, calls, orgs } from "../../database/schema";
import { withRetry } from "../../database/with-retry";
import { defaultIntakeSchema, validateFields, type LeadFieldDef } from "./intake-schema";

/** Local org-vertical lookup — kept here (not imported from org-queries) so the
 * leads module has no cross-module dependency for a single-column read. */
async function resolveVertical(orgId: string): Promise<string | null> {
  const [row] = await db.select({ vertical: orgs.vertical }).from(orgs).where(eq(orgs.id, orgId)).limit(1);
  return row?.vertical ?? null;
}

export type LeadSource = "call" | "form" | "webhook" | "pipedream" | "crm" | "manual";
export type LeadStatus = "new" | "contacted" | "qualified" | "booked" | "closed" | "lost";

export type UpsertLeadInput = {
  orgId: string;
  phone: string;
  name?: string | null;
  /** Already-validated, schema-accepted fields (see validateFields). */
  fields?: Record<string, string>;
  source: LeadSource;
};

/**
 * The single dedup/upsert path — one lead per (orgId, phone). Idempotent: a
 * retrying source (same phone, same data) converges to the same row and merges
 * fields rather than creating a duplicate. `source`/`name`/`status` are set
 * only on first create; a later call/form for an existing lead merges fields
 * and bumps lastActivityAt but never downgrades a manually-set status or
 * overwrites the original source. Returns the lead's id and whether it was
 * newly created.
 */
export async function upsertLead(input: UpsertLeadInput): Promise<{ id: number; created: boolean }> {
  const { orgId, phone, source } = input;
  const name = input.name?.trim() || null;
  const incoming = input.fields ?? {};
  const now = new Date();

  const [existing] = await db
    .select({ id: leads.id, fields: leads.fields, name: leads.name })
    .from(leads)
    .where(and(eq(leads.orgId, orgId), eq(leads.phone, phone)))
    .limit(1);

  if (existing) {
    const mergedFields = { ...existing.fields, ...incoming };
    await withRetry(
      () =>
        db
          .update(leads)
          .set({
            // Backfill a name only if we didn't have one; never clobber.
            ...(existing.name ? {} : name ? { name } : {}),
            fields: mergedFields,
            lastActivityAt: now,
            updatedAt: now,
          })
          .where(eq(leads.id, existing.id)),
      { label: "lead-update" },
    );
    return { id: existing.id, created: false };
  }

  const inserted = await withRetry(
    () =>
      db
        .insert(leads)
        .values({
          orgId,
          phone,
          name,
          fields: incoming,
          source,
          status: "new",
          firstSeenAt: now,
          lastActivityAt: now,
          createdAt: now,
          updatedAt: now,
        })
        // Race-safety: two concurrent first-touches for the same person hit
        // the (orgId, phone) unique index — the loser merges instead of erroring.
        .onConflictDoUpdate({
          target: [leads.orgId, leads.phone],
          set: { lastActivityAt: now, updatedAt: now },
        })
        .returning({ id: leads.id }),
    { label: "lead-insert" },
  );
  const row = inserted?.[0];
  // withRetry returns undefined only after exhausting retries (write truly
  // failed) — surface it rather than returning a bogus id the caller trusts.
  if (!row) throw new Error("lead-insert failed after retries");
  return { id: row.id, created: true };
}

/**
 * Promote a completed call's capturedState into the leads layer. Called from
 * stream.ts finalizeCall, right alongside upsertCallerMemory — same
 * (orgId, phone) key, same best-effort contract (a failure here must never
 * block a call from finalizing). Validates capturedState against the org's
 * intake schema (regulated fields dropped), upserts the lead, and links the
 * call row back via calls.leadId so the lead aggregates its conversation history.
 */
export async function promoteLeadFromCall(args: {
  orgId: string | undefined;
  phone: string;
  capturedState: Record<string, string>;
  callId: number;
  vertical: string | null | undefined;
  schema?: LeadFieldDef[];
}): Promise<void> {
  const { phone, capturedState, callId } = args;
  // Leads are an org concept — self-hosted OpenVent usage with no org has no
  // leads layer (same boundary caller-memory draws, but caller-memory uses ""
  // for the no-org case; here we simply skip, since a leads table with orgId=""
  // mixing every self-host user's leads would be worse than no leads at all).
  if (!args.orgId || !phone) return;
  const orgId = args.orgId;

  // Resolve the vertical (for the default intake schema) if the caller didn't
  // pass it — lets stream.ts call this without threading vertical through.
  const vertical = args.vertical ?? (await resolveVertical(orgId));
  const schema = args.schema ?? defaultIntakeSchema(vertical);
  const { accepted } = validateFields(capturedState, schema);

  // Derive a display name from common capture keys if the schema didn't define
  // one explicitly. Non-fatal if absent.
  const name =
    accepted.full_name || accepted.caller_name || capturedState.full_name || capturedState.caller_name || null;

  try {
    const { id } = await upsertLead({ orgId, phone, name, fields: accepted, source: "call" });
    await db.update(calls).set({ leadId: id }).where(eq(calls.id, callId));
  } catch (err) {
    console.error("[leads] failed to promote lead from call", err);
  }
}

export type LeadListRow = {
  id: number;
  phone: string;
  name: string | null;
  fields: Record<string, string>;
  status: LeadStatus;
  source: LeadSource;
  assignedAdvisorId: number | null;
  firstSeenAt: Date;
  lastActivityAt: Date;
};

/** Org-scoped list, newest activity first. Optional free-text search over
 * name/phone. Bounded limit — the Leads page paginates client-side for v1. */
export async function listOrgLeads(orgId: string, query?: string, limit = 200): Promise<LeadListRow[]> {
  const q = query?.trim();
  const where = q
    ? and(eq(leads.orgId, orgId), or(ilike(leads.name, `%${q}%`), ilike(leads.phone, `%${q}%`)))
    : eq(leads.orgId, orgId);
  return db
    .select({
      id: leads.id,
      phone: leads.phone,
      name: leads.name,
      fields: leads.fields,
      status: leads.status,
      source: leads.source,
      assignedAdvisorId: leads.assignedAdvisorId,
      firstSeenAt: leads.firstSeenAt,
      lastActivityAt: leads.lastActivityAt,
    })
    .from(leads)
    .where(where)
    .orderBy(desc(leads.lastActivityAt))
    .limit(Math.min(Math.max(limit, 1), 500)) as Promise<LeadListRow[]>;
}

/** One lead (org-scoped 404 guard) plus every call associated with that
 * person — linked calls (leadId) and, for calls that predate linking, calls to
 * the same number. Newest first. */
export async function getOrgLead(orgId: string, leadId: number) {
  const [lead] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.orgId, orgId), eq(leads.id, leadId)))
    .limit(1);
  if (!lead) return null;

  const relatedCalls = await db
    .select({
      id: calls.id,
      direction: calls.direction,
      status: calls.status,
      disposition: calls.disposition,
      sentiment: calls.sentiment,
      intent: calls.intent,
      startedAt: calls.startedAt,
      endedAt: calls.endedAt,
      capturedState: calls.capturedState,
    })
    .from(calls)
    .where(
      and(
        eq(calls.orgId, orgId),
        or(eq(calls.leadId, leadId), eq(calls.fromNumber, lead.phone), eq(calls.toNumber, lead.phone)),
      ),
    )
    .orderBy(desc(calls.startedAt))
    .limit(100);

  return { lead, calls: relatedCalls };
}

export type LeadPatch = {
  name?: string | null;
  status?: LeadStatus;
  assignedAdvisorId?: number | null;
  fields?: Record<string, string>;
};

/** Merge-patch a lead. Org-scoped — the where clause guarantees one org can't
 * edit another's lead even with a guessed id. `fields` is merged, not replaced,
 * so a partial edit doesn't wipe other captured values. Returns whether a row
 * matched. */
export async function updateOrgLead(orgId: string, leadId: number, patch: LeadPatch): Promise<boolean> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.name !== undefined) set.name = patch.name?.trim() || null;
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.assignedAdvisorId !== undefined) set.assignedAdvisorId = patch.assignedAdvisorId;

  if (patch.fields !== undefined) {
    const [existing] = await db
      .select({ fields: leads.fields })
      .from(leads)
      .where(and(eq(leads.orgId, orgId), eq(leads.id, leadId)))
      .limit(1);
    if (!existing) return false;
    set.fields = { ...existing.fields, ...patch.fields };
  }

  const result = await db
    .update(leads)
    .set(set)
    .where(and(eq(leads.orgId, orgId), eq(leads.id, leadId)))
    .returning({ id: leads.id });
  return result.length > 0;
}

/** Manual lead creation from the dashboard. Validates fields against the org's
 * schema (regulated fields dropped) and upserts by (orgId, phone) so a manual
 * add for an existing person merges rather than duplicates. */
export async function createLeadManual(args: {
  orgId: string;
  phone: string;
  name?: string | null;
  fields?: Record<string, unknown>;
  vertical: string | null | undefined;
}): Promise<{ id: number; created: boolean; rejectedRegulated: string[] }> {
  const schema = defaultIntakeSchema(args.vertical);
  const { accepted, rejectedRegulated } = validateFields(args.fields, schema);
  const { id, created } = await upsertLead({
    orgId: args.orgId,
    phone: args.phone,
    name: args.name,
    fields: accepted,
    source: "manual",
  });
  return { id, created, rejectedRegulated };
}
