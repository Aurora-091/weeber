import type { CallAuditStorageAdapter, CallLogStorageAdapter, DncStorageAdapter } from "@openvent/compliance";
import { db } from "../../database";
import { calls, doNotCall, transcripts, toolCalls } from "../../database/schema";
import { eq, lt, or, asc } from "drizzle-orm";

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
