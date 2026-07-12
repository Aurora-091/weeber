import { lte, eq, and } from "drizzle-orm";
import { db } from "../../database";
import { scheduledCalls, orgs } from "../../database/schema";
import { getTwilioClientForOrg, getPublicUrl } from "../twilio-client";
import { sessionStore } from "../session-store";
import { isOnDoNotCallList, checkCallingWindow } from "@openvent/compliance";
import { dncAdapter } from "../compliance/adapters";
import { executeDueWorkflowRuns } from "./graph-engine";

const SWEEP_INTERVAL_MS = 60 * 1000; // check every minute

/**
 * Executes due scheduled calls (workflow retries) — the automated
 * follow-through for a "no-answer -> retry in 60min" style workflow action.
 * Runs the same compliance gates as a manual outbound call (DNC + calling
 * window) so scheduled retries never bypass the guardrails.
 */
export async function executeDueScheduledCalls() {
  const due = await db
    .select()
    .from(scheduledCalls)
    .where(and(eq(scheduledCalls.status, "pending"), lte(scheduledCalls.runAt, new Date())));

  for (const row of due) {
    // Claim the row atomically before doing any work — if a previous sweep
    // (e.g. one still awaiting a slow Twilio call) hasn't finished and this
    // sweep starts concurrently, only one of them can flip "pending" ->
    // "claimed" and win the race. Prevents the same scheduled call from
    // being dialed twice.
    const claimed = await db
      .update(scheduledCalls)
      .set({ status: "claimed" })
      .where(and(eq(scheduledCalls.id, row.id), eq(scheduledCalls.status, "pending")))
      .returning({ id: scheduledCalls.id });
    if (claimed.length === 0) continue; // another sweep already claimed it

    try {
      if (await isOnDoNotCallList(dncAdapter, row.toNumber)) {
        console.warn(`[scheduler] skipping scheduled call to ${row.toNumber} — on DNC list`);
        await db.update(scheduledCalls).set({ status: "canceled" }).where(eq(scheduledCalls.id, row.id));
        continue;
      }
      const windowCheck = checkCallingWindow(row.toNumber);
      if (!windowCheck.allowed) {
        // Push it out another 30 minutes rather than dropping it — the
        // window will open eventually. Release the claim back to "pending"
        // so a future sweep can pick it up again.
        await db
          .update(scheduledCalls)
          .set({ runAt: new Date(Date.now() + 30 * 60 * 1000), status: "pending" })
          .where(eq(scheduledCalls.id, row.id));
        continue;
      }

      let from = process.env.TWILIO_PHONE_NUMBER;
      if (row.orgId) {
        const [org] = await db.select().from(orgs).where(eq(orgs.id, row.orgId)).limit(1);
        if (org?.outboundNumber) {
          from = org.outboundNumber;
        }
      }

      if (!from) {
        console.error("[scheduler] No outbound phone number configured — cannot execute scheduled call");
        continue;
      }

      const call = await (await getTwilioClientForOrg(row.orgId)).calls.create({
        to: row.toNumber,
        from,
        url: `${getPublicUrl()}/api/voice/incoming`,
        statusCallback: `${getPublicUrl()}/api/voice/status-callback`,
        statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
        record: true,
        recordingStatusCallback: `${getPublicUrl()}/api/voice/recording-status`,
      });

      await sessionStore.set(call.sid, {
        callSid: call.sid,
        direction: "outbound",
        persona: row.persona ?? undefined,
        webhookUrl: row.webhookUrl ?? undefined,
        workflowName: row.workflowName,
        workflowAttempt: row.attempt,
        // Weeber org-lite scoping + vertical context (ADR-030) — carried
        // through so a retry can rebuild it (see engine.ts).
        orgId: row.orgId ?? undefined,
        checkoutToken: row.checkoutToken ?? undefined,
        workflowMetadata: row.metadata ?? undefined,
        workflowRunId: row.workflowRunId ?? undefined,
      });

      console.log(`[scheduler] executed scheduled call to ${row.toNumber} (workflow: ${row.workflowName})`);
      await db.update(scheduledCalls).set({ status: "executed" }).where(eq(scheduledCalls.id, row.id));
    } catch (err) {
      console.error(`[scheduler] failed to execute scheduled call id=${row.id}`, err);
      await db.update(scheduledCalls).set({ status: "failed" }).where(eq(scheduledCalls.id, row.id));
    }
  }
}

export function startScheduledCallSweep() {
  if (typeof setInterval === "undefined") return;
  const run = () => {
    void executeDueScheduledCalls().catch((err) => console.error("[scheduler] sweep failed", err));
    void executeDueWorkflowRuns().catch((err) => console.error("[scheduler] workflow-run sweep failed", err));
  };
  run();
  setInterval(run, SWEEP_INTERVAL_MS).unref?.();
}
