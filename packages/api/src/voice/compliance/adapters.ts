import type { CallAuditStorageAdapter, CallLogStorageAdapter, ConsentPurpose, ConsentRecord, ConsentStorageAdapter, DncStorageAdapter } from "@openvent/compliance";
import { db } from "../../database";
import { calls, consentRecords, doNotCall, transcripts, toolCalls } from "../../database/schema";
import { desc, eq, lt, or, asc } from "drizzle-orm";

/**
 * Drizzle/Turso storage adapters wiring OpenVent's own schema into the
 * standalone @openvent/compliance package (packages/openvent-compliance). This is
 * the "dogfooding" proof that the extraction actually works standalone —
 * OpenVent's own compliance enforcement now runs entirely through the published
 * package's functions, with these two adapters as the only app-specific
 * glue code required.
 */
export const dncAdapter: DncStorageAdapter = {
  async isListed(phoneNumber) {
    const [row] = await db.select().from(doNotCall).where(eq(doNotCall.phoneNumber, phoneNumber)).limit(1);
    return Boolean(row);
  },
  async add(entry) {
    await db
      .insert(doNotCall)
      .values({ phoneNumber: entry.phoneNumber, reason: entry.reason, source: entry.source })
      .onConflictDoNothing();
  },
  async remove(phoneNumber) {
    await db.delete(doNotCall).where(eq(doNotCall.phoneNumber, phoneNumber));
  },
  async list() {
    const rows = await db.select().from(doNotCall);
    return rows.map((r) => ({
      phoneNumber: r.phoneNumber,
      reason: r.reason ?? undefined,
      source: (r.source ?? "manual") as "manual" | "agent" | "national-registry",
      addedAt: r.addedAt,
    }));
  },
};

/**
 * Consent ledger adapter (Global Compliance Engine Tier 0, 2026-07-16,
 * docs/global-compliance-engine-plan.md #6) — a factory, not a single shared instance like
 * `dncAdapter` above. @openvent/compliance's `ConsentStorageAdapter` interface is
 * intentionally org-agnostic (just `dataPrincipal` + `purpose`, no `orgId` param) so the package
 * itself has zero multi-tenancy opinion — but this app's `consent_records` table is genuinely
 * per-org (the same phone number can be a customer of more than one org on this platform, and
 * consent granted to one org must never satisfy a check for a different org). Closing that gap
 * here, at the call site, rather than changing the package's interface: call
 * `createConsentAdapterForOrg(orgId)` once per org context and pass the result as
 * `checkOutboundCallCompliance`'s `consentCheck.adapter`.
 *
 * `hasConsent`/`withdraw` only ever look at the MOST RECENT record for a given
 * (orgId, dataPrincipal, purpose) — mirrors the memory adapter's `activeGrant` semantics in
 * packages/openvent-compliance/src/adapters/memory.ts exactly, so behavior is identical between
 * the reference adapter used in tests and this production one.
 */
export function createConsentAdapterForOrg(orgId: string): ConsentStorageAdapter {
  async function mostRecentRecord(dataPrincipal: string, purpose: ConsentPurpose) {
    const [row] = await db
      .select()
      .from(consentRecords)
      .where(and(eq(consentRecords.orgId, orgId), eq(consentRecords.dataPrincipal, dataPrincipal), eq(consentRecords.purpose, purpose)))
      .orderBy(desc(consentRecords.grantedAt))
      .limit(1);
    return row;
  }

  return {
    async hasConsent(dataPrincipal, purpose) {
      const row = await mostRecentRecord(dataPrincipal, purpose);
      if (!row || !row.granted || row.withdrawnAt) return false;
      if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return false;
      return true;
    },
    async grant(record: ConsentRecord) {
      await db.insert(consentRecords).values({
        orgId,
        dataPrincipal: record.dataPrincipal,
        purpose: record.purpose,
        granted: record.granted,
        grantedAt: record.grantedAt,
        expiresAt: record.expiresAt ?? null,
        version: record.version,
        channel: record.channel,
        source: record.source,
        withdrawnAt: record.withdrawnAt ?? null,
      });
    },
    async withdraw(dataPrincipal, purpose) {
      const row = await mostRecentRecord(dataPrincipal, purpose);
      if (!row || row.withdrawnAt) return;
      await db.update(consentRecords).set({ withdrawnAt: new Date() }).where(eq(consentRecords.id, row.id));
    },
    async listForPrincipal(dataPrincipal) {
      const rows = await db
        .select()
        .from(consentRecords)
        .where(and(eq(consentRecords.orgId, orgId), eq(consentRecords.dataPrincipal, dataPrincipal)))
        .orderBy(desc(consentRecords.grantedAt));
      return rows.map((r) => ({
        dataPrincipal: r.dataPrincipal,
        purpose: r.purpose as ConsentPurpose,
        granted: r.granted,
        grantedAt: r.grantedAt,
        expiresAt: r.expiresAt,
        version: r.version,
        channel: r.channel as ConsentRecord["channel"],
        source: r.source,
        withdrawnAt: r.withdrawnAt,
      }));
    },
  };
}

