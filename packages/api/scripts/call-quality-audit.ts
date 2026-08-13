#!/usr/bin/env bun
/**
 * Call-quality audit — thin CLI around call-quality.ts's pure `auditCall`
 * (same split as scripts/latency-benchmark.ts's stage runner / its stats
 * functions, or persona-gate.ts / persona-source.ts).
 *
 * Everything wrong with calls 4-9 in the 2026-08-13 test batch (the Groq
 * function-calling rejection loop, the tool-syntax leak, the unresolved
 * merge-tag block) was found by a human reading transcripts and Railway logs
 * one call at a time. This queries recent calls plus their transcripts and
 * tool-call counts, runs the same defect-shape checks against each one, and
 * prints a report — so a regression surfaces on a scan instead of only when
 * someone happens to go looking.
 *
 * Not wired into CI: this reads production call data, which CI has no
 * business touching. Run it manually, or wire it to a cron once there's
 * somewhere for the output to go.
 *
 * Usage:
 *   bun run call-quality:audit
 *   bun run call-quality:audit -- --since=2026-08-01 --limit=500
 */
import { desc, gte, inArray } from "drizzle-orm";
import { db } from "../src/database";
import { calls, transcripts, toolCalls } from "../src/database/schema";
import { auditCall, type CallQualityInput } from "../src/voice/call-quality";

function parseArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

async function main() {
  const since = parseArg("since");
  const limit = Number(parseArg("limit") ?? "200");

  const callRows = await db
    .select({
      id: calls.id,
      healthStatus: calls.healthStatus,
      healthReasons: calls.healthReasons,
      disclosureText: calls.disclosureText,
      disclosureFiredAt: calls.disclosureFiredAt,
      startedAt: calls.startedAt,
    })
    .from(calls)
    .where(since ? gte(calls.startedAt, new Date(since)) : undefined)
    .orderBy(desc(calls.startedAt))
    .limit(limit);

  if (callRows.length === 0) {
    console.log("[call-quality] no calls matched — nothing to audit.");
    return;
  }

  const callIds = callRows.map((c) => c.id);
  const [transcriptRows, toolCallRows] = await Promise.all([
    db
      .select({ callId: transcripts.callId, role: transcripts.role, text: transcripts.text })
      .from(transcripts)
      .where(inArray(transcripts.callId, callIds)),
    db.select({ callId: toolCalls.callId }).from(toolCalls).where(inArray(toolCalls.callId, callIds)),
  ]);

  const transcriptsByCall = new Map<number, CallQualityInput["transcripts"]>();
  for (const row of transcriptRows) {
    const list = transcriptsByCall.get(row.callId) ?? [];
    list.push({ role: row.role, text: row.text });
    transcriptsByCall.set(row.callId, list);
  }
  const toolCallCountByCall = new Map<number, number>();
  for (const row of toolCallRows) {
    toolCallCountByCall.set(row.callId, (toolCallCountByCall.get(row.callId) ?? 0) + 1);
  }

  let flaggedCalls = 0;
  let totalFindings = 0;
  for (const call of callRows) {
    const input: CallQualityInput = {
      callId: call.id,
      healthStatus: call.healthStatus,
      healthReasons: (call.healthReasons as string[] | null) ?? [],
      disclosureText: call.disclosureText,
      disclosureFiredAt: call.disclosureFiredAt,
      transcripts: transcriptsByCall.get(call.id) ?? [],
      toolCallCount: toolCallCountByCall.get(call.id) ?? 0,
    };
    const findings = auditCall(input);
    if (findings.length === 0) continue;
    flaggedCalls++;
    totalFindings += findings.length;
    console.log(`\ncall ${call.id} (${call.startedAt?.toISOString() ?? "unknown time"}):`);
    for (const finding of findings) {
      console.log(`  [${finding.category}] ${finding.detail}`);
    }
  }

  console.log(
    `\n[call-quality] ${callRows.length} calls audited, ${flaggedCalls} flagged, ${totalFindings} finding(s) total.`,
  );
  if (flaggedCalls > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error("[call-quality] audit failed:", err);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
