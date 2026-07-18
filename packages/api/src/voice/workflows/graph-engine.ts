import { eq, and, lte, sql } from "drizzle-orm";
import { db } from "../../database";
import { scheduledCalls, workflowTemplates, orgWorkflowConfigs, workflowRuns, orgs } from "../../database/schema";
import { addToDoNotCallList } from "@openvent/compliance";
import { dncAdapter } from "../compliance/adapters";
import { dispatchWebhook, resolveWebhookUrl } from "../webhooks";
import { getTwilioClientForOrg } from "../twilio-client";
import { isValidE164 } from "../validation";
import { resolveDiscountPercent, renderTemplate, composeCartRecoveryUrl } from "./variables";
import type { WorkflowGraph, WorkflowNode, WorkflowEdge, CallConfig, WaitConfig, SmsConfig, AddToDncConfig, WebhookConfig } from "./graph-types";

/**
 * Merge a template node's config with the org's overrides for that node.
 * Only user-overridable fields get merged — structural fields stay from the template.
 */
function mergeNodeConfig(
  node: WorkflowNode,
  overrides: Record<string, Record<string, unknown>> | null | undefined,
): WorkflowNode {
  if (!overrides || !overrides[node.id]) return node;
  const nodeOverride = overrides[node.id];
  // Cast needed: NodeConfig's union now includes ComplianceCheckConfig
  // (Record<string, never>, 2026-07-18) which makes a plain object spread's
  // inferred type not cleanly match any single union member — this function
  // never validates the merged shape against node.type at runtime either
  // way, so the cast doesn't change actual behavior.
  return { ...node, config: { ...node.config, ...nodeOverride } as WorkflowNode["config"] };
}

function getOutgoingEdges(graph: WorkflowGraph, nodeId: string): WorkflowEdge[] {
  return graph.edges.filter((e) => e.source === nodeId);
}

function getNodeById(graph: WorkflowGraph, nodeId: string): WorkflowNode | undefined {
  return graph.nodes.find((n) => n.id === nodeId);
}

/**
 * Resolves the graph a run actually executes: an org's own `customGraph`
 * (Workflow Canvas v4, 2026-07-18 — a merchant-built or merchant-forked
 * graph, already save-time-validated by scaffold.ts) if one is set, else
 * the template's shared graph — unchanged behavior for every org that
 * hasn't built its own graph. Single chokepoint so `advanceWorkflow` and
 * `resumeWorkflowAfterCall` can't drift into resolving this two different
 * ways.
 */
async function resolveWorkflowGraph(
  templateGraph: WorkflowGraph,
  orgId: string | null,
  templateKey: string,
): Promise<WorkflowGraph> {
  if (!orgId) return templateGraph;
  const [config] = await db
    .select({ customGraph: orgWorkflowConfigs.customGraph })
    .from(orgWorkflowConfigs)
    .where(and(eq(orgWorkflowConfigs.orgId, orgId), eq(orgWorkflowConfigs.templateKey, templateKey)))
    .limit(1);
  return (config?.customGraph as WorkflowGraph | null) ?? templateGraph;
}

/**
 * Core graph walker — advances a workflow run from its current node through
 * the graph. Handles: trigger (immediate advance), wait (pause for scheduler),
 * call (create scheduled call), conditionalSplit (route by outcome), and
 * terminal actions (sms, addToDnc, webhook — reuse existing engine.ts logic).
 *
 * Returns when the run enters a "waiting" state (wait/call node) or completes/fails.
 */
