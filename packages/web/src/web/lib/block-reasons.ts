/**
 * Friendly copy for a scheduled call's persisted block reason (2026-07-19).
 *
 * The scheduler persists a machine reason (scheduled_calls.last_block_reason)
 * whenever a compliance gate stops a scheduled/workflow call from going out —
 * one of the DispatchResult reason enum values in
 * packages/api/src/voice/workflows/scheduler.ts. Both the merchant Orders page
 * and the admin compliance oversight view render that reason, so the label +
 * short explanation live here once instead of being duplicated (and drifting)
 * across the two surfaces. `detail` (last_block_detail) is the exact
 * human-readable sentence the gate itself produced and is shown alongside;
 * this map is the stable, friendly headline for the reason code.
 */
export type BlockReason =
  | "dnc"
  | "calling_window"
  | "attempt_cap"
  | "insurance_number_series"
  | "insurance_producer_licensing"
  | "india_number_series"
  | "place_failed";

type BlockReasonMeta = {
  /** Short badge label. */
  label: string;
  /** One-line plain-English explanation of what this gate does. */
  description: string;
  /** Whether this is a "will retry automatically" block vs. a hard stop. */
  transient: boolean;
};

const BLOCK_REASONS: Record<BlockReason, BlockReasonMeta> = {
  dnc: {
    label: "Do Not Call",
    description: "This number is on the Do Not Call list, so the call was cancelled and won't be retried.",
    transient: false,
  },
  calling_window: {
    label: "Outside calling hours",
    description: "The number is outside its permitted calling window right now — we'll try again automatically when it opens.",
    transient: true,
  },
  attempt_cap: {
    label: "Attempt limit reached",
    description: "The max number of call attempts in the allowed window has been hit — we'll retry once the window rolls over.",
    transient: true,
  },
  insurance_number_series: {
    label: "Blocked number series",
    description: "This number falls in a series blocked by insurance-vertical rules, so the call wasn't placed.",
    transient: false,
  },
  insurance_producer_licensing: {
    label: "Producer not licensed",
    description: "No licensed producer covers this number's region, so the call was blocked for compliance.",
    transient: false,
  },
  india_number_series: {
    label: "Blocked number series",
    description: "This number falls in a series blocked by India DLT number-series rules, so the call wasn't placed.",
    transient: false,
  },
  place_failed: {
    label: "Couldn't place call",
    description: "The call passed every compliance check but the telephony provider failed to place it.",
    transient: false,
  },
};

const UNKNOWN: BlockReasonMeta = {
  label: "Blocked",
  description: "This call was blocked before it went out.",
  transient: false,
};

export function blockReasonMeta(reason: string | null | undefined): BlockReasonMeta {
  if (!reason) return UNKNOWN;
  return BLOCK_REASONS[reason as BlockReason] ?? { ...UNKNOWN, label: reason };
}
