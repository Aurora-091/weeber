/**
 * ADR-096 — the single outbound compliance chokepoint.
 *
 * Before this file existed, the six dial-time gates were duplicated in two of
 * `placeOutboundCall`'s five callers (workflows/scheduler.ts's
 * `dispatchScheduledCall` and voice/routes.ts's campaign `/calls/outbound`),
 * and absent from the other three — `POST /api/leads/:id/call-now`
 * (app/routes.ts), the tenant preview test-call (app/routes.ts) and the admin
 * `.../test-call-phone` (voice/routes.ts) — while `place-outbound-call.ts`
 * documented the opposite ("both call sites already run them before reaching
 * here"). Audit 16 (2026-08-10) found the asymmetry inverted against us in
 * production: `insurance_advisors` is empty, so the *gated* paths 403 every
 * resolvable US number while the *ungated* paths dial anything, which teaches
 * a pilot user to reach for the unsafe door. Under the FCC's February 2024
 * declaratory ruling an AI-generated voice is "artificial" for TCPA purposes:
 * $500–$1,500 per call, no aggregate cap, private right of action.
 *
 * So the gates live here, `placeOutboundCall` calls this and nothing else can
 * place a call without passing through it, and the default is CLOSED. Callers
 * keep their own pre-dial checks: a caller that already knows it will be
 * refused should not spend a provider leg to find out, and the scheduler needs
 * per-gate reason codes to decide defer-vs-cancel. Those pre-checks are an
 * optimisation; this is the enforcement.
 *
 * Deliberately scoped to `packages/api/src/voice/compliance/` — no change to
 * `packages/weeber-compliance`, whose semantics are unchanged and which stays
 * app-agnostic.
 */
import { eq } from "drizzle-orm";
import { isOnDoNotCallList, checkCallingWindow, type CallingWindowResult } from "@weeber/compliance";
import { db } from "../../database";
import { orgs } from "../../database/schema";
import { dncAdapter } from "./adapters";
import { checkFtsaAttemptCap } from "./attempt-cap";
import { checkInsuranceNumberSeriesCompliance, checkInsuranceProducerLicensing } from "./insurance-gates";
import { checkIndiaNumberSeriesCompliance } from "./number-series-gate";

/** Which gate refused, for callers that branch on it (the scheduler defers on
 * a calling-window refusal and cancels on DNC — see `dispatchScheduledCall`). */
export type OutboundGate =
  | "dnc"
  | "calling_window"
  | "attempt_cap"
  | "insurance_number_series"
  | "insurance_producer_licensing"
  | "india_number_series";

export type OutboundGateResult =
  | { allowed: true }
  | { allowed: false; gate: OutboundGate; reason: string };

/**
 * Calling-window check with the per-org self-expiring test-mode bypass layered
 * on top (`orgs.callingWindowTestModeUntil`, set via
 * POST /api/app/compliance/test-mode, always to now()+24h so it cannot be left
 * on by accident). Moved here from workflows/scheduler.ts so both the
 * scheduler's pre-check and this chokepoint read one implementation.
 *
 * Note this is a deliberate *unification*, not a widening by oversight: the
 * campaign route previously went through `checkOutboundCallCompliance`, which
 * calls `checkCallingWindow` with no test-mode awareness, so the same org in
 * test mode got different answers from the scheduler and from the campaign
 * route. The two insurance gates already honoured test mode on both paths.
 * DNC and the FTSA attempt cap are never bypassed by test mode.
 */