export async function advanceWorkflow(
  runId: string,
  callOutcome?: string,
): Promise<void> {
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).limit(1);
  if (!run) {
    console.error(`[graph-engine] workflow run ${runId} not found`);
    return;
  }
  if (run.status === "completed" || run.status === "failed") return;

  const [template] = await db
    .select()
    .from(workflowTemplates)
    .where(eq(workflowTemplates.id, run.templateKey))
    .limit(1);
  if (!template) {
    await markRunFailed(runId, "template_not_found");
    return;
  }

  let overrides: Record<string, Record<string, unknown>> | null = null;
  let orgConfig: { overrides: unknown; customGraph: unknown } | undefined;
  if (run.orgId) {
    [orgConfig] = await db
      .select()
      .from(orgWorkflowConfigs)
      .where(
        and(
          eq(orgWorkflowConfigs.orgId, run.orgId),
          eq(orgWorkflowConfigs.templateKey, run.templateKey),
        ),
      )
      .limit(1);
    overrides = (orgConfig?.overrides as Record<string, Record<string, unknown>>) ?? null;
  }

  const graph = (orgConfig?.customGraph as WorkflowGraph | null) ?? (template.graph as WorkflowGraph);
  let currentNodeId = run.currentNodeId;
  let context = { ...(run.context as Record<string, string | number>) };
  let iterations = 0;
  const MAX_ITERATIONS = 50; // safety net against infinite loops in malformed graphs

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    const rawNode = getNodeById(graph, currentNodeId);
    if (!rawNode) {
      await markRunFailed(runId, `node_not_found:${currentNodeId}`);
      return;
    }
    const node = mergeNodeConfig(rawNode, overrides);
    const outgoing = getOutgoingEdges(graph, currentNodeId);

    switch (node.type) {
      // dncCheck/callingWindowCheck (Workflow Canvas v4, 2026-07-18) advance
      // exactly like a trigger node — they're pass-through visual markers,
      // not a second enforcement point. The real DNC/calling-window check
      // already happens unconditionally in scheduler.ts's
      // dispatchScheduledCall for every call/sms action, regardless of
      // whether these nodes are present in a given graph.
      case "trigger":
      case "dncCheck":
      case "callingWindowCheck": {
        if (outgoing.length === 0) {
          await markRunCompleted(runId, currentNodeId, context);
          return;
        }
        currentNodeId = outgoing[0].target;
        await updateRunPosition(runId, currentNodeId, context, "running");
        break;
      }

      case "wait": {
        const config = node.config as WaitConfig;
        const clampedMinutes = Math.max(1, Math.min(10080, config.delayMinutes || 1));
        const delayMs = clampedMinutes * 60 * 1000;
        const nextRunAt = new Date(Date.now() + delayMs);
        if (outgoing.length === 0) {
          await markRunCompleted(runId, currentNodeId, context);
          return;
        }
        // Store the next node to advance to after the wait expires
        const nextNodeId = outgoing[0].target;
        const waitResult = await db
          .update(workflowRuns)
          .set({
            currentNodeId: nextNodeId,
            status: "waiting",
            nextRunAt,
            context,
            version: sql`${workflowRuns.version} + 1`,
            updatedAt: new Date(),
          })
          .where(and(eq(workflowRuns.id, runId), eq(workflowRuns.version, run.version)))
          .returning({ id: workflowRuns.id });
        if (waitResult.length === 0) {
          console.warn(`[graph-engine] run ${runId} version conflict at wait node ${node.id} — skipping`);
          return;
        }
        console.log(
          `[graph-engine] run ${runId} waiting ${config.delayMinutes}min at node ${node.id}, will advance to ${nextNodeId}`,
        );
        return;
      }

      case "call": {
        const config = node.config as CallConfig;
        const attemptNumber = (Number(context.attempt_number) || 0) + 1;
        context.attempt_number = attemptNumber;
        const discountPercent = resolveDiscountPercent(config, attemptNumber);
        context.discount_percent = discountPercent;

        const toNumber = String(context.to_number || "");
        if (!toNumber || !isValidE164(toNumber)) {
          await markRunFailed(runId, `invalid_to_number:${toNumber}`);
          return;
        }

        await db.transaction(async (tx) => {
          await tx.insert(scheduledCalls).values({
            toNumber,
            workflowName: `graph:${run.templateKey}`,
            persona: config.persona,
            attempt: attemptNumber,
            maxAttempts: 99, // graph handles its own retry logic
            runAt: new Date(),
            status: "pending",
            orgId: run.orgId ?? undefined,
            checkoutToken: String(context.checkout_token || "") || undefined,
            metadata: {
              ...(context as Record<string, string | number>),
              discount_percent: discountPercent,
              workflow_run_id: runId,
              workflow_node_id: node.id,
            },
            workflowRunId: runId,
          });

          // Park the run — it will resume when the call completes and the
          // outcome is fed back via advanceWorkflow(runId, outcome)
          const txResult = await tx
            .update(workflowRuns)
            .set({
              currentNodeId: node.id,
              status: "waiting",
              context,
              version: sql`${workflowRuns.version} + 1`,
              updatedAt: new Date(),
            })
            .where(and(eq(workflowRuns.id, runId), eq(workflowRuns.version, run.version)))
            .returning({ id: workflowRuns.id });
          if (txResult.length === 0) {
            console.warn(`[graph-engine] run ${runId} version conflict at call node ${node.id} — aborting`);
          }
        });
        console.log(
          `[graph-engine] run ${runId} placed call (attempt ${attemptNumber}, discount ${discountPercent}%) — waiting for outcome`,
        );
        return;
      }

      case "conditionalSplit": {
        if (!callOutcome) {
          await markRunFailed(runId, `conditional_split_no_outcome:${node.id}`);
          return;
        }
        // Match outcome to an outgoing edge's branch label
        let matchedEdge = outgoing.find((e) => e.branch === callOutcome);
        if (!matchedEdge) {
          matchedEdge = outgoing.find((e) => e.branch === "default");
        }
        if (!matchedEdge) {
          console.warn(
            `[graph-engine] run ${runId} — no edge for outcome "${callOutcome}" and no default at node ${node.id}; completing run`,
          );
          await markRunCompleted(runId, currentNodeId, context);
          return;
        }
        currentNodeId = matchedEdge.target;
        callOutcome = undefined; // consumed
        await updateRunPosition(runId, currentNodeId, context, "running");
        break;
      }

      case "sms": {
        const config = node.config as SmsConfig;
        const body = renderTemplate(config.template, context);
        const toNumber = String(context.to_number || "");
        if (!toNumber || !isValidE164(toNumber)) {
          console.error(`[graph-engine] cannot send SMS — invalid number ${toNumber}`);
        } else {
          let from = process.env.TWILIO_PHONE_NUMBER;
          if (run.orgId) {
            const [org] = await db.select({ outboundNumber: orgs.outboundNumber }).from(orgs).where(eq(orgs.id, run.orgId)).limit(1);
            if (org?.outboundNumber) from = org.outboundNumber;
          }
          if (from) {
            try {
              await (await getTwilioClientForOrg(run.orgId ?? undefined)).messages.create({ to: toNumber, from, body });
              console.log(`[graph-engine] run ${runId} sent SMS to ${toNumber}`);
            } catch (err) {
              console.error(`[graph-engine] run ${runId} failed to send SMS`, err);
            }
          }
        }
        if (outgoing.length === 0) {
          await markRunCompleted(runId, currentNodeId, context);
          return;
        }
        currentNodeId = outgoing[0].target;
        await updateRunPosition(runId, currentNodeId, context, "running");
        break;
      }

      case "addToDnc": {
        const config = node.config as AddToDncConfig;
        const toNumber = String(context.to_number || "");
        if (toNumber && isValidE164(toNumber)) {
          await addToDoNotCallList(dncAdapter, toNumber, config.reason, "agent");
          console.log(`[graph-engine] run ${runId} added ${toNumber} to DNC: ${config.reason}`);
        }
        if (outgoing.length === 0) {
          await markRunCompleted(runId, currentNodeId, context);
          return;
        }
        currentNodeId = outgoing[0].target;
        await updateRunPosition(runId, currentNodeId, context, "running");
        break;
      }

      case "webhook": {
        const config = node.config as WebhookConfig;
        const payload = config.payloadTemplate
          ? Object.fromEntries(
              Object.entries(config.payloadTemplate).map(([k, v]) => [k, renderTemplate(v, context)]),
            )
          : context;
        void dispatchWebhook(resolveWebhookUrl(config.url), "call.completed", {
          ...payload,
          workflow_run_id: runId,
        });
        if (outgoing.length === 0) {
          await markRunCompleted(runId, currentNodeId, context);
          return;
        }
        currentNodeId = outgoing[0].target;
        await updateRunPosition(runId, currentNodeId, context, "running");
        break;
      }

      default: {
        await markRunFailed(runId, `unknown_node_type:${node.type}`);
        return;
      }
    }
  }

  // Safety net — if we hit MAX_ITERATIONS, fail the run
  await markRunFailed(runId, "max_iterations_exceeded");
}

