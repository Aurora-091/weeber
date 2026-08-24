import { describe, it, expect } from "bun:test";
import { countCapturesByTurnTiming } from "./capture-timing";
import type { CapturedField } from "../database/schema";

function entry(turn: number): CapturedField {
  return { value: "x", heard: "x", transcriptId: null, turn };
}

describe("countCapturesByTurnTiming — A3, phase-a-integrity.md", () => {
  it("distinguishes a mid-call capture from one recorded on the final caller turn", () => {
    const capturedState: Record<string, CapturedField> = {
      email: entry(2), // stated on caller turn 2 of an eventual 5 — a running record
      tobacco: entry(5), // stated on the final caller turn — could be batching
    };
    expect(countCapturesByTurnTiming(capturedState, 5)).toEqual({ midCall: 1, finalTurn: 1 });
  });

  it("counts every entry as finalTurn when a call batches everything at hangup — the call-2 pattern", () => {
    const capturedState: Record<string, CapturedField> = {
      email: entry(9),
      order_id: entry(9),
      tobacco: entry(9),
    };
    expect(countCapturesByTurnTiming(capturedState, 9)).toEqual({ midCall: 0, finalTurn: 3 });
  });

  it("counts every entry as midCall when captures land progressively through the call", () => {
    const capturedState: Record<string, CapturedField> = {
      email: entry(1),
      order_id: entry(3),
      tobacco: entry(6),
    };
    expect(countCapturesByTurnTiming(capturedState, 9)).toEqual({ midCall: 3, finalTurn: 0 });
  });

  it("returns all zeros for a call that captured nothing", () => {
    expect(countCapturesByTurnTiming({}, 9)).toEqual({ midCall: 0, finalTurn: 0 });
  });
});
