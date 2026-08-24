#!/usr/bin/env bun
/**
 * B1 (phase-b-measurement.md) — thin CLI around latency-report.ts's pure
 * aggregation functions (same split as scripts/call-quality-audit.ts /
 * scripts/latency-benchmark.ts). Queries `calls`, `callLatency`,
 * `turnLatency`, `guardrailEvents`, and (for the A3 terminal-turn-capture
 * ratio) `transcripts`, then prints one report: the ADR-107 window and how
 * many calls it excluded, p50/p95/min/max/n for every latency column, the
 * LLM/TTS/other v2v decomposition, Phase A's guardrail counters, the A3
 * capture-timing ratio, and a per-org breakdown.
 *
 * Not wired into CI — same reasoning as call-quality-audit.ts: this reads
 * production call data, which CI has no business touching.
 *
 * Usage:
 *   bun run latency:report
 *   bun run latency:report -- --since=2026-08-01
 *   bun run latency:report -- --since=2026-08-01 --cutover=2026-08-12
 */
import { and, eq, gte, inArray } from "drizzle-orm";
import { db } from "../src/database";
import { calls, callLatency, turnLatency, guardrailEvents, transcripts } from "../src/database/schema";
import {
  ADR_107_CUTOVER,
  computeStats,
  partitionByAdr107Cutover,
  computeV2vDecomposition,
  summarizeGuardrailEvents,
  summarizeCaptureTiming,
  summarizeByOrg,
  type Stats,
  type CallLatencyRow,
  type TurnLatencyRow,
} from "../src/voice/latency-report";

function parseArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

function formatMs(v: number | null): string {
  return v === null ? "—" : `${v}ms`;
}

function printStats(label: string, stats: Stats) {
  console.log(
    `  ${label.padEnd(22)} p50 ${formatMs(stats.p50).padEnd(8)} p95 ${formatMs(stats.p95).padEnd(8)} ` +
      `min ${formatMs(stats.min).padEnd(8)} max ${formatMs(stats.max).padEnd(8)} n=${stats.n}`,
  );
}