/**
 * Called by the call-end handler when a call with a workflowRunId completes.
 * Looks up the run, finds the call node it was parked at, moves to the
 * conditionalSplit node that follows it, and feeds in the outcome.
 */
export async function resumeWorkflowAfterCall(
  workflowRunId: string,
  outcome: string,
  discountCode?: string,
): Promise<void> {
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, workflowRunId)).limit(1);
  if (!run || run.status !== "waiting") return;

  let context = { ...(run.context as Record<string, string | number>) };

  // If a discount code was generated during the call, compose the cart recovery URL
  if (discountCode) {
    context.discount_code = discountCode;
    const abandonedUrl = String(context.abandoned_checkout_url || "");
    if (abandonedUrl) {
      context.cart_recovery_url = composeCartRecoveryUrl(abandonedUrl, discountCode);
    }
  }

  // The run is parked at the call node — find the outgoing edge to a conditionalSplit
  const [template] = await db
    .select()
    .from(workflowTemplates)
    .where(eq(workflowTemplates.id, run.templateKey))
    .limit(1);
  if (!template) return;

  const graph = await resolveWorkflowGraph(template.graph as WorkflowGraph, run.orgId, run.templateKey);
  const outgoing = getOutgoingEdges(graph, run.currentNodeId);
  if (outgoing.length === 0) {
    await markRunCompleted(workflowRunId, run.currentNodeId, context);
    return;
  }

  // Advance to the next node (typically a conditionalSplit)
  const nextNodeId = outgoing[0].target;
  const resumeResult = await db
    .update(workflowRuns)
    .set({ currentNodeId: nextNodeId, context, status: "running", version: sql`${workflowRuns.version} + 1`, updatedAt: new Date() })
    .where(and(eq(workflowRuns.id, workflowRunId), eq(workflowRuns.version, run.version)))
    .returning({ id: workflowRuns.id });
  if (resumeResult.length === 0) {
    console.warn(`[graph-engine] run ${workflowRunId} version conflict in resumeWorkflowAfterCall — skipping`);
    return;
  }

  await advanceWorkflow(workflowRunId, outcome);
}

