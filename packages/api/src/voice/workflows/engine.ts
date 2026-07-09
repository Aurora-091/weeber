import { db } from "../../database";
import { scheduledCalls } from "../../database/schema";
import { addToDoNotCallList } from "@openvent/compliance";
import { dncAdapter } from "../compliance/adapters";
import { dispatchWebhook, resolveWebhookUrl } from "../webhooks";
import { twilioClient } from "../twilio-client";
import { isValidE164 } from "../validation";
import { getWorkflowsForNumber } from "./index";
import type { WorkflowOutcome } from "./types";

/**
 * Runs whenever a call ends with a known outcome (disposition, or an inferred
 * Twilio status like no-answer/busy/failed). Looks up any workflow configured
 * for that number and executes the matching action automatically — this is
 * the "no manual step" follow-through: a no-answer schedules its own retry,
 * a not-interested caller gets added to the DNC list without anyone touching
 * a dashboard.
 */
export async function runWorkflowForOutcome(params: {
  toNumber: string;
  outcome: WorkflowOutcome;
  persona?: string;
  webhookUrl?: string | null;
  /** Set when this call was itself a scheduled retry — lets maxRetries be enforced across the chain. */
  previousAttempt?: number;
  /**
   * Weeber org-lite scoping + vertical workflow context (additive, ADR-030)
   * — carried forward into a retry's own `scheduledCalls` row so a
   * vertical workflow (e.g. Shopify COD confirmation) keeps its context
   * (shop, orderId, checkoutToken) across every retry attempt, not just
   * the first call.
   */
  orgId?: string;
  metadata?: Record<string, string | number>;
}) {
  const { toNumber, outcome, persona, webhookUrl, previousAttempt, orgId, metadata } = params;
  const matches = getWorkflowsForNumber(toNumber);

  for (const workflow of matches) {
    const action = workflow.onOutcome[outcome];
    if (!action || action.action === "none") continue;

    try {
      switch (action.action) {
        case "retry": {
          const nextAttempt = (previousAttempt ?? 0) + 1;
          if (nextAttempt > action.maxRetries) {
            console.log(
              `[workflow:${workflow.name}] retry limit reached for ${toNumber} (${nextAttempt - 1}/${action.maxRetries}) — not scheduling another`,
            );
            if (action.onExhausted?.action === "webhook") {
              void dispatchWebhook(resolveWebhookUrl(action.onExhausted.url), "call.retries_exhausted", {
                toNumber,
                outcome,
                workflow: workflow.name,
                orgId,
                metadata,
              });
            } else if (action.onExhausted?.action === "addToDnc") {
              await addToDoNotCallList(dncAdapter, toNumber, `workflow:${workflow.name} retries-exhausted`, "agent");
            }
            break;
          }
          await db.insert(scheduledCalls).values({
            toNumber,
            workflowName: workflow.name,
            persona,
            webhookUrl: webhookUrl ?? undefined,
            attempt: nextAttempt,
            maxAttempts: action.maxRetries,
            runAt: new Date(Date.now() + action.delayMinutes * 60 * 1000),
            status: "pending",
            orgId,
            metadata,
          });
          console.log(
            `[workflow:${workflow.name}] scheduled retry ${nextAttempt}/${action.maxRetries} for ${toNumber} in ${action.delayMinutes}min`,
          );
          break;
        }
        case "webhook": {
          void dispatchWebhook(resolveWebhookUrl(action.url), "call.completed", {
            toNumber,
            outcome,
            workflow: workflow.name,
          });
          break;
        }
        case "addToDnc": {
          await addToDoNotCallList(dncAdapter, toNumber, `workflow:${workflow.name} outcome:${outcome}`, "agent");
          console.log(`[workflow:${workflow.name}] added ${toNumber} to DNC list`);
          break;
        }
        case "sendSms": {
          const from = process.env.TWILIO_PHONE_NUMBER;
          if (!from) {
            console.error(`[workflow:${workflow.name}] cannot send SMS — TWILIO_PHONE_NUMBER is not configured`);
            break;
          }
          if (!isValidE164(toNumber)) {
            console.error(`[workflow:${workflow.name}] cannot send SMS — invalid destination number ${toNumber}`);
            break;
          }
          try {
            await twilioClient.messages.create({ to: toNumber, from, body: action.template });
            console.log(`[workflow:${workflow.name}] sent SMS to ${toNumber}`);
          } catch (err) {
            console.error(`[workflow:${workflow.name}] failed to send SMS to ${toNumber}`, err);
          }
          break;
        }
      }
    } catch (err) {
      console.error(`[workflow:${workflow.name}] failed to execute action for outcome ${outcome}`, err);
    }
  }
}
