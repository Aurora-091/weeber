import { db } from "../../database";
import { scheduledCalls } from "../../database/schema";
import { addToDoNotCallList } from "@weeber/compliance";
import { dncAdapter } from "../compliance/adapters";
import { dispatchWebhook, resolveWebhookUrl } from "../webhooks";
import { sendSmsForOrg } from "../send-sms";
import { getWorkflowsForNumber } from "./index";
import type { WorkflowOutcome } from "./types";
import { resolveRetryConfig, isShopifyWorkflow } from "../retry-config";
import { cancelOrder } from "../../integrations/shopify/client";

const RETRYABLE_OUTCOMES: WorkflowOutcome[] = ["no-answer", "busy", "failed"];

/**
 * Org-scoped retry path for Shopify's built-in workflows (issue 3 feature).
 * Runs INSTEAD of the generic WORKFLOWS-env-var path below for these three
 * workflow names, because that global env var is unconfigured in production
 * today (confirmed directly against Railway's live env) — relying on it
 * would mean this per-org retry cadence silently does nothing, the same way
 * retries have been silently inert for Shopify calls until this fix.
 * Non-retryable outcomes for these workflows (e.g. a disposition other than
 * no-answer/busy/failed) still fall through to the generic path unchanged
 * below — this only intercepts the "we don't know what happened, try again"
 * case, which is the one that actually needs org-configurable cadence.
 */
async function runShopifyOrgScopedRetry(params: {
  toNumber: string;
  outcome: WorkflowOutcome;
  workflowName: string;
  webhookUrl?: string | null;
  previousAttempt?: number;
  orgId: string;
  checkoutToken?: string | null;
  metadata?: Record<string, string | number>;
}) {
  const { toNumber, outcome, workflowName, webhookUrl, previousAttempt, orgId, checkoutToken, metadata } = params;
  const config = await resolveRetryConfig(orgId, workflowName);
  const nextAttempt = (previousAttempt ?? 0) + 1;

  if (nextAttempt > config.maxAttempts) {
    console.log(
      `[shopify-retry:${workflowName}] retry limit reached for ${toNumber} after outcome "${outcome}" (${nextAttempt - 1}/${config.maxAttempts}) — not scheduling another`,
    );
    // Only shopify-cod-confirmation has an exhaustion action today (cancel
    // the unconfirmed order) — cart-recovery and feedback just stop trying,
    // no further action needed. Calls cancelOrder directly in-process
    // rather than round-tripping through /internal/cod-confirmation-
    // exhausted's HTTP route (that route's own comment says it's meant to
    // be invoked via the workflow engine's onExhausted webhook action —
    // which, since WORKFLOWS was never configured, has never actually
    // fired in production; this is the same underlying cancelOrder call,
    // just reached directly instead of through a webhook to itself).
    if (workflowName === "shopify-cod-confirmation" && metadata?.shop && metadata?.orderId !== undefined) {
      try {
        await cancelOrder({
          shop: String(metadata.shop),
          orderId: Number(metadata.orderId),
          reason: "CUSTOMER",
          notifyCustomer: false,
          restock: true,
          staffNote: "No COD confirmation after max call attempts",
        });
      } catch (err) {
        console.error(`[shopify-retry:${workflowName}] failed to cancel exhausted COD order`, err);
      }
    }
    return;
  }

  await db.insert(scheduledCalls).values({
    toNumber,
    workflowName,
    persona: workflowName,
    webhookUrl: webhookUrl ?? undefined,
    attempt: nextAttempt,
    maxAttempts: config.maxAttempts,
    runAt: new Date(Date.now() + config.retryDelayMinutes * 60 * 1000),
    status: "pending",
    orgId,
    checkoutToken: checkoutToken ?? undefined,
    metadata,
  });
  console.log(
    `[shopify-retry:${workflowName}] scheduled retry ${nextAttempt}/${config.maxAttempts} for ${toNumber} in ${config.retryDelayMinutes}min`,
  );
}

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
  checkoutToken?: string | null;
  metadata?: Record<string, string | number>;
}) {
  const { toNumber, outcome, persona, webhookUrl, previousAttempt, orgId, checkoutToken, metadata } = params;

  if (isShopifyWorkflow(persona) && orgId && RETRYABLE_OUTCOMES.includes(outcome)) {
    await runShopifyOrgScopedRetry({
      toNumber,
      outcome,
      workflowName: persona!,
      webhookUrl,
      previousAttempt,
      orgId,
      checkoutToken,
      metadata,
    });
    return;
  }

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
            checkoutToken: checkoutToken ?? undefined,
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
          // Routed through the provider-agnostic dispatcher (Misc-4 fix) —
          // this used to call getTwilioClientForOrg directly, so a
          // BYO-Plivo/Exotel org's post-call SMS silently failed.
          const result = await sendSmsForOrg({ orgId, to: toNumber, body: action.template });
          if (result.ok) {
            console.log(`[workflow:${workflow.name}] sent SMS to ${toNumber}`);
          } else {
            console.error(`[workflow:${workflow.name}] failed to send SMS to ${toNumber}: ${result.error}`);
          }
          break;
        }
      }
    } catch (err) {
      console.error(`[workflow:${workflow.name}] failed to execute action for outcome ${outcome}`, err);
    }
  }
}