/**
 * Sweep for workflow_runs in "waiting" state whose nextRunAt has passed.
 * Called by the scheduler alongside executeDueScheduledCalls.
 */
export async function executeDueWorkflowRuns(): Promise<void> {
  const due = await db
    .select()
    .from(workflowRuns)
    .where(and(eq(workflowRuns.status, "waiting"), lte(workflowRuns.nextRunAt, new Date())));

  for (const run of due) {
    // Only runs with nextRunAt set are wait-node pauses (not call-node pauses)
    if (!run.nextRunAt) continue;
    try {
      // Clear nextRunAt and set to running before advancing (CAS on version)
      const dueResult = await db
        .update(workflowRuns)
        .set({ status: "running", nextRunAt: null, version: sql`${workflowRuns.version} + 1`, updatedAt: new Date() })
        .where(and(eq(workflowRuns.id, run.id), eq(workflowRuns.status, "waiting"), eq(workflowRuns.version, run.version)))
        .returning({ id: workflowRuns.id });
      if (dueResult.length === 0) {
        console.warn(`[graph-engine] run ${run.id} version conflict in executeDueWorkflowRuns — skipping`);
        continue;
      }
      await advanceWorkflow(run.id);
    } catch (err) {
      console.error(`[graph-engine] failed to advance run ${run.id}`, err);
      await markRunFailed(run.id, "advance_error");
    }
  }
}

async function updateRunPosition(
  runId: string,
  nodeId: string,
  context: Record<string, string | number>,
  status: "running" | "waiting",
): Promise<void> {
  await db
    .update(workflowRuns)
    .set({
      currentNodeId: nodeId,
      context,
      status,
      version: sql`${workflowRuns.version} + 1`,
      updatedAt: new Date(),
      nodeHistory: appendNodeHistorySql(nodeId),
    })
    .where(eq(workflowRuns.id, runId));
}

async function markRunCompleted(
  runId: string,
  nodeId: string,
  context: Record<string, string | number>,
): Promise<void> {
  await db
    .update(workflowRuns)
    .set({
      currentNodeId: nodeId,
      context,
      status: "completed",
      version: sql`${workflowRuns.version} + 1`,
      updatedAt: new Date(),
      nodeHistory: appendNodeHistorySql(nodeId),
    })
    .where(eq(workflowRuns.id, runId));
  console.log(`[graph-engine] run ${runId} completed at node ${nodeId}`);
}

async function markRunFailed(runId: string, reason: string): Promise<void> {
  await db
    .update(workflowRuns)
    .set({ status: "failed", version: sql`${workflowRuns.version} + 1`, updatedAt: new Date() })
    .where(eq(workflowRuns.id, runId));
  console.error(`[graph-engine] run ${runId} failed: ${reason}`);
}

/**
 * Analytics overlay (2026-07-16) — appends {nodeId, enteredAt} to the run's
 * `nodeHistory` via a jsonb `||` concat evaluated by Postgres itself, not a
 * read-modify-write from application code. `advanceWorkflow`'s own in-memory
 * `run` value could be stale by the time this write lands (the scheduler
 * sweep and a live call's resumeWorkflowAfterCall can both touch the same
 * run), so appending via SQL against whatever `node_history` currently holds
 * in the database is the only race-free way to do this — same reasoning
 * `version` already uses `sql`${workflowRuns.version} + 1`` for instead of
 * incrementing an in-memory counter.
 */
function appendNodeHistorySql(nodeId: string) {
  const entry = JSON.stringify([{ nodeId, enteredAt: new Date().toISOString() }]);
  return sql`${workflowRuns.nodeHistory} || ${entry}::jsonb`;
}
