import { checkCallingWindow, type CallingWindowOptions, type CallingWindowResult } from "./calling-window";
import { isOnDoNotCallList } from "./dnc";
import type { ConsentPurpose, ConsentStorageAdapter, DncStorageAdapter } from "./storage";

export * from "./calling-window";
export * from "./dnc";
export * from "./consent";
export * from "./hipaa";
export * from "./gdpr";
export * from "./storage";
export * from "./adapters/memory";
export * from "./national-dnc";
export * from "./audit-trail";
export * from "./packs/us";
export * from "./packs/india";

export type OutboundComplianceResult =
  | { allowed: true }
  | { allowed: false; reason: string; failedCheck: "dnc" | "calling-window" | "consent" };

/**
 * Optional purpose-scoped consent check (Global Compliance Engine Tier 0, 2026-07-16,
 * docs/global-compliance-engine-plan.md #6) — pass this to `checkOutboundCallCompliance` to gate
 * a dial on a `ConsentStorageAdapter` grant for the given `purpose`. Deliberately opt-in: existing
 * callers that don't pass this keep today's behavior unchanged (DNC + calling-window only) — this
 * package doesn't force every integration to adopt purpose-scoped consent in one breaking change.
 * Wire it in once your own schema/adapter (see storage.ts's ConsentStorageAdapter) is ready.
 */
export type ConsentCheckOptions = {
  adapter: ConsentStorageAdapter;
  purpose: ConsentPurpose;
};

/**
 * The single call most integrations need: run every automatic pre-call
 * compliance gate (Do-Not-Call list, TCPA calling window, and — if wired —
 * purpose-scoped consent) before dialing. Wire this into your outbound-call
 * route/function and reject/skip the call when `allowed` is false — see
 * README "Wiring it into your call flow".
 */
export async function checkOutboundCallCompliance(
  toNumber: string,
  dncAdapter: DncStorageAdapter,
  callingWindowOptions?: CallingWindowOptions,
  consentCheck?: ConsentCheckOptions,
): Promise<OutboundComplianceResult> {
  if (await isOnDoNotCallList(dncAdapter, toNumber)) {
    return { allowed: false, reason: "This number is on the Do Not Call list.", failedCheck: "dnc" };
  }

  if (consentCheck) {
    const hasConsent = await consentCheck.adapter.hasConsent(toNumber, consentCheck.purpose);
    if (!hasConsent) {
      return {
        allowed: false,
        reason: `No active consent on record for purpose "${consentCheck.purpose}" — the recipient hasn't granted it, it expired, or it was withdrawn.`,
        failedCheck: "consent",
      };
    }
  }

  const windowCheck: CallingWindowResult = checkCallingWindow(toNumber, new Date(), callingWindowOptions);
  if (!windowCheck.allowed) {
    return {
      allowed: false,
      reason: `Blocked by calling-window compliance check: ${windowCheck.reason}`,
      failedCheck: "calling-window",
    };
  }

  return { allowed: true };
}