export async function checkCallingWindowForOrg(
  orgId: string | null | undefined,
  toNumber: string,
): Promise<CallingWindowResult> {
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

/**
 * Non-production-only escape hatch, centralised here so there is exactly one
 * of it in the codebase. `BYPASS_COMPLIANCE=true` is hard-ignored in
 * production regardless of its value (a stale staging config shipped to prod
 * must not be able to disable compliance), and — tightened by ADR-096 — it no
 * longer covers DNC even in dev. voice/routes.ts's own comment already claimed
 * "DNC has no bypass anywhere in this codebase, on purpose"; that claim was
 * false for this env var, because the bypass skipped the whole block including
 * `checkOutboundCallCompliance`'s DNC check. Now it is true.
 */
function nonProdBypassActive(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.BYPASS_COMPLIANCE === "true";
}

/**
 * The gate. Runs every dial-time compliance check for one (org, destination)
 * pair and refuses on the first failure. Fails CLOSED: a check that throws is
 * a refusal, not a pass, because the alternative is placing an unscreened call
 * whose downside is uncapped statutory damages while the downside of a false
 * refusal is one unplaced call and a log line.
 *
 * Not included, on purpose: ADR-092's `isAgentDispatchable`. That is an
 * outbound *dispatch* switch, not a legal gate, and ADR-092 decided
 * explicitly that it does not belong here — `placeOutboundCall`'s only
 * `agentKey`-passing callers are the two test-call endpoints, which must keep
 * working for a paused agent. It stays a scheduler gate.
 */
async function runOutboundGates(
  orgId: string | null | undefined,
  to: string,
): Promise<OutboundGateResult> {
  // DNC first and unconditionally — it is the one check with no bypass on any
  // path, in any environment.
  try {
    if (await isOnDoNotCallList(dncAdapter, to)) {
      return { allowed: false, gate: "dnc", reason: "This number is on the Do Not Call list." };
    }
  } catch (err) {
    return {
      allowed: false,
      gate: "dnc",
      reason: `Do Not Call list could not be checked, so the call was refused: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (nonProdBypassActive()) return { allowed: true };

  try {
    const windowCheck = await checkCallingWindowForOrg(orgId, to);
    if (!windowCheck.allowed) {
      return { allowed: false, gate: "calling_window", reason: windowCheck.reason };
    }

    const attemptCapCheck = await checkFtsaAttemptCap(to);
    if (!attemptCapCheck.allowed) {
      return { allowed: false, gate: "attempt_cap", reason: attemptCapCheck.reason };
    }

    const numberSeriesCheck = await checkInsuranceNumberSeriesCompliance(orgId, to);
    if (!numberSeriesCheck.allowed) {
      return { allowed: false, gate: "insurance_number_series", reason: numberSeriesCheck.reason };
    }

    const producerLicensingCheck = await checkInsuranceProducerLicensing(orgId, to);
    if (!producerLicensingCheck.allowed) {
      return { allowed: false, gate: "insurance_producer_licensing", reason: producerLicensingCheck.reason };
    }

    const generalNumberSeriesCheck = await checkIndiaNumberSeriesCompliance(orgId, to);
    if (!generalNumberSeriesCheck.allowed) {
      return { allowed: false, gate: "india_number_series", reason: generalNumberSeriesCheck.reason };
    }
  } catch (err) {
    // Fail closed. See doc comment.
    console.error("[compliance] outbound gate errored — refusing the call", err);
    return {
      allowed: false,
      gate: "calling_window",
      reason: `Compliance checks could not be completed, so the call was refused: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return { allowed: true };
}

/**
 * The three gates a live demo is expected to run without: the calling window and
 * the two insurance-vertical *configuration* gates. `orgs.callingWindowTestModeUntil`
 * lifts exactly these. DNC and the FTSA attempt cap are absent on purpose — they are
 * never bypassed, so a refusal from either is never a test-mode problem and must not
 * be described as one.
 */
const TEST_MODE_BYPASSABLE: ReadonlySet<OutboundGate> = new Set([
  "calling_window",
  "insurance_number_series",
  "insurance_producer_licensing",
]);

function formatElapsed(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * Why this exists: test mode is self-expiring by design (24h, so it cannot be left
 * on in production), and the failure it produces on expiry is indistinguishable from
 * "this org was never configured". A founder mid-demo got the full TRAI 1600-series
 * registration paragraph — accurate, and the wrong thing to read out when the actual
 * remedy is one toggle. This appends the diagnosis to the gate's own reason instead
 * of replacing it: the registration requirement is still real and still stated.
 *
 * Only runs on the refusal path, so the happy path pays nothing. Deliberately
 * best-effort: this is an error-message improvement, and it must never turn a clean
 * refusal into a thrown exception, so any failure here yields no suffix at all.
 */
async function expiredTestModeHint(
  orgId: string | null | undefined,
  gate: OutboundGate,
): Promise<string> {
  if (!orgId || !TEST_MODE_BYPASSABLE.has(gate)) return "";
  try {
    const [org] = await db
      .select({ callingWindowTestModeUntil: orgs.callingWindowTestModeUntil })
      .from(orgs)
      .where(eq(orgs.id, orgId))
      .limit(1);
    const until = org?.callingWindowTestModeUntil;
    // Never set: this org has no demo history, so a test-mode hint would be noise.
    // Still active: the refusal came from a gate test mode does not lift, so
    // blaming test mode would actively mislead.
    if (!until || until.getTime() > Date.now()) return "";
    return (
      ` — NOTE: demo/test mode expired ${formatElapsed(Date.now() - until.getTime())}` +
      ` (${until.toISOString()}), and it is what was allowing this call.` +
      ` Re-enable it on the Settings page for another 24 hours, or complete the registration above.`
    );
  } catch {
    return "";
  }
}

/**
 * Public chokepoint. `runOutboundGates` owns the fail-closed decision and is left
 * untouched by this wrapper; all this adds is a legible reason on refusal. Keeping
 * the two separate means the enforcement logic stays readable on its own and the
 * message-decoration path cannot alter an allow/deny outcome.
 */
export async function assertOutboundCallAllowed(
  orgId: string | null | undefined,
  to: string,
): Promise<OutboundGateResult> {
  const result = await runOutboundGates(orgId, to);
  if (result.allowed) return result;
  const hint = await expiredTestModeHint(orgId, result.gate);
  return hint ? { ...result, reason: `${result.reason}${hint}` } : result;
}
