/**
 * Call-quality audit — pure classification (Five Bets follow-up, 2026-08-14).
 *
 * Everything wrong with calls 4-9 in the 2026-08-13 test batch (the Groq
 * function-calling rejection loop, the tool-syntax leak, the unresolved
 * merge-tag block) was found by a human reading transcripts and Railway logs
 * one call at a time. That does not scale past a handful of manual test
 * calls, and it means a regression only surfaces when someone happens to go
 * looking.
 *
 * This module is the pure, unit-testable half of an automated pass over
 * stored call data: given one call's transcript rows, tool-call count, and a
 * few columns already on `calls`, decide whether anything in the batch of
 * defects diagnosed that day would fire again. The DB query and report
 * printing live in `tools/call-quality/audit.ts`, same split as
 * persona-source.ts (testable) / persona-gate.ts (thin CLI).
 *
 * Deliberately narrow: this recognizes the *specific* shapes already proven
 * to reach production, not a general sentiment/quality score. A general
 * "is this call good" scorer is a much bigger, fuzzier problem; this is the
 * cheap, precise, zero-false-positive-by-construction first pass.
 */

import { scrubSpokenText } from "./output-guard";
import { FALLBACK_REPLY } from "./agent";

export type CallQualityCategory =
  | "repeated-fallback"
  | "leaked-tool-syntax"
  | "missing-disclosure"
  | "degraded-health"
  | "narrated-without-tool-call";

export interface CallQualityFinding {
  category: CallQualityCategory;
  detail: string;
}

export interface CallQualityTranscriptRow {
  role: "agent" | "caller";
  text: string;
}

export interface CallQualityInput {
  callId: number;
  healthStatus: string | null;
  healthReasons: string[] | null;
  disclosureText: string | null;
  disclosureFiredAt: Date | null;
  transcripts: CallQualityTranscriptRow[];
  toolCallCount: number;
}

/** Two or more of the exact empty-turn fallback line in one call is the
 * "stuck loop" shape (calls 4-7, 2026-08-13), not an unlucky caller — a
 * single fallback is normal recovery from one bad turn. */
const REPEATED_FALLBACK_THRESHOLD = 2;

/** Phrases an agent only says once it believes an action actually happened.
 * If any of these appear in a call's agent transcript but `tool_calls` is
 * empty for that call, the model narrated an outcome it never executed —
 * the calls 8/9 shape, generalized past the exact tool-syntax leak so it
 * also catches a future leak in a form output-guard doesn't recognize yet. */
const ACTION_NARRATION_PHRASES = [
  "i'm going to transfer you",
  "i'm going to connect you",
  "connecting you with",
  "connecting you to",
  "i've noted that",
  "i'm going to make a note",
  "you're all set",
  "i'll get our advisor",
];

export function auditCall(input: CallQualityInput): CallQualityFinding[] {
  const findings: CallQualityFinding[] = [];
  const agentLines = input.transcripts.filter((t) => t.role === "agent");

  const fallbackCount = agentLines.filter((t) => t.text.trim() === FALLBACK_REPLY).length;
  if (fallbackCount >= REPEATED_FALLBACK_THRESHOLD) {
    findings.push({
      category: "repeated-fallback",
      detail: `agent fell back to "${FALLBACK_REPLY}" ${fallbackCount} times — the model is producing empty turns repeatedly, not recovering from one bad turn`,
    });
  }

  for (const line of agentLines) {
    const { findings: guardFindings } = scrubSpokenText(line.text);
    if (guardFindings.includes("tool-syntax")) {
      findings.push({
        category: "leaked-tool-syntax",
        detail: `stored transcript still contains tool-call envelope syntax: ${JSON.stringify(line.text.slice(0, 120))}`,
      });
    }
  }

  if (input.disclosureText && !input.disclosureFiredAt) {
    findings.push({
      category: "missing-disclosure",
      detail: "disclosure was configured for this call but disclosure_fired_at was never stamped",
    });
  }

  if (input.healthStatus && input.healthStatus !== "healthy") {
    findings.push({
      category: "degraded-health",
      detail: `health_status = "${input.healthStatus}"${input.healthReasons?.length ? `: ${input.healthReasons.join("; ")}` : ""}`,
    });
  }

  if (input.toolCallCount === 0) {
    const narrated = agentLines.find((t) => {
      const lower = t.text.toLowerCase();
      return ACTION_NARRATION_PHRASES.some((phrase) => lower.includes(phrase));
    });
    if (narrated) {
      findings.push({
        category: "narrated-without-tool-call",
        detail: `agent said "${narrated.text.slice(0, 80)}" implying an action, but zero tool calls were recorded for this call`,
      });
    }
  }

  return findings;
}
