/**
 * Insurance-vertical-specific dial-time compliance gates (2026-07-16,
 * docs/agent-prompts/00-insurance-regulatory-reference.md, "Platform gaps" #1/#2). Both gates are
 * no-ops for any non-insurance org — this file only ever changes behavior for `orgs.vertical ===
 * "insurance"`, exactly like every other vertical-specific check in this codebase (Shopify-only
 * tools stay Shopify-scoped, these stay insurance-scoped).
 *
 * Wired into the same two dispatch points as DNC/calling-window
 * (workflows/scheduler.ts's dispatchScheduledCall, voice/routes.ts's manual /calls/outbound) so a
 * scheduled retry and a manual call go through identical gates — same discipline as the existing
 * compliance checks, a manual call was never meant to be a way to route around a gate.
 */
import { eq, and } from "drizzle-orm";
import { resolveUsState } from "@weeber/compliance";
import { db } from "../../database";
import { orgs, orgPhoneNumbers, insuranceAdvisors } from "../../database/schema";

export type InsuranceGateResult =
  | { allowed: true }
  | { allowed: false; reason: string };

function isIndianNumber(e164: string): boolean {
  return /^\+91\d{10}$/.test(e164);
}

function isNanpNumber(e164: string): boolean {
  return /^\+1\d{10}$/.test(e164);
}

/**
 * Self-expiring, org-scoped "test mode" bypass (orgs.callingWindowTestModeUntil, set via
 * POST /api/app/compliance/test-mode → now()+24h). Originally added for the TCPA/TRAI
 * calling-window check; extended (2026-07-19) to ALSO lift these two insurance-vertical config
 * gates so a founder can run a live phone demo to pilots — including at night and before the
 * 1600-series number / state-licensed-advisor paperwork is in place — using their own Twilio
 * numbers. Same self-expiring discipline as the calling-window bypass: it can't be left on
 * indefinitely. DNC and the FTSA attempt cap are NEVER bypassed by test mode, here or anywhere.
 */
function isTestModeActive(testModeUntil: Date | null | undefined): boolean {
  return Boolean(testModeUntil && testModeUntil.getTime() > Date.now());
}

/**
 * India — TRAI/IRDAI 1600-series mandate. IRDAI-regulated entities must place service/
 * transactional calls from a dedicated 1600-series number, not the general 140 (promotional)/160
 * (transactional) series most orgs use — a real, separate requirement, deadline Feb 15, 2026
 * (already passed as of this writing). Checks whether this org has ANY active phone number
 * registered as 1600-series — doesn't try to resolve which specific number `placeOutboundCall`
 * will actually dial from (that resolution already happens in `resolveOutboundRouting`, which has
 * its own fallback chain); this is a coarser "is this org even set up to be compliant at all"
 * gate, matching the other compliance checks' philosophy of failing closed rather than trying to
 * be clever about partial configurations.
 */
export async function checkInsuranceNumberSeriesCompliance(
  orgId: string | null | undefined,
  toNumber: string,
): Promise<InsuranceGateResult> {
  if (!orgId) return { allowed: true };
  if (!isIndianNumber(toNumber)) return { allowed: true };

  const [org] = await db
    .select({ vertical: orgs.vertical, callingWindowTestModeUntil: orgs.callingWindowTestModeUntil })
    .from(orgs)
    .where(eq(orgs.id, orgId))
    .limit(1);
  if (org?.vertical !== "insurance") return { allowed: true };
  // Self-expiring test-mode bypass — lets founders run a live phone demo before the 1600-series
  // number is registered. See isTestModeActive's doc comment.
  if (isTestModeActive(org.callingWindowTestModeUntil)) return { allowed: true };

  const [compliantNumber] = await db
    .select({ id: orgPhoneNumbers.id })
    .from(orgPhoneNumbers)
    .where(and(eq(orgPhoneNumbers.orgId, orgId), eq(orgPhoneNumbers.status, "active"), eq(orgPhoneNumbers.numberSeries, "1600")))
    .limit(1);

  if (!compliantNumber) {
    return {
      allowed: false,
      reason:
        "This org is insurance-vertical and calling an India number, but has no active phone number " +
        "registered as TRAI 1600-series — required for IRDAI-regulated service/transactional calls. " +
        "Register a 1600-series number for this org before dialing India numbers.",
    };
  }
  return { allowed: true };
}

