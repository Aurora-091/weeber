import { lte, eq, and } from "drizzle-orm";
import { db } from "../../database";
import { scheduledCalls, orgs } from "../../database/schema";
import { placeOutboundCall } from "../place-outbound-call";
import { sessionStore } from "../session-store";
import { isOnDoNotCallList, checkCallingWindow, type CallingWindowResult } from "@openvent/compliance";
import { dncAdapter } from "../compliance/adapters";
import { checkInsuranceNumberSeriesCompliance, checkInsuranceProducerLicensing } from "../compliance/insurance-gates";
import { checkIndiaNumberSeriesCompliance } from "../compliance/number-series-gate";
import { checkFtsaAttemptCap } from "../compliance/attempt-cap";
import { executeDueWorkflowRuns } from "./graph-engine";

const SWEEP_INTERVAL_MS = 60 * 1000; // check every minute

type ScheduledCallRow = typeof scheduledCalls.$inferSelect;

/**
 * Calling-window check with the per-org test-mode bypass layered on top
 * (2026-07-16 — "turn off compliance for testing" ask). Bypasses ONLY the
 * calling-window/TCPA-TRAI check, never DNC — DNC has no bypass anywhere in
 * this codebase, on purpose, explicit decision. Test mode is a timestamp
 * (orgs.callingWindowTestModeUntil) rather than a plain boolean specifically
 * so it self-expires — set via POST /api/app/compliance/test-mode, always
 * to now()+24h, so it can't be accidentally left on in production.
 */
async function checkCallingWindowForRow(orgId: string | null, toNumber: string): Promise<CallingWindowResult> {
  if (orgId) {
    const [org] = await db
      .select({ callingWindowTestModeUntil: orgs.callingWindowTestModeUntil })
      .from(orgs)
      .where(eq(orgs.id, orgId))
      .limit(1);
    if (org?.callingWindowTestModeUntil && org.callingWindowTestModeUntil.getTime() > Date.now()) {
      return { allowed: true, reason: "org calling-window test mode is active", resolvedTimezone: null, localHour: -1 };
    }
  }
  return checkCallingWindow(toNumber);
}

type DispatchResult =
  | { ok: true }
  | { ok: false; reason: "dnc" | "calling_window" | "attempt_cap" | "insurance_number_series" | "insurance_producer_licensing" | "india_number_series" | "place_failed"; detail: string };

/**
 * The actual DNC-check -> calling-window-check -> place-call -> session-
 * store side effects for one scheduled_calls row, with no opinion on what
 * to do with the row's status afterward — that's the caller's job, because
 * the automatic sweep and the manual "call now" button (2026-07-16) want
 * different behavior on a blocked/failed result: the sweep silently
 * requeues (defer 30min, or cancel on DNC); the manual endpoint surfaces a
 * real error to the merchant instead of pretending it worked. Extracted so
 * both paths run through the exact same compliance gates — a manual call
 * was never meant to be a way to route around DNC/calling-window.
 */
