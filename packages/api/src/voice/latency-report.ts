/**
 * B1 (phase-b-measurement.md) — one command that prints the latency
 * distribution, instead of the hours of hand-written `psql` the audit that
 * produced this plan took.
 *
 * Same split as `voice/call-quality.ts` / `scripts/call-quality-audit.ts`:
 * pure aggregation functions here (fixture-testable, no DB), a thin CLI
 * entry at `scripts/latency-report.ts` that does the actual querying and
 * calls into this module.
 *
 * ADR-107 (2026-08-12) is a semantic cutover, not a formatting change: rows
 * captured before it measured `ttsFirstByteMs` from the top of `speak()`
 * (before the LLM produced a token), so pre-cutover `ttsFirstByteMs` and
 * `llmTtftMs` overlap almost entirely and are not separable components of
 * `voiceToVoiceMs` the way they are post-cutover. Pooling the two eras
 * silently is exactly how the deep-research report's TTS-latency claim
 * survived — see `docs/audits/2026-08-21-first-two-production-calls.md`
 * finding 6. Every stats/decomposition function below operates on rows
 * already partitioned by `partitionByAdr107Cutover`; nothing in this module
 * pools across the boundary implicitly.
 */
import { countCapturesByTurnTiming } from "./capture-timing";
import type { CapturedField } from "../database/schema";

export const ADR_107_CUTOVER = new Date("2026-08-12T00:00:00Z");

export type Stats = {
  p50: number | null;
  p95: number | null;
  min: number | null;
  max: number | null;
  n: number;
};

/**
 * Nearest-rank percentile — same method as org-queries.ts's private
 * `percentile()` and scripts/latency-benchmark.ts's copy of it (kept as a
 * third small copy rather than an import: this module has to stay
 * DB-import-free so its functions are testable with plain fixtures, and
 * org-queries.ts pulls in the real `db` connection at module scope).
 */
function nearestRankPercentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const rank = Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1);
  return sortedAsc[Math.max(0, rank)] ?? null;
}

/**
 * p50/p95/min/max/n over a column of possibly-null samples — never a bare
 * mean (see this plan's own "never a bare mean" rule: an outlier turn drags
 * a mean around and misrepresents it as typical). `n` is the count of
 * non-null samples actually used, not the input array length, so a caller
 * can tell "no data" (`n: 0`) apart from "the metric was null on every row
 * for a real reason" without a second lookup.
 */
export function computeStats(rawValues: (number | null | undefined)[]): Stats {
  const values = rawValues.filter((v): v is number => v != null && Number.isFinite(v));
  if (values.length === 0) return { p50: null, p95: null, min: null, max: null, n: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: nearestRankPercentile(sorted, 50),
    p95: nearestRankPercentile(sorted, 95),
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    n: sorted.length,
  };
}

/** Any latency row this module deals with — only the one field the cutover
 * partition needs, so the same function works for callLatency and
 * turnLatency rows without a shared DB row type existing anywhere. */
export type CutoverTimestamped = { callStartedAt: Date };

export function partitionByAdr107Cutover<T extends CutoverTimestamped>(
  rows: T[],
  cutover: Date = ADR_107_CUTOVER,
): { included: T[]; excluded: T[] } {
  const included: T[] = [];
  const excluded: T[] = [];
  for (const row of rows) {
    (row.callStartedAt >= cutover ? included : excluded).push(row);
  }
  return { included, excluded };
}

export type CallLatencyRow = CutoverTimestamped & {
  pickupToFirstAudioMs: number | null;
  sttConnectMs: number | null;
  llmTtftMs: number | null;
  ttsFirstByteMs: number | null;
};

export type TurnLatencyRow = CutoverTimestamped & {
  voiceToVoiceMs: number | null;
  llmTtftMs: number | null;
  ttsFirstByteMs: number | null;
  ttsSocketOpenMs: number | null;
  endpointingDelayMs: number | null;
  llmInputTokens: number | null;
  llmCachedInputTokens: number | null;
  llmOutputTokens: number | null;
};

export type V2vDecomposition = {
  llmSharePct: number | null;
  ttsSharePct: number | null;
  otherSharePct: number | null;
};