/**
 * US — state producer licensing. A producer must be licensed in the state the prospect resides
 * in; every insurance script here already refuses to solicit/sell itself and routes to "a
 * licensed advisor," but nothing previously verified that advisor is actually licensed where the
 * lead lives. Resolves the lead's state from their area code (best-effort — see
 * `resolveUsState`'s doc comment for the known limitations of phone-number-based jurisdiction
 * inference) and checks it against this org's `insuranceAdvisors.licensedStates`.
 *
 * An unresolved state (area code not in the map, or a non-NANP-shaped number) does NOT block —
 * failing open on ambiguity here, unlike the DNC/hard gates, because blocking every call to an
 * unrecognized area code would be far more disruptive than the risk it's guarding against, and
 * matches `checkUsCallingWindow`'s own existing "safe fallback" philosophy for unresolved area
 * codes rather than inventing a stricter standard just for this check.
 *
 * An EMPTY roster also does not block (ADR-098) — see the inline comment at the check itself. The
 * gate enforces against a roster the org has actually asserted; it does not treat the absence of a
 * roster as an assertion of no coverage.
 */
export async function checkInsuranceProducerLicensing(
  orgId: string | null | undefined,
  toNumber: string,
): Promise<InsuranceGateResult> {
  if (!orgId) return { allowed: true };
  if (!isNanpNumber(toNumber)) return { allowed: true };

  const [org] = await db
    .select({ vertical: orgs.vertical, callingWindowTestModeUntil: orgs.callingWindowTestModeUntil })
    .from(orgs)
    .where(eq(orgs.id, orgId))
    .limit(1);
  if (org?.vertical !== "insurance") return { allowed: true };
  // Self-expiring test-mode bypass — lets founders run a live phone demo before a state-licensed
  // advisor is on file. See isTestModeActive's doc comment.
  if (isTestModeActive(org.callingWindowTestModeUntil)) return { allowed: true };

  const state = resolveUsState(toNumber);
  if (!state) {
    // Can't enforce what we can't detect — see doc comment above.
    return { allowed: true };
  }

  const advisors = await db
    .select({ licensedStates: insuranceAdvisors.licensedStates })
    .from(insuranceAdvisors)
    .where(eq(insuranceAdvisors.orgId, orgId));

  // ADR-098 — an unconfigured roster is not a failed licensing claim.
  //
  // ADR-096 put this gate on all five dial paths, which turned an empty
  // `insurance_advisors` table into a total US dialing block for every
  // insurance org, including test calls. That is the wrong default: an org
  // that has never entered a roster has made no claim about its coverage,
  // whereas an org with a roster that excludes this state has. Those are
  // different facts and they now get different answers — empty allows and
  // warns, non-empty enforces. Note this gate already fails open on an
  // unresolved area code a few lines above, so refusing here was also
  // internally inconsistent: an org with no roster was treated more harshly
  // than a number whose state we could not determine at all.
  //
  // The warning is deliberately loud and unconditional (not sampled, not
  // debug-level): it is the only signal that a real US solicitation went out
  // without a licensing check, and audit follow-up depends on it being
  // greppable in logs.
  if (advisors.length === 0) {
    console.warn(
      `[compliance] insurance org ${orgId} has no advisors on file — producer licensing NOT verified ` +
        `for a call to ${state}. Allowing (ADR-098). Populate Settings → Licensed advisors to enforce.`,
    );
    return { allowed: true };
  }

  const isLicensed = advisors.some((advisor) => advisor.licensedStates.includes(state));
  if (!isLicensed) {
    return {
      allowed: false,
      reason:
        `No licensed advisor on file for this org is licensed in ${state} (resolved from the ` +
        `recipient's area code) — a producer must be licensed in the state the prospect resides in ` +
        `before this call can proceed. Add an advisor licensed in ${state}, or confirm this number's ` +
        `actual state if the area-code-based resolution is wrong.`,
    };
  }
  return { allowed: true };
}
