/**
 * Hand-off integrity (ADR-105).
 *
 * WHY THIS EXISTS
 * ---------------
 * Production call 25 — outbound, a real lead, the launch final-expense
 * qualifier — spoke this and then hung up on the caller:
 *
 *   "Let me connect you with a licensed advisor right now; they'll go over
 *    your real options and answer every question. One moment while I get them
 *    on the line. You're connected — the advisor will take great care of you."
 *
 * Nobody was connected. `orgs.human_transfer_number` is NULL on all four
 * production orgs and `insurance_advisors` is empty, so `performTransfer`
 * resolved no target, took its "no transfer number configured anywhere"
 * branch, and fell through to `performHangUp`. The call row was written
 * `status = "completed"`, `disposition = "booked"`, `health_status =
 * "healthy"` — a warm lead recorded as a conversion, hung up on mid-promise,
 * and nothing anywhere in the stack disagreed.
 *
 * Two separate defects produced that transcript, and this module owns the
 * first one:
 *
 *   F1 — the model was offered a `transferToHuman` tool that could not
 *        possibly succeed on this call, and its persona told it that a live
 *        warm transfer is the best outcome. It did exactly as instructed.
 *   F2 — `transferLatched` (stream.ts) gated only `hangUp`, so STT stayed
 *        open after the hand-off and a late caller utterance ran a whole
 *        second turn, re-firing the transfer and re-speaking the "You're
 *        connected" line verbatim. Fixed at that latch, not here.
 *
 * The fix for F1 is the shape `crmSync` already uses (G1.4 / ADR-069): a
 * capability the *server* resolves once from config it can actually verify,
 * and a tool that is **omitted entirely** when the capability is absent —
 * rather than a tool that exists, gets called, and fails at the far end after
 * the caller has already been promised the outcome. A tool the model cannot
 * see is a promise the model cannot make.
 *
 * WHY NOT JUST POPULATE THE NUMBER
 * --------------------------------
 * That fixes today's four orgs and leaves the defect in place. Every org
 * self-serves its own `humanTransferNumber` and none is required to set one,
 * so "configured" is a state the product must handle correctly, not an
 * onboarding step to remember. This is ADR-098's class of defect (a gate that
 * depends on a table nobody populated) and ADR-090's (code with no caller);
 * the lesson both times was to make the unconfigured path behave honestly.
 *
 * WHY IT IS PURE
 * --------------
 * Same reason `call-health.ts` is: stream.ts does the I/O (one `orgs` lookup
 * it already performs) and hands the resolved facts in. No DB, no clock, so
 * the decision table is exhaustively unit-testable and cannot drift from what
 * `performTransfer` will actually attempt at runtime.
 */

import { AVAILABLE_TOOL_NAMES, type AvailableToolName } from "./agent-frame";

/**
 * Telephony providers with a wired-up, verified mid-call transfer path.
 *
 * Deliberately a copy of the condition inside `performTransfer` rather than a
 * clever shared abstraction over it — this list exists so the *tool-offering*
 * decision and the *transfer-attempting* decision are provably the same
 * decision, and `assertTransferProvidersMatchPerformTransfer` in the test
 * suite fails if they diverge. Exotel has no confirmed REST action for an
 * already-connected call (docs/india-telephony.md), so an Exotel call cannot
 * transfer and must not be offered the tool.
 */
export const TRANSFER_CAPABLE_PROVIDERS = ["twilio", "plivo"] as const;

export type TransferCapableProvider = (typeof TRANSFER_CAPABLE_PROVIDERS)[number];

/** Why a call cannot hand off to a person. `null` when it can. */
export type TransferBlockedReason =
  /** No `orgs.humanTransferNumber` — true on all four production orgs as of 2026-08-12. */
  | "no-transfer-number"
  /** Call has no resolved org, so there is no per-org number to resolve at all. */
  | "no-org"
  /** Provider has no wired-up mid-call transfer API (e.g. Exotel). */
  | "provider-unsupported";

export interface TransferCapabilityInput {
  /** `orgs.humanTransferNumber` for this call's org, already resolved. */
  transferNumber: string | null | undefined;
  /** This call's telephony provider, as recorded on the call row. */
  provider: string | undefined;
  /** Whether an org was resolved for this call at all. */
  hasOrg: boolean;
}

export interface TransferCapability {
  /** True only when a transfer would actually be attempted AND has a target. */
  canTransfer: boolean;
  reason: TransferBlockedReason | null;
}

/**
 * Whether this call can genuinely hand off to a human.
 *
 * Order of checks is deliberate: `no-org` is reported ahead of
 * `no-transfer-number` because an org-less call (text test-chat, the synthetic
 * harness, the preview drawer) is not a misconfiguration anyone should be
 * asked to fix, and ahead of `provider-unsupported` because those surfaces
 * have no telephony provider either. A blank or whitespace-only number counts
 * as absent — a stored empty string is a configuration mistake, not a target.
 */
export function resolveTransferCapability(input: TransferCapabilityInput): TransferCapability {
  if (!input.hasOrg) return { canTransfer: false, reason: "no-org" };
  if (!isTransferCapableProvider(input.provider)) {
    return { canTransfer: false, reason: "provider-unsupported" };
  }
  if (!input.transferNumber || input.transferNumber.trim() === "") {
    return { canTransfer: false, reason: "no-transfer-number" };
  }
  return { canTransfer: true, reason: null };
}

export function isTransferCapableProvider(provider: string | undefined): provider is TransferCapableProvider {
  return (TRANSFER_CAPABLE_PROVIDERS as readonly string[]).includes(provider ?? "");
}

/**
 * Removes `transferToHuman` from a call's enabled-tool list when the call
 * cannot transfer.
 *
 * The `undefined` input case is the subtle one and the reason this is a
 * function rather than a filter at the call site. Throughout this codebase
 * `enabledTools === undefined` means "every tool is available" (see
 * `buildVoiceTools` and `buildCallControlBlock`, which share the convention).
 * So on a call with no agent-frame row — which is most calls today — there is
 * no list to filter, and a naive `.filter()` would leave `transferToHuman`
 * enabled precisely where nobody has configured anything. Materializing the
 * full list is what makes the removal real in that case.
 *
 * Returning `undefined` unchanged when the call *can* transfer is equally
 * deliberate: materializing the list unnecessarily would silently freeze
 * today's `AVAILABLE_TOOL_NAMES` onto the call, so a tool added later would
 * not reach calls that never had a frame row.
 */
export function narrowToolsForTransferCapability(
  enabledTools: AvailableToolName[] | undefined,
  capability: TransferCapability,
): AvailableToolName[] | undefined {
  if (capability.canTransfer) return enabledTools;
  const base = enabledTools ?? [...AVAILABLE_TOOL_NAMES];
  if (!base.includes("transferToHuman")) return enabledTools;
  return base.filter((name) => name !== "transferToHuman");
}

/**
 * One-line explanation for the warn log, written as the operator-facing defect
 * it is. `no-transfer-number` is the one an org can fix, so it says how.
 */
export function describeTransferBlock(reason: TransferBlockedReason): string {
  switch (reason) {
    case "no-transfer-number":
      return "this org has no humanTransferNumber configured — set one in Settings so qualified leads can reach a person";
    case "no-org":
      return "this call has no resolved org, so there is no per-org transfer number to resolve";
    case "provider-unsupported":
      return "this call's telephony provider has no wired-up mid-call transfer API";
  }
}