/**
 * The share of a typical (p50) turn's voice-to-voice latency attributable to
 * each stage — `v2v ≈ llm_ttft + tts_first_byte + ~130ms` post-cutover (see
 * turnLatency's schema doc comment). Deliberately computed from the p50
 * *statistics*, not as a per-turn average of per-turn ratios: a turn missing
 * one of the three columns (a barge-in, a pure-tool turn) would otherwise
 * either divide by null or silently skew the average, and the plan's own
 * worked example ("LLM ≈ 70%, TTS ≈ 23%, other ≈ 7%") is a statement about
 * the typical turn, not a mean of per-turn shares.
 */
export function computeV2vDecomposition(turnRows: TurnLatencyRow[]): V2vDecomposition {
  const v2v = computeStats(turnRows.map((r) => r.voiceToVoiceMs));
  const llm = computeStats(turnRows.map((r) => r.llmTtftMs));
  const tts = computeStats(turnRows.map((r) => r.ttsFirstByteMs));
  if (!v2v.p50 || llm.p50 === null || tts.p50 === null) {
    return { llmSharePct: null, ttsSharePct: null, otherSharePct: null };
  }
  const llmSharePct = Math.round((llm.p50 / v2v.p50) * 100);
  const ttsSharePct = Math.round((tts.p50 / v2v.p50) * 100);
  // Remainder rather than a third independent percentage, so the three
  // always sum to 100 — "other" absorbs rounding and the ~130ms of overhead
  // the schema doc comment names (network, TTS-socket-open on top of
  // first-byte, in-process work) that has no column of its own.
  const otherSharePct = Math.max(0, 100 - llmSharePct - ttsSharePct);
  return { llmSharePct, ttsSharePct, otherSharePct };
}

/**
 * Phase A's guardrail counters, grouped by `"category (source)"` — the
 * source distinguishes, e.g., a crmSync-reported undelivered-outcome from a
 * setDisposition-invariant one, both of which share the `undelivered-outcome`
 * category (A4) but mean different things to a reader deciding what to fix.
 */
export function summarizeGuardrailEvents(rows: { category: string; source: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const key = `${row.category} (${row.source})`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/** One call's captured state plus the caller-turn count it should be judged
 * against — see capture-timing.ts's `countCapturesByTurnTiming`. */
export type CaptureTimingInput = {
  capturedState: Record<string, CapturedField>;
  callerTurnCount: number;
};

/**
 * A3's terminal-turn capture ratio, aggregated across every call in range —
 * A3 itself only ever logs this per call (`console.log`, deliberately not
 * persisted; see phase-a-integrity.md's A3 status note). This recomputes it
 * from `capturedState` directly, which is why `CaptureTimingInput` needs the
 * caller-turn count alongside it: that count isn't a column on `calls`
 * either, so the CLI derives it from a `transcripts` count per call (see
 * scripts/latency-report.ts).
 */
export function summarizeCaptureTiming(perCall: CaptureTimingInput[]): { midCall: number; finalTurn: number } {
  let midCall = 0;
  let finalTurn = 0;
  for (const call of perCall) {
    const counts = countCapturesByTurnTiming(call.capturedState, call.callerTurnCount);
    midCall += counts.midCall;
    finalTurn += counts.finalTurn;
  }
  return { midCall, finalTurn };
}

export type OrgBreakdownRow = {
  orgId: string;
  callCount: number;
  voiceToVoiceP50: number | null;
};

/** Per-org call count + v2v p50, from turn-latency rows already joined to
 * their call's orgId. Pooled numbers stay pooled (the module-level stats
 * above) — this is the "group per org" half of B1's requirement, kept
 * separate so a caller can print "N calls total, p50 X" without it silently
 * being a per-org number or vice versa. */
export function summarizeByOrg(
  turnRows: (TurnLatencyRow & { orgId: string | null; callId: number })[],
): OrgBreakdownRow[] {
  const byOrg = new Map<string, { voiceToVoiceMs: (number | null)[]; callIds: Set<number> }>();
  for (const row of turnRows) {
    const orgId = row.orgId ?? "(no org)";
    const bucket = byOrg.get(orgId) ?? { voiceToVoiceMs: [], callIds: new Set<number>() };
    bucket.voiceToVoiceMs.push(row.voiceToVoiceMs);
    bucket.callIds.add(row.callId);
    byOrg.set(orgId, bucket);
  }
  return [...byOrg.entries()]
    .map(([orgId, bucket]) => ({
      // A call, not a turn, count — turns per call vary, so this is "how
      // many distinct calls this org placed in range".
      orgId,
      callCount: bucket.callIds.size,
      voiceToVoiceP50: computeStats(bucket.voiceToVoiceMs).p50,
    }))
    .sort((a, b) => b.callCount - a.callCount);
}
