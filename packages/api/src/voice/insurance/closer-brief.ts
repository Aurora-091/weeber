/**
 * Final-expense **closer brief** — the licensed half of the agency script, rendered for the human.
 *
 * ## Why this module exists
 *
 * A US final-expense agency's closer script runs ten sections end-to-end: opener, needs analysis,
 * financials, underwriting, carrier/program selection, price pitch, application, recorded-line
 * health confirmation, banking, and a voice-signature ACH authorization. They asked for an agent
 * that speaks all ten.
 *
 * Seven of those ten are the licensed act itself or a regulated-data collection:
 * recommending a carrier and explaining a program, quoting premiums, taking a date of birth and
 * SSN, running an itemized health questionnaire, capturing bank routing/account numbers, setting
 * an effective date and beneficiary designation, and taking a payment authorization. An AI cannot
 * perform those — not for want of capability, but because performing them without a producer
 * licence is unauthorized transaction of insurance, and because no carrier honours a
 * machine-taken voice signature (the resulting application is rescindable, so the "sale" reverses).
 *
 * Dropping those seven sections, though, would hand the agency an agent that solves the easy half
 * and leaves their closers working from a Word document. So the regulated half is not discarded —
 * it is **projected onto the licensed advisor** as an ordered, pre-filled checklist handed over at
 * transfer time, with every answer the AI already collected slotted in and every field the human
 * must collect themselves marked as theirs.
 *
 * Net effect: the agent runs the unregulated ~60% of the script, and the human picks up mid-script
 * instead of at the top. The boundary costs the agency nothing in duplicated effort.
 *
 * ## What this module is, precisely
 *
 * A pure formatter. It takes the call's `capturedState` (whatever `captureField` recorded during
 * the qualifying call) and returns a `CloserBrief`. It performs no I/O, no DB reads, and no
 * network calls, which is what makes it safe to render into a `crmSync` note, an advisor-facing
 * dashboard panel, or an SMS/email at handoff without three divergent copies of the logic.
 *
 * ## The invariant worth defending
 *
 * `ADVISOR_ONLY_STEPS` below is the *machine-readable* form of a boundary that previously existed
 * only as prose in a prompt file — which is why the "just let the AI say it" request kept
 * returning. Every entry is a step the AI must never speak. Nothing in this module ever reads a
 * value for those fields out of `capturedState`, because the agent is forbidden from capturing
 * them in the first place; if one ever appears there, that is a prompt regression, and
 * `findProhibitedCapture` exists to surface it loudly rather than quietly formatting PHI or an
 * SSN into a CRM note.
 */

import {
  PROHIBITED_CAPTURE_KEYS,
  findProhibitedCapture,
} from "../prohibited-capture";

// Re-exported: the guard moved to ../prohibited-capture when it started
// screening the `captureField` write itself for every vertical (it used to only
// report a regression here, after the fact). Existing importers of this module
// keep working.
export { PROHIBITED_CAPTURE_KEYS, findProhibitedCapture };



/** A single question or action the licensed advisor performs after handoff. */
export type AdvisorStep = {
  /** Stable key, snake_case — safe to use as a checklist item id in a UI. */
  key: string;
  /** The section of the agency's own script this belongs to, so the closer recognises it. */
  section: string;
  /** What the advisor does, phrased as an instruction to a human professional. */
  action: string;
  /**
   * Why this step is the human's and not the agent's. Shown in the UI: an advisor who understands
   * the reason stops asking for it to be automated, and a compliance reviewer can read the control
   * straight off the screen.
   */
  rationale: string;
};

/**
 * The seven regulated sections, in the order the agency's script runs them.
 *
 * Ordering is deliberate: it matches the paper script, so a closer who has run this call a hundred
 * times is not asked to learn a new sequence just because the front half became automated.
 */
