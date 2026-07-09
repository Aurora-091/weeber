import type { WorkflowConfig } from "./types";

/**
 * Loads workflow configs from the WORKFLOWS env var (a JSON array of
 * WorkflowConfig). Keeping this env-based (vs. a dashboard/DB table) matches
 * the rest of OpenVent's "code-first config, no UI required" approach — edit the
 * env var, restart, done.
 *
 * Example:
 *   WORKFLOWS=[{"name":"lead-followup","onOutcome":{
 *     "no-answer":{"action":"retry","delayMinutes":60,"maxRetries":3},
 *     "not-interested":{"action":"addToDnc"},
 *     "interested":{"action":"webhook","url":"https://your-n8n/webhook/abc"}
 *   }}]
 */
/** Pure parser, exported for testing — takes the raw env string directly instead of reading process.env. */
export function parseWorkflows(raw: string | undefined): WorkflowConfig[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error("[workflows] WORKFLOWS env var is not valid JSON — ignoring", err);
    return [];
  }
}

const workflows = parseWorkflows(process.env.WORKFLOWS);

/** Finds the workflow(s) that apply to a given number — matches explicit numbers first, then wildcard (no `numbers` field). */
export function getWorkflowsForNumber(toNumber: string, list: WorkflowConfig[] = workflows): WorkflowConfig[] {
  return list.filter((w) => !w.numbers || w.numbers.includes(toNumber));
}

export type { WorkflowConfig, WorkflowOutcome, WorkflowAction } from "./types";