async function dispatchScheduledCall(row: ScheduledCallRow): Promise<DispatchResult> {
  if (await isOnDoNotCallList(dncAdapter, row.toNumber)) {
    return { ok: false, reason: "dnc", detail: "This number is on the Do Not Call list." };
  }

  const windowCheck = await checkCallingWindowForRow(row.orgId, row.toNumber);
  if (!windowCheck.allowed) {
    return { ok: false, reason: "calling_window", detail: windowCheck.reason };
  }

  // Florida FTSA max-3-attempts/24h cap (2026-07-17) — no-op for every non-Florida
  // number, see compliance/attempt-cap.ts's doc comment for scope/reasoning.
  const attemptCapCheck = await checkFtsaAttemptCap(row.toNumber);
  if (!attemptCapCheck.allowed) {
    return { ok: false, reason: "attempt_cap", detail: attemptCapCheck.reason };
  }

  // Insurance-vertical-only gates (no-op for every other org) — see
  // voice/compliance/insurance-gates.ts's doc comments for what each one actually checks.
  const numberSeriesCheck = await checkInsuranceNumberSeriesCompliance(row.orgId, row.toNumber);
  if (!numberSeriesCheck.allowed) {
    return { ok: false, reason: "insurance_number_series", detail: numberSeriesCheck.reason };
  }
  const producerLicensingCheck = await checkInsuranceProducerLicensing(row.orgId, row.toNumber);
  if (!producerLicensingCheck.allowed) {
    return { ok: false, reason: "insurance_producer_licensing", detail: producerLicensingCheck.reason };
  }

  // General (non-insurance) India DLT number-series gate (2026-07-17) — no-op
  // unless INDIA_NUMBER_SERIES_FLAG is on for this org, see
  // compliance/number-series-gate.ts's doc comment for why it defaults off.
  const generalNumberSeriesCheck = await checkIndiaNumberSeriesCompliance(row.orgId, row.toNumber);
  if (!generalNumberSeriesCheck.allowed) {
    return { ok: false, reason: "india_number_series", detail: generalNumberSeriesCheck.reason };
  }

  // Dispatch through the shared placement path so a scheduled retry dials
  // through the org's real provider (Twilio / Plivo / Exotel), not always
  // Twilio — the bug this fixes silently routed every India-BYO org's
  // automated retry through the platform Twilio account or failed outright.
  const placed = await placeOutboundCall({ orgId: row.orgId, to: row.toNumber });
  if (!placed.ok) {
    return { ok: false, reason: "place_failed", detail: placed.error };
  }

  await sessionStore.set(placed.sessionKey, {
    callSid: placed.sessionKey,
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

  return { ok: true };
}

/**
 * Executes due scheduled calls (workflow retries) — the automated
 * follow-through for a "no-answer -> retry in 60min" style workflow action.
 * Runs the same compliance gates as a manual outbound call (DNC + calling
 * window + the insurance-vertical-only number-series/producer-licensing gates) so scheduled
 * retries never bypass the guardrails.
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
      const result = await dispatchScheduledCall(row);

      if (!result.ok && result.reason === "dnc") {
        console.warn(`[scheduler] skipping scheduled call to ${row.toNumber} — on DNC list`);
        await db.update(scheduledCalls).set({ status: "canceled" }).where(eq(scheduledCalls.id, row.id));
        continue;
      }

      if (!result.ok && result.reason === "calling_window") {
        // Push it out another 30 minutes rather than dropping it — the
        // window will open eventually. Release the claim back to "pending"
        // so a future sweep can pick it up again. Logged (2026-07-16 — was
        // previously silent) — this is the single most common reason a
        // merchant sees "trigger detected, no call ever happened": to a
        // number in a currently-blocked calling window (e.g. any +91
        // number outside 9am-9pm IST per TRAI), this loops quietly every
        // 30min with zero visibility until the window opens, which is
        // indistinguishable from a real bug without a log line.
        console.warn(`[scheduler] deferring scheduled call id=${row.id} to ${row.toNumber} — ${result.detail}`);
        await db
          .update(scheduledCalls)
          .set({ runAt: new Date(Date.now() + 30 * 60 * 1000), status: "pending" })
          .where(eq(scheduledCalls.id, row.id));
        continue;
      }

      if (!result.ok && result.reason === "attempt_cap") {
        // Florida FTSA cap is a rolling 24h window, not a fixed reopening
        // time like calling_window above — a 30min retry would just hit
        // the same cap again and again until the oldest of the 3 counted
        // calls ages out. Defer 6h instead (a coarser, less spammy retry
        // cadence for a condition that resolves on its own as time passes,
        // not one this codebase can compute an exact reopen time for
        // without re-querying the same call history at retry time anyway).
        console.warn(`[scheduler] deferring scheduled call id=${row.id} to ${row.toNumber} — ${result.detail}`);
        await db
          .update(scheduledCalls)
          .set({ runAt: new Date(Date.now() + 6 * 60 * 60 * 1000), status: "pending" })
          .where(eq(scheduledCalls.id, row.id));
        continue;
      }

      if (!result.ok) {
        console.error(`[scheduler] could not place scheduled call id=${row.id} to ${row.toNumber}: ${result.detail}`);
        await db.update(scheduledCalls).set({ status: "failed" }).where(eq(scheduledCalls.id, row.id));
        continue;
      }

      console.log(`[scheduler] executed scheduled call to ${row.toNumber} (workflow: ${row.workflowName})`);
      await db.update(scheduledCalls).set({ status: "executed" }).where(eq(scheduledCalls.id, row.id));
    } catch (err) {
      console.error(`[scheduler] failed to execute scheduled call id=${row.id}`, err);
      await db.update(scheduledCalls).set({ status: "failed" }).where(eq(scheduledCalls.id, row.id));
    }
  }
}

export type CallNowResult =
  | { ok: true }
  | { ok: false; statusCode: 403 | 409 | 429 | 502; error: string };

/**
 * Manual "Call now" button (Orders page, 2026-07-16) — claims a pending
 * scheduled_calls row and dispatches it immediately, skipping the run_at
 * wait entirely, through the exact same DNC + calling-window gates the
 * automatic sweep uses (see dispatchScheduledCall's doc comment for why
 * this isn't a way to route around either). Unlike the sweep, a blocked
 * result is surfaced to the caller as a real error instead of being
 * silently requeued — the merchant asked for this call right now, they
 * should know why it didn't happen instead of it quietly retrying later
 * with no feedback.
 */
export async function callScheduledRowNow(orgId: string, rowId: number): Promise<CallNowResult> {
  const [row] = await db
    .select()
    .from(scheduledCalls)
    .where(and(eq(scheduledCalls.id, rowId), eq(scheduledCalls.orgId, orgId)))
    .limit(1);
  if (!row) return { ok: false, statusCode: 409, error: "Not found" };
  if (row.status !== "pending") {
    return { ok: false, statusCode: 409, error: `This call is already ${row.status} — can't call it now.` };
  }

  const claimed = await db
    .update(scheduledCalls)
    .set({ status: "claimed" })
    .where(and(eq(scheduledCalls.id, rowId), eq(scheduledCalls.status, "pending")))
    .returning({ id: scheduledCalls.id });
  if (claimed.length === 0) {
    return { ok: false, statusCode: 409, error: "Already being processed — try again in a moment." };
  }

  try {
    const result = await dispatchScheduledCall(row);
    if (!result.ok) {
      // DNC stays canceled permanently (never eligible again); a blocked
      // calling-window, attempt-cap, or a failed placement all go back to
      // "pending" so the normal sweep can still pick it up automatically
      // later — the merchant tried to force it now and couldn't, that
      // doesn't mean the trigger itself should be lost.
      await db
        .update(scheduledCalls)
        .set({ status: result.reason === "dnc" ? "canceled" : "pending" })
        .where(eq(scheduledCalls.id, rowId));
      const statusCode =
        result.reason === "dnc" ? 403 : result.reason === "calling_window" ? 409 : result.reason === "attempt_cap" ? 429 : 502;
      return { ok: false, statusCode, error: result.detail };
    }

    console.log(`[call-now] manually dispatched scheduled call id=${rowId} to ${row.toNumber} (workflow: ${row.workflowName})`);
    await db.update(scheduledCalls).set({ status: "executed" }).where(eq(scheduledCalls.id, rowId));
    return { ok: true };
  } catch (err) {
    await db.update(scheduledCalls).set({ status: "failed" }).where(eq(scheduledCalls.id, rowId));
    return { ok: false, statusCode: 502, error: err instanceof Error ? err.message : "Failed to place the call" };
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