export const ADVISOR_ONLY_STEPS: readonly AdvisorStep[] = [
  {
    key: "carrier_program_selection",
    section: "Carrier / Program",
    action:
      "Select the carrier and program (e.g. day-one vs. graded/modified) for this applicant, and explain " +
      "how the chosen program's benefit structure works.",
    rationale:
      "Recommending a carrier and representing policy terms is the transaction of insurance — it requires " +
      "your producer licence in the applicant's state.",
  },
  {
    key: "quote_and_riders",
    section: "Pitching Price",
    action:
      "Present the coverage options and monthly premiums, and explain any included riders (accidental " +
      "death, accelerated death benefit).",
    rationale: "Quoting a premium is solicitation of insurance, and the figures must be yours to stand behind.",
  },
  {
    key: "underwriting_health",
    section: "Underwriting / Recorded-Line Health Confirmation",
    action:
      "Run the full recorded-line health questionnaire and confirm the answers with the applicant on the " +
      "recording.",
    rationale:
      "Itemized health conditions are protected health information, and the answers are underwriting " +
      "representations the carrier relies on.",
  },
  {
    key: "identity_and_dob",
    section: "Application",
    action: "Collect and confirm full legal name, date of birth, height/weight, and state of birth.",
    rationale: "Regulated identifiers used to bind the application; they belong on your recording, not the agent's.",
  },
  {
    key: "ssn_and_background_authorization",
    section: "Recorded-Line Health Confirmation",
    action:
      "Collect the Social Security number and obtain authorization for the medical and prescription " +
      "background check.",
    rationale:
      "An SSN plus a consumer-report authorization is a regulated disclosure-and-consent step under federal " +
      "privacy and fair-credit rules. It must be taken by the licensed producer.",
  },
  {
    key: "banking_details",
    section: "Recap, Then Banking",
    action:
      "Collect the routing and account numbers, confirm the account holder, and confirm it is a standard " +
      "bank account rather than a prepaid card.",
    rationale:
      "Bank account credentials are non-public personal information. Never have them read back to the " +
      "applicant from a number you supplied — ask, then confirm what they said.",
  },
  {
    key: "effective_date_beneficiary_and_authorization",
    section: "Application / Solidification",
    action:
      "Set the effective date and draft day, take the primary and contingent beneficiary designations, and " +
      "take the voice-signature ACH authorization.",
    rationale:
      "These bind policy terms and authorize a debit. A carrier will not honour a signature taken by an " +
      "automated voice, so an AI-taken authorization produces a rescindable application.",
  },
] as const;


/** One line of pre-qualification the agent captured, ready to render. */
export type BriefFact = {
  /** The `captureField` key. */
  key: string;
  /** Human-readable label for the advisor's screen. */
  label: string;
  /** What the caller said, as captured. */
  value: string;
};

export type CloserBrief = {
  /** Pre-qual the agent already collected — the advisor should not re-ask these. */
  captured: BriefFact[];
  /**
   * Labels for pre-qual the agent never got to at all — no `captureField` and
   * no `markFieldUnanswered` entry exists for the key. Distinct from
   * `unanswered` below (A2, phase-a-integrity.md): this is "we never got
   * there", not "we asked and they wouldn't say".
   */
  missing: string[];
  /**
   * Labels for pre-qual the agent explicitly asked about and the caller
   * declined or evaded (A2) — a `markFieldUnanswered` entry (`value: null`)
   * exists for the key. An advisor reading this brief needs to know the
   * difference between this and `missing`: one is a signal about the caller,
   * the other is an incomplete call.
   */
  unanswered: string[];
  /** The regulated steps, in script order, that the advisor performs. */
  advisorSteps: readonly AdvisorStep[];
  /**
   * Non-empty only on a prompt regression: keys found in `capturedState` that the agent was never
   * permitted to collect. Callers must treat a non-empty array as an incident, not as data.
   */
  prohibitedCaptures: string[];
};

/**
 * The pre-qual fields this agent is allowed to collect, with advisor-facing labels.
 *
 * The order is the order the advisor reads them, which mirrors the script's own front half so the
 * brief scans like a continuation of the document they already know.
 */
