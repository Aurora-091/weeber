/**
 * User-facing data export — "Download as Excel" on the Integrations
 * page. On-demand .xlsx generation via exceljs, no scheduling/email, no
 * external spreadsheet OAuth (Google Sheets is explicitly out of scope for
 * now — see integrations.tsx). Every query here is org-scoped the same way
 * the rest of app/routes.ts is; there is no path that can leak another
 * org's rows.
 */
import ExcelJS from "exceljs";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { db } from "../database";
import { calls, callLatency, scheduledCalls, transcripts, leads } from "../database/schema";
import { defaultIntakeSchema } from "../voice/leads/intake-schema";

function durationSeconds(startedAt: Date, endedAt: Date | null): number | null {
  if (!endedAt) return null;
  return Math.round((endedAt.getTime() - startedAt.getTime()) / 1000);
}

/** Orders: every Shopify-vertical scheduled call (cart recovery, COD confirmation, feedback), newest first. */
export async function buildOrdersWorkbook(orgId: string): Promise<ExcelJS.Buffer> {
  const rows = await db
    .select()
    .from(scheduledCalls)
    .where(
      and(
        eq(scheduledCalls.orgId, orgId),
        or(
          eq(scheduledCalls.workflowName, "shopify-cart-recovery"),
          eq(scheduledCalls.workflowName, "shopify-cod-confirmation"),
          eq(scheduledCalls.workflowName, "shopify-feedback"),
        ),
      ),
    )
    .orderBy(desc(scheduledCalls.runAt));

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Orders");
  sheet.columns = [
    { header: "Workflow", key: "workflow", width: 22 },
    { header: "Phone Number", key: "toNumber", width: 18 },
    { header: "Status", key: "status", width: 12 },
    { header: "Attempt", key: "attempt", width: 10 },
    { header: "Max Attempts", key: "maxAttempts", width: 12 },
    { header: "Scheduled For", key: "runAt", width: 22 },
    { header: "Shop", key: "shop", width: 26 },
    { header: "Order ID", key: "orderId", width: 16 },
    { header: "Checkout Token", key: "checkoutToken", width: 24 },
    { header: "Recovered Order ID", key: "recoveredOrderId", width: 18 },
    { header: "Recovered Amount", key: "recoveredAmount", width: 16 },
    { header: "Created At", key: "createdAt", width: 22 },
  ];
  sheet.getRow(1).font = { bold: true };

  for (const row of rows) {
    sheet.addRow({
      workflow: row.workflowName,
      toNumber: row.toNumber,
      status: row.status,
      attempt: row.attempt,
      maxAttempts: row.maxAttempts,
      runAt: row.runAt,
      shop: row.metadata?.shop ?? "",
      orderId: row.metadata?.orderId ?? "",
      checkoutToken: row.checkoutToken ?? "",
      recoveredOrderId: row.recoveredOrderId ?? "",
      recoveredAmount: row.recoveredAmount ?? "",
      createdAt: row.createdAt,
    });
  }

  return workbook.xlsx.writeBuffer();
}

/** Call analytics: one row per call — volume/duration/outcome/latency, newest first. */
export async function buildAnalyticsWorkbook(orgId: string): Promise<ExcelJS.Buffer> {
  const orgCalls = await db
    .select()
    .from(calls)
    .where(eq(calls.orgId, orgId))
    .orderBy(desc(calls.startedAt));

  const callIds = orgCalls.map((c) => c.id);
  const latencyRows =
    callIds.length > 0 ? await db.select().from(callLatency).where(inArray(callLatency.callId, callIds)) : [];
  const latencyByCallId = new Map(latencyRows.map((r) => [r.callId, r]));

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Call Analytics");
  sheet.columns = [
    { header: "Started At", key: "startedAt", width: 22 },
    { header: "Direction", key: "direction", width: 12 },
    { header: "From", key: "fromNumber", width: 16 },
    { header: "To", key: "toNumber", width: 16 },
    { header: "Status", key: "status", width: 14 },
    { header: "Agent Persona", key: "agentPersona", width: 22 },
    { header: "Outcome (Disposition)", key: "disposition", width: 20 },
    { header: "Duration (sec)", key: "durationSec", width: 14 },
    { header: "STT Connect (ms)", key: "sttConnectMs", width: 16 },
    { header: "LLM TTFT (ms)", key: "llmTtftMs", width: 14 },
    { header: "TTS First Byte (ms)", key: "ttsFirstByteMs", width: 16 },
    { header: "STT Reconnects", key: "sttReconnectCount", width: 14 },
  ];
  sheet.getRow(1).font = { bold: true };

  for (const call of orgCalls) {
    const latency = latencyByCallId.get(call.id);
    sheet.addRow({
      startedAt: call.startedAt,
      direction: call.direction,
      fromNumber: call.fromNumber,
      toNumber: call.toNumber,
      status: call.status,
      agentPersona: call.agentPersona ?? "",
      disposition: call.disposition ?? "",
      durationSec: durationSeconds(call.startedAt, call.endedAt),
      sttConnectMs: latency?.sttConnectMs ?? "",
      llmTtftMs: latency?.llmTtftMs ?? "",
      ttsFirstByteMs: latency?.ttsFirstByteMs ?? "",
      sttReconnectCount: call.sttReconnectCount ?? 0,
    });
  }

  return workbook.xlsx.writeBuffer();
}