async function main() {
  const sinceArg = parseArg("since");
  const cutoverArg = parseArg("cutover");
  const cutover = cutoverArg ? new Date(cutoverArg) : ADR_107_CUTOVER;

  // "calls has no created_at column" (B1's own note — the audit lost time to
  // this): startedAt is the only ordering/windowing timestamp available.
  const callRows = await db
    .select({ id: calls.id, orgId: calls.orgId, startedAt: calls.startedAt })
    .from(calls)
    .where(sinceArg ? gte(calls.startedAt, new Date(sinceArg)) : undefined)
    .orderBy(calls.startedAt);

  if (callRows.length === 0) {
    console.log("[latency-report] no calls matched — nothing to report.");
    return;
  }

  const callIds = callRows.map((c) => c.id);
  const startedAtByCallId = new Map(callRows.map((c) => [c.id, c.startedAt]));
  const orgIdByCallId = new Map(callRows.map((c) => [c.id, c.orgId]));

  const [callLatencyRows, turnLatencyRows, guardrailRows, callerTranscriptRows] = await Promise.all([
    db.select().from(callLatency).where(inArray(callLatency.callId, callIds)),
    db.select().from(turnLatency).where(inArray(turnLatency.callId, callIds)),
    db.select().from(guardrailEvents).where(inArray(guardrailEvents.callId, callIds)),
    // A3's terminal-turn ratio needs each call's caller-turn count, which
    // isn't a column anywhere (see capture-timing.ts's doc comment) — derive
    // it the same way stream.ts does live, by counting caller-role rows.
    db
      .select({ callId: transcripts.callId })
      .from(transcripts)
      .where(and(inArray(transcripts.callId, callIds), eq(transcripts.role, "caller"))),
  ]);

  const callerTurnCountByCallId = new Map<number, number>();
  for (const row of callerTranscriptRows) {
    callerTurnCountByCallId.set(row.callId, (callerTurnCountByCallId.get(row.callId) ?? 0) + 1);
  }

  const withCallStartedAt = <T extends { callId: number }>(rows: T[]) =>
    rows
      .map((r) => ({ ...r, callStartedAt: startedAtByCallId.get(r.callId) }))
      .filter((r): r is T & { callStartedAt: Date } => r.callStartedAt !== undefined);

  const callLatWithDate = withCallStartedAt(callLatencyRows) as (CallLatencyRow & { callId: number })[];
  const turnLatWithDate = withCallStartedAt(turnLatencyRows) as (TurnLatencyRow & { callId: number })[];

  const { included: callLatIncluded, excluded: callLatExcluded } = partitionByAdr107Cutover(callLatWithDate, cutover);
  const { included: turnLatIncluded, excluded: turnLatExcluded } = partitionByAdr107Cutover(turnLatWithDate, cutover);
  const excludedCallCount = new Set([...callLatExcluded, ...turnLatExcluded].map((r) => r.callId)).size;

  console.log("=== Weeber Latency Report (B1, phase-b-measurement.md) ===");
  console.log(`Calls in range: ${callRows.length} (since ${sinceArg ?? "the beginning"})`);
  console.log(
    `ADR-107 window: post-${cutover.toISOString().slice(0, 10)} only — ${excludedCallCount} call(s) excluded ` +
      `as pre-cutover (their ttsFirstByteMs/llmTtftMs overlap and are not comparable to post-cutover rows).`,
  );

  console.log("\n--- Per-call latency (callLatency) ---");
  printStats("pickupToFirstAudio", computeStats(callLatIncluded.map((r) => r.pickupToFirstAudioMs)));
  printStats("sttConnect", computeStats(callLatIncluded.map((r) => r.sttConnectMs)));
  printStats("llmTtft (call)", computeStats(callLatIncluded.map((r) => r.llmTtftMs)));
  printStats("ttsFirstByte (call)", computeStats(callLatIncluded.map((r) => r.ttsFirstByteMs)));

  console.log("\n--- Per-turn latency, pooled across every turn of every call (turnLatency) ---");
  printStats("voiceToVoice", computeStats(turnLatIncluded.map((r) => r.voiceToVoiceMs)));
  printStats("llmTtft (turn)", computeStats(turnLatIncluded.map((r) => r.llmTtftMs)));
  printStats("ttsFirstByte (turn)", computeStats(turnLatIncluded.map((r) => r.ttsFirstByteMs)));
  printStats("ttsSocketOpen", computeStats(turnLatIncluded.map((r) => r.ttsSocketOpenMs)));
  printStats("endpointingDelay", computeStats(turnLatIncluded.map((r) => r.endpointingDelayMs)));
  printStats("llmInputTokens", computeStats(turnLatIncluded.map((r) => r.llmInputTokens)));
  printStats("llmCachedInputTokens", computeStats(turnLatIncluded.map((r) => r.llmCachedInputTokens)));
  printStats("llmOutputTokens", computeStats(turnLatIncluded.map((r) => r.llmOutputTokens)));

  const decomposition = computeV2vDecomposition(turnLatIncluded);
  console.log("\n--- v2v decomposition (share of the p50 turn, post-cutover only) ---");
  if (decomposition.llmSharePct === null) {
    console.log("  not enough data (need p50 voiceToVoiceMs, llmTtftMs, and ttsFirstByteMs all present)");
  } else {
    console.log(`  LLM ${decomposition.llmSharePct}%  TTS ${decomposition.ttsSharePct}%  other ${decomposition.otherSharePct}%`);
  }

  console.log("\n--- Phase A guardrail counters (guardrail_events) ---");
  const guardrailCounts = summarizeGuardrailEvents(guardrailRows);
  const guardrailEntries = Object.entries(guardrailCounts);
  if (guardrailEntries.length === 0) {
    console.log("  none — 0 rows in range");
  } else {
    for (const [key, count] of guardrailEntries.sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(4)}  ${key}`);
    }
  }

  console.log("\n--- A3 capture timing (mid-call vs. final caller turn, all calls in range) ---");
  const callsWithCapturedState = await db
    .select({ id: calls.id, capturedState: calls.capturedState })
    .from(calls)
    .where(inArray(calls.id, callIds));
  const captureTiming = summarizeCaptureTiming(
    callsWithCapturedState.map((c) => ({
      capturedState: c.capturedState ?? {},
      callerTurnCount: callerTurnCountByCallId.get(c.id) ?? 0,
    })),
  );
  const totalCaptures = captureTiming.midCall + captureTiming.finalTurn;
  if (totalCaptures === 0) {
    console.log("  no captures in range");
  } else {
    const finalTurnPct = Math.round((captureTiming.finalTurn / totalCaptures) * 100);
    console.log(
      `  mid-call: ${captureTiming.midCall}  final-turn: ${captureTiming.finalTurn}  ` +
        `(${finalTurnPct}% captured on the call's last turn — production calls 1/2 were 58-67% before A3)`,
    );
  }

  console.log("\n--- Per-org breakdown (v2v p50) ---");
  const orgTurnRows = turnLatIncluded.map((r) => ({ ...r, orgId: orgIdByCallId.get(r.callId) ?? null }));
  for (const row of summarizeByOrg(orgTurnRows)) {
    console.log(`  ${row.orgId.padEnd(24)} calls=${row.callCount}  v2v p50=${formatMs(row.voiceToVoiceP50)}`);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[latency-report] fatal error", err);
    process.exit(1);
  });
}