export const callLogAdapter: CallLogStorageAdapter = {
  async findCallsStartedBefore(cutoff) {
    const rows = await db.select().from(calls).where(lt(calls.startedAt, cutoff));
    return rows.map((r) => ({ id: String(r.id), fromNumber: r.fromNumber, toNumber: r.toNumber, startedAt: r.startedAt }));
  },
  async findCallsByPhoneNumber(phoneNumber) {
    const rows = await db
      .select()
      .from(calls)
      .where(or(eq(calls.fromNumber, phoneNumber), eq(calls.toNumber, phoneNumber)));
    return rows.map((r) => ({ id: String(r.id), fromNumber: r.fromNumber, toNumber: r.toNumber, startedAt: r.startedAt }));
  },
  async deleteCall(callId) {
    const id = Number(callId);
    await db.delete(transcripts).where(eq(transcripts.callId, id));
    await db.delete(toolCalls).where(eq(toolCalls.callId, id));
    await db.delete(calls).where(eq(calls.id, id));
  },
};

/**
 * Backs the compliance audit-trail feature (see @openvent/compliance's
 * audit-trail.ts) — assembles the "who was called, when, what was said"
 * record a compliance request actually needs, from OpenVent's own
 * calls/transcripts tables. See routes.ts's GET /calls/:id/audit and
 * GET /callers/:phoneNumber/audit for where this gets used.
 */
export const callAuditAdapter: CallAuditStorageAdapter = {
  async getCall(callId) {
    const id = Number(callId);
    const [row] = await db.select().from(calls).where(eq(calls.id, id)).limit(1);
    if (!row) return null;
    return {
      callId: String(row.id),
      direction: row.direction,
      fromNumber: row.fromNumber,
      toNumber: row.toNumber,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      status: row.status,
      disposition: row.disposition,
    };
  },
  async getTranscript(callId) {
    const id = Number(callId);
    const rows = await db
      .select()
      .from(transcripts)
      .where(eq(transcripts.callId, id))
      .orderBy(asc(transcripts.createdAt));
    return rows.map((r) => ({ role: r.role, text: r.text, at: r.createdAt }));
  },
  async findCallsByPhoneNumber(phoneNumber) {
    const rows = await db
      .select()
      .from(calls)
      .where(or(eq(calls.fromNumber, phoneNumber), eq(calls.toNumber, phoneNumber)));
    return rows.map((r) => ({ callId: String(r.id) }));
  },
};

import { and } from "drizzle-orm";
import { callerMemory, scheduledCalls } from "../../database/schema";

export async function eraseOrgDataForPhoneNumber(orgId: string, phoneNumber: string): Promise<{ callsDeleted: number }> {
  // Delete scheduled calls for this org and number
  await db
    .delete(scheduledCalls)
    .where(
      and(
        eq(scheduledCalls.orgId, orgId),
        eq(scheduledCalls.toNumber, phoneNumber)
      )
    );

  // Delete caller memory row for this org + phone number only (audit #01,
  // D2 fix) — callerMemory is now scoped per-org (see schema comment), so a
  // redact request from one user no longer wipes another user's
  // memory of the same phone number. Self-hosted/no-org callers pass
  // orgId === "" here, matching the "" sentinel used everywhere else.
  await db
    .delete(callerMemory)
    .where(and(eq(callerMemory.orgId, orgId), eq(callerMemory.phoneNumber, phoneNumber)));

  // Delete calls scoped to this orgId and phoneNumber
  // (This automatically cascade deletes transcripts, tool calls, and latencies via foreign keys)
  const deletedCalls = await db
    .delete(calls)
    .where(
      and(
        eq(calls.orgId, orgId),
        or(eq(calls.fromNumber, phoneNumber), eq(calls.toNumber, phoneNumber))
      )
    )
    .returning({ id: calls.id });

  return { callsDeleted: deletedCalls.length };
}
