/**
 * A3 (phase-a-integrity.md) — persist captured state per turn, not at hangup.
 *
 * Production calls 1 and 2 (docs/audits/2026-08-21-first-two-production-calls.md,
 * finding 3) each wrote 7-8 of their 12 `captureField` calls inside the same
 * ~30ms window at hangup — a batch flushed at the end, not a running record
 * kept as the caller actually said things. `stream.ts`'s `mergeCapturedField`
 * already persists on every call and was never the defect; the defect was the
 * *model* choosing to emit its captures in a cluster on the last turn instead
 * of the turn each fact was actually stated on. The fix for that is a prompt
 * instruction (see agent.ts's `immediateCaptureLine`), which this module has
 * nothing to do with — this module is the measurement that proves the fix
 * worked, using the `turn` field ADR-120/A1 already put on every
 * `CapturedField` entry for exactly this purpose.
 *
 * Deliberately just a counter, not a persisted metric: Phase B is what turns
 * this into something aggregated and queryable across calls. Here it only has
 * to exist and be correct, so a defect in the underlying prompt behaviour is
 * at least visible in the logs before Phase B builds a query over it.
 */
import type { CapturedField } from "../database/schema";

export type CaptureTimingCounts = {
  /** Captured on an earlier caller turn than the call's last one — a running record, as intended. */
  midCall: number;
  /**
   * Captured on the same caller turn as the call's last one. Not automatically
   * a defect — a fact stated in the caller's final sentence is legitimately
   * captured on the final turn — but a call whose captures cluster here is
   * exactly the batching pattern findings 3/4 describe.
   */
  finalTurn: number;
};

/**
 * `finalCallerTurn` is the caller-turn count at the moment the call ends
 * (`stream.ts`'s `callerTranscriptCount` at `finalizeCall`) — the same value
 * `CapturedField.turn` was stamped with when it equals the entry's own turn.
 * An empty `capturedState` (nothing captured this call) returns all zeros
 * rather than throwing — a call that captured nothing has no timing defect to
 * report.
 */
export function countCapturesByTurnTiming(
  capturedState: Record<string, CapturedField>,
  finalCallerTurn: number,
): CaptureTimingCounts {
  let midCall = 0;
  let finalTurn = 0;
  for (const entry of Object.values(capturedState)) {
    if (entry.turn >= finalCallerTurn) finalTurn++;
    else midCall++;
  }
  return { midCall, finalTurn };
}