/**
 * Leads: one row per person in the native leads layer, newest activity first.
 * Fixed columns (phone/name/status/source/advisor + timestamps) plus one
 * column per field in the org vertical's default intake schema, so the export
 * mirrors exactly what the Leads page renders. Regulated fields never appear
 * here because they were never stored (blocked at the validation chokepoint).
 */
export async function buildLeadsWorkbook(
  orgId: string,
  vertical: string | null | undefined,
): Promise<ExcelJS.Buffer> {
  const rows = await db
    .select()
    .from(leads)
    .where(eq(leads.orgId, orgId))
    .orderBy(desc(leads.lastActivityAt));

  const schema = defaultIntakeSchema(vertical);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Leads");
  sheet.columns = [
    { header: "Phone Number", key: "phone", width: 18 },
    { header: "Name", key: "name", width: 22 },
    { header: "Status", key: "status", width: 12 },
    { header: "Source", key: "source", width: 12 },
    { header: "Assigned Advisor ID", key: "assignedAdvisorId", width: 18 },
    ...schema.map((f) => ({ header: f.label, key: `field_${f.key}`, width: 20 })),
    { header: "First Seen", key: "firstSeenAt", width: 22 },
    { header: "Last Activity", key: "lastActivityAt", width: 22 },
  ];
  sheet.getRow(1).font = { bold: true };

  for (const row of rows) {
    const record: Record<string, unknown> = {
      phone: row.phone,
      name: row.name ?? "",
      status: row.status,
      source: row.source,
      assignedAdvisorId: row.assignedAdvisorId ?? "",
      firstSeenAt: row.firstSeenAt,
      lastActivityAt: row.lastActivityAt,
    };
    for (const f of schema) {
      record[`field_${f.key}`] = row.fields?.[f.key] ?? "";
    }
    sheet.addRow(record);
  }

  return workbook.xlsx.writeBuffer();
}

/** Transcripts: one row per turn, grouped by call (call id, then chronological), newest call first. */
export async function buildTranscriptsWorkbook(orgId: string): Promise<ExcelJS.Buffer> {
  const orgCalls = await db
    .select({ id: calls.id, startedAt: calls.startedAt, toNumber: calls.toNumber, fromNumber: calls.fromNumber })
    .from(calls)
    .where(eq(calls.orgId, orgId))
    .orderBy(desc(calls.startedAt));

  const callIds = orgCalls.map((c) => c.id);
  const rows =
    callIds.length > 0
      ? await db.select().from(transcripts).where(inArray(transcripts.callId, callIds)).orderBy(transcripts.callId, transcripts.createdAt)
      : [];
  const callMeta = new Map(orgCalls.map((c) => [c.id, c]));

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Transcripts");
  sheet.columns = [
    { header: "Call ID", key: "callId", width: 10 },
    { header: "Call Started At", key: "callStartedAt", width: 22 },
    { header: "Phone Number", key: "toNumber", width: 16 },
    { header: "Speaker", key: "role", width: 10 },
    { header: "Text", key: "text", width: 80 },
    { header: "Timestamp", key: "createdAt", width: 22 },
  ];
  sheet.getRow(1).font = { bold: true };

  for (const row of rows) {
    const meta = callMeta.get(row.callId);
    sheet.addRow({
      callId: row.callId,
      callStartedAt: meta?.startedAt ?? "",
      toNumber: meta?.toNumber ?? "",
      role: row.role,
      text: row.text,
      createdAt: row.createdAt,
    });
  }

  return workbook.xlsx.writeBuffer();
}