const PREQUAL_FIELDS: readonly { key: string; label: string }[] = [
  { key: "coverage_purpose", label: "What the coverage is for" },
  { key: "service_preference", label: "Burial or cremation" },
  { key: "beneficiary_relationship", label: "Who they want to leave it to (relationship only)" },
  { key: "income_type", label: "Income type" },
  { key: "budget_comfort", label: "Comfortable monthly budget" },
  { key: "benefit_timing", label: "When income arrives" },
  { key: "tobacco", label: "Tobacco / nicotine" },
  { key: "banking_ready", label: "Has a standard bank account" },
  { key: "health_flag", label: "Health topics to be ready for" },
] as const;

/**
 * Builds the advisor's brief from a call's captured state.
 *
 * Pure: no I/O. `capturedState` is `calls.capturedState` as written by `captureField`, so values
 * arrive as whatever the model recorded — coerced to trimmed strings here, and empty/whitespace
 * values treated as absent so a blank capture reports as *missing* rather than as an answered
 * question the advisor then skips.
 */
export function buildCloserBrief(capturedState: Record<string, unknown> | null | undefined): CloserBrief {
  const state = capturedState ?? {};
  const captured: BriefFact[] = [];
  const missing: string[] = [];
  const unanswered: string[] = [];

  for (const { key, label } of PREQUAL_FIELDS) {
    // ADR-120: a captured field is `{ value, heard, transcriptId, turn }`.
    // Read `.value` off the entry, tolerating the pre-ADR-120 bare string so a
    // brief built from an un-migrated row still reports honestly instead of
    // marking every prequal field as missing.
    const entry = state[key];
    const isEntryObject = entry && typeof entry === "object" && "value" in entry;
    const raw = isEntryObject ? (entry as { value: unknown }).value : entry;
    // A2: `value: null` on an object entry is markFieldUnanswered's explicit
    // "asked, no answer" — a real, distinct signal, not a blank capture. Only
    // an object-shaped entry can carry this; a bare pre-migration string is
    // never null (see the ADR-120 tolerance above), so this can't misfire on
    // an un-migrated row.
    if (isEntryObject && raw === null) {
      unanswered.push(label);
      continue;
    }
    const value = typeof raw === "string" ? raw.trim() : raw == null ? "" : String(raw).trim();
    if (value) {
      captured.push({ key, label, value });
    } else {
      missing.push(label);
    }
  }

  return {
    captured,
    missing,
    unanswered,
    advisorSteps: ADVISOR_ONLY_STEPS,
    prohibitedCaptures: findProhibitedCapture(state),
  };
}

/**
 * Renders the brief as plain text for a `crmSync` note or an advisor email.
 *
 * Plain text rather than Markdown because the destinations are CRM note fields and SMS/email
 * bodies, most of which render Markdown as literal asterisks.
 */
export function formatCloserBriefText(brief: CloserBrief): string {
  const lines: string[] = ["FINAL EXPENSE — QUALIFIED LEAD BRIEF", ""];

  lines.push("Already captured (do not re-ask):");
  if (brief.captured.length === 0) {
    lines.push("  (nothing captured — treat this as a cold start)");
  } else {
    for (const fact of brief.captured) {
      lines.push(`  - ${fact.label}: ${fact.value}`);
    }
  }

  if (brief.unanswered.length > 0) {
    // A2: asked and the caller declined or evaded — a signal about the
    // caller, distinct from `missing` below (never got there this call).
    lines.push("", "Asked, caller declined or evaded (do not re-ask):");
    for (const label of brief.unanswered) {
      lines.push(`  - ${label}`);
    }
  }

  if (brief.missing.length > 0) {
    lines.push("", "Not reached on the qualifying call:");
    for (const label of brief.missing) {
      lines.push(`  - ${label}`);
    }
  }

  lines.push("", "Your steps — licensed advisor only:");
  for (const [index, step] of brief.advisorSteps.entries()) {
    lines.push(`  ${index + 1}. [${step.section}] ${step.action}`);
    lines.push(`     Why you: ${step.rationale}`);
  }

  if (brief.prohibitedCaptures.length > 0) {
    lines.push(
      "",
      "COMPLIANCE ALERT — the assistant recorded fields it must never collect: " +
        brief.prohibitedCaptures.join(", ") +
        ". Report this before continuing; do not rely on those values.",
    );
  }

  return lines.join("\n");
}
