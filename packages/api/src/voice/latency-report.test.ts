import { describe, it, expect } from "bun:test";
import {
  ADR_107_CUTOVER,
  computeStats,
  partitionByAdr107Cutover,
  computeV2vDecomposition,
  summarizeGuardrailEvents,
  summarizeCaptureTiming,
  summarizeByOrg,
  type TurnLatencyRow,
} from "./latency-report";
import type { CapturedField } from "../database/schema";

function fact(value: string, turn: number): CapturedField {
  return { value, heard: value, transcriptId: null, turn };
}

describe("computeStats — nearest-rank percentile", () => {
  it("pins the p50 convention on a known even-length set", () => {
    // [10,20,30,40,50,60,70,80,90,100] — nearest-rank p50 at n=10 is index
    // ceil(0.5*10)-1 = 4 -> value 50 (the convention this test pins so a
    // future refactor can't silently switch to interpolated/average p50
    // without a test noticing).
    const stats = computeStats([100, 20, 80, 40, 60, 10, 90, 30, 70, 50]);
    expect(stats.p50).toBe(50);
    expect(stats.min).toBe(10);
    expect(stats.max).toBe(100);
    expect(stats.n).toBe(10);
  });

  it("computes p95 on the same set", () => {
    // ceil(0.95*10)-1 = 9 -> value 100 (the max, at n=10).
    const stats = computeStats([100, 20, 80, 40, 60, 10, 90, 30, 70, 50]);
    expect(stats.p95).toBe(100);
  });

  it("filters out null/undefined without treating them as zero", () => {
    const stats = computeStats([10, null, 20, undefined, 30]);
    expect(stats.n).toBe(3);
    expect(stats.min).toBe(10);
    expect(stats.max).toBe(30);
  });

  it("returns nulls and n:0 for an empty or all-null sample", () => {
    expect(computeStats([])).toEqual({ p50: null, p95: null, min: null, max: null, n: 0 });
    expect(computeStats([null, undefined])).toEqual({ p50: null, p95: null, min: null, max: null, n: 0 });
  });
});

describe("partitionByAdr107Cutover", () => {
  it("excludes a pre-cutover row and includes a post-cutover row", () => {
    const preCutover = { callStartedAt: new Date("2026-08-11T23:59:59Z"), value: "old" };
    const postCutover = { callStartedAt: new Date("2026-08-12T00:00:01Z"), value: "new" };
    const { included, excluded } = partitionByAdr107Cutover([preCutover, postCutover]);
    expect(included).toEqual([postCutover]);
    expect(excluded).toEqual([preCutover]);
  });

  it("treats the cutover instant itself as included", () => {
    const atCutover = { callStartedAt: ADR_107_CUTOVER, value: "boundary" };
    const { included, excluded } = partitionByAdr107Cutover([atCutover]);
    expect(included).toEqual([atCutover]);
    expect(excluded).toEqual([]);
  });

  it("accepts a custom cutover for testing without relying on the real date", () => {
    const row = { callStartedAt: new Date("2020-01-01"), value: "x" };
    const { included } = partitionByAdr107Cutover([row], new Date("2019-01-01"));
    expect(included).toEqual([row]);
  });
});

function turnRow(overrides: Partial<TurnLatencyRow> = {}): TurnLatencyRow {
  return {
    callStartedAt: new Date("2026-08-20T00:00:00Z"),
    voiceToVoiceMs: null,
    llmTtftMs: null,
    ttsFirstByteMs: null,
    ttsSocketOpenMs: null,
    endpointingDelayMs: null,
    llmInputTokens: null,
    llmCachedInputTokens: null,
    llmOutputTokens: null,
    ...overrides,
  };
}

