import z from "zod";
import { tool } from "ai";
import { screenCapture } from "../prohibited-capture";
import type { HeardVerifier } from "./captureField";

/**
 * ADR-120 / phase-a-integrity.md A2 — "unanswered" is a state, not an
 * omission.
 *
 * Before this tool existed, a caller who was asked a material question and
 * declined or evaded it left `captureField` with nothing legitimate to call:
 * the field was still unfilled, so the model either left it silently absent
 * (indistinguishable from never having asked) or, on production call 2,
 * invented an answer and called `captureField` with it — the exact
 * fabrication `heard`-provenance (A1) now refuses. Refusing the fabrication
 * closed the write path but did not give the model anywhere honest to put
 * "I asked and they wouldn't say", so nothing stopped it from asking a third
 * and fourth time either.
 *
 * This tool is that place. It writes the same `CapturedField` shape as
 * `captureField` (see database/schema.ts), but with `value: null` — a
 * first-class "asked, no answer" entry that `buildKnownFactsBlock`
 * (voice/agent.ts) renders in its own list, phrased so the model reads it as
 * *asked and not answered* rather than *unknown, go ask again*. That is what
 * breaks the three-ask loop from audit finding 4, without needing the full
 * question ledger (Phase D).
 *
 * Same provenance contract as `captureField`, and for the same reason: a
 * model that can claim "they evaded" without it being checked against what
 * the caller actually said could use this tool to fabricate a refusal just
 * as easily as a fabricated answer — closing one path while leaving the
 * other open would not be a fix, it would be a different-shaped version of
 * the same bug.
 */
export function createMarkFieldUnansweredTool(isHeardInCall?: HeardVerifier) {
  return tool({
    description:
      "Record that you asked the caller about a durable fact (their email, order ID, tobacco use, " +
      "etc.) and they declined to answer or evaded the question — so the call record shows it was " +
      "asked, not skipped, and you never have to ask again this call. Only call this after you have " +
      "actually asked and gotten a non-answer; do not call it pre-emptively for something you " +
      "haven't brought up yet. Never call this instead of captureField when the caller DID answer — " +
      "capture the real answer there. You must quote the caller's own evasive reply in `heard`: if " +
      "they changed the subject, said they'd rather not say, or simply didn't respond to the point, " +
      "quote that. A quote that isn't something the caller actually said is refused, exactly like a " +
      "fabricated captureField value would be.",
    inputSchema: z.object({
      field: z
        .string()
        .describe(
          "Short snake_case key for the fact you asked about, e.g. \"tobacco\", \"email\" — same " +
            "naming convention as captureField, since a later answer for this field overwrites this entry.",
        ),
      // Same contract as captureField's `heard`: required, and checked against
      // this call's caller-role transcript in stream.ts before anything
      // persists. See captureField.ts's identical field for the full rationale.
      heard: z
        .string()
        .min(1)
        .describe(
          "The caller's own words showing they declined or evaded — quote them verbatim. Do not " +
            "paraphrase, and never write your own summary of the non-answer here.",
        ),
    }),
    async execute({ field, heard }) {
      // Screened first, same ordering and same reason as captureField: a
      // prohibited key must be refused before its `heard` is examined, so a
      // refused field never has caller speech quoted alongside it either.
      const screen = screenCapture(field);
      if (!screen.allowed) return { recorded: false, field, refused: screen.refusal };
      if (isHeardInCall && !isHeardInCall(heard)) {
        return { recorded: false, field, reason: "not-heard" as const };
      }
      return { recorded: true, field };
    },
  });
}

/**
 * The shared, unverified instance — see `HeardVerifier` (captureField.ts) for
 * why a transcript-less surface (text test-chat, preview drawer, synthetic
 * harness) gets no provenance check rather than a failing one.
 */
export const markFieldUnanswered = createMarkFieldUnansweredTool();