describe("computeV2vDecomposition", () => {
  it("computes the LLM/TTS/other split from p50s, summing to 100", () => {
    // llm p50 700, tts p50 240, v2v p50 1000 -> 70/24/6.
    const rows = [
      turnRow({ voiceToVoiceMs: 1000, llmTtftMs: 700, ttsFirstByteMs: 240 }),
      turnRow({ voiceToVoiceMs: 1000, llmTtftMs: 700, ttsFirstByteMs: 240 }),
      turnRow({ voiceToVoiceMs: 1000, llmTtftMs: 700, ttsFirstByteMs: 240 }),
    ];
    const decomposition = computeV2vDecomposition(rows);
    expect(decomposition.llmSharePct).toBe(70);
    expect(decomposition.ttsSharePct).toBe(24);
    expect(decomposition.otherSharePct).toBe(6);
    expect(
      (decomposition.llmSharePct ?? 0) + (decomposition.ttsSharePct ?? 0) + (decomposition.otherSharePct ?? 0),
    ).toBe(100);
  });

  it("returns all-null when there is no v2v data", () => {
    expect(computeV2vDecomposition([])).toEqual({ llmSharePct: null, ttsSharePct: null, otherSharePct: null });
  });

  it("a pre-cutover row is excluded from the decomposition (via partitionByAdr107Cutover) and counted in the exclusion total", () => {
    const preCutover = turnRow({
      callStartedAt: new Date("2026-08-01T00:00:00Z"),
      voiceToVoiceMs: 5000,
      llmTtftMs: 4000,
      ttsFirstByteMs: 4000, // pre-cutover: overlaps llmTtftMs almost entirely (ADR-107)
    });
    const postCutover = turnRow({
      callStartedAt: new Date("2026-08-20T00:00:00Z"),
      voiceToVoiceMs: 1000,
      llmTtftMs: 700,
      ttsFirstByteMs: 240,
    });
    const { included, excluded } = partitionByAdr107Cutover([preCutover, postCutover]);
    expect(excluded).toEqual([preCutover]);
    expect(included).toEqual([postCutover]);

    // The decomposition run against `included` only must not be dragged
    // toward the pre-cutover row's (semantically invalid, post-hoc
    // overlapping) numbers.
    const decomposition = computeV2vDecomposition(included);
    expect(decomposition.llmSharePct).toBe(70);
  });
});

describe("summarizeGuardrailEvents", () => {
  it("groups by category and source, distinguishing two sources of the same category (A4)", () => {
    const counts = summarizeGuardrailEvents([
      { category: "undelivered-outcome", source: "crm-sync" },
      { category: "undelivered-outcome", source: "crm-sync" },
      { category: "undelivered-outcome", source: "setDisposition-invariant" },
      { category: "fabricated-capture", source: "capture-guard" },
    ]);
    expect(counts).toEqual({
      "undelivered-outcome (crm-sync)": 2,
      "undelivered-outcome (setDisposition-invariant)": 1,
      "fabricated-capture (capture-guard)": 1,
    });
  });

  it("returns an empty object for no rows", () => {
    expect(summarizeGuardrailEvents([])).toEqual({});
  });
});

describe("summarizeCaptureTiming", () => {
  it("aggregates mid-call vs final-turn captures across multiple calls", () => {
    const perCall: { capturedState: Record<string, CapturedField>; callerTurnCount: number }[] = [
      { capturedState: { email: fact("a@b.com", 1), tobacco: fact("no", 5) }, callerTurnCount: 5 }, // 1 mid, 1 final
      { capturedState: { order_id: fact("ORD-1", 9), name: fact("Jamie", 9) }, callerTurnCount: 9 }, // 2 final
    ];
    expect(summarizeCaptureTiming(perCall)).toEqual({ midCall: 1, finalTurn: 3 });
  });

  it("returns zeros for no calls", () => {
    expect(summarizeCaptureTiming([])).toEqual({ midCall: 0, finalTurn: 0 });
  });
});

describe("summarizeByOrg", () => {
  it("groups by org, counting distinct calls and computing per-org v2v p50", () => {
    const rows = [
      { ...turnRow({ voiceToVoiceMs: 1000 }), orgId: "org-a", callId: 1 },
      { ...turnRow({ voiceToVoiceMs: 2000 }), orgId: "org-a", callId: 1 }, // same call, second turn
      { ...turnRow({ voiceToVoiceMs: 1500 }), orgId: "org-a", callId: 2 },
      { ...turnRow({ voiceToVoiceMs: 3000 }), orgId: "org-b", callId: 3 },
    ];
    const summary = summarizeByOrg(rows);
    const orgA = summary.find((r) => r.orgId === "org-a");
    const orgB = summary.find((r) => r.orgId === "org-b");
    expect(orgA?.callCount).toBe(2);
    expect(orgB?.callCount).toBe(1);
    expect(orgB?.voiceToVoiceP50).toBe(3000);
  });

  it("buckets a null orgId under a labeled group rather than dropping the row", () => {
    const rows = [{ ...turnRow({ voiceToVoiceMs: 1000 }), orgId: null, callId: 1 }];
    const summary = summarizeByOrg(rows);
    expect(summary).toEqual([{ orgId: "(no org)", callCount: 1, voiceToVoiceP50: 1000 }]);
  });
});
