import { describe, it, expect } from "bun:test";
import {
  ADVISOR_ONLY_STEPS,
  PROHIBITED_CAPTURE_KEYS,
  buildCloserBrief,
  findProhibitedCapture,
  formatCloserBriefText,
} from "./closer-brief";

/**
 * The brief is the mechanism that lets the compliance boundary cost the agency nothing: the seven
 * regulated script sections still get run, by a licensed human, with the agent's pre-qual already
 * filled in. These tests defend the two things that make it trustworthy — that no regulated step
 * can quietly go missing from the advisor's list, and that regulated data can never be formatted
 * into a CRM note without shouting about it.
 */

describe("buildCloserBrief — pre-qual projection", () => {
  it("separates what the agent captured from what it never got", () => {
    const brief = buildCloserBrief({
      coverage_purpose: "final expenses",
      service_preference: "cremation",
      tobacco: "no",
    });

    expect(brief.captured.map((f) => f.key)).toEqual(["coverage_purpose", "service_preference", "tobacco"]);
    expect(brief.captured[0]).toEqual({
      key: "coverage_purpose",
      label: "What the coverage is for",
      value: "final expenses",
    });
    // The six allowed fields the caller never answered must be reported, so the advisor knows to
    // ask rather than assuming the agent covered it.
    expect(brief.missing).toContain("Comfortable monthly budget");
    expect(brief.missing).toContain("When income arrives");
    expect(brief.captured.length + brief.missing.length).toBe(9);
  });

  it("treats a blank or whitespace capture as missing, not as an answered question", () => {
    // A model that calls captureField with an empty string would otherwise produce a brief line
    // reading "Tobacco / nicotine:" — which an advisor scanning the list reads as handled.
    const brief = buildCloserBrief({ tobacco: "   ", budget_comfort: "" });

    expect(brief.captured).toEqual([]);
    expect(brief.missing).toContain("Tobacco / nicotine");
    expect(brief.missing).toContain("Comfortable monthly budget");
  });

  it("survives a null captured state and still hands over the full advisor checklist", () => {
    const brief = buildCloserBrief(null);

    expect(brief.captured).toEqual([]);
    expect(brief.missing).toHaveLength(9);
    // The point: an agent that learned nothing must not silently shorten the licensed steps.
    expect(brief.advisorSteps).toHaveLength(ADVISOR_ONLY_STEPS.length);
  });

  it("coerces a non-string captured value instead of dropping it", () => {
    const brief = buildCloserBrief({ budget_comfort: 40 });

    expect(brief.captured).toEqual([
      { key: "budget_comfort", label: "Comfortable monthly budget", value: "40" },
    ]);
  });

  it("A2: reports a markFieldUnanswered entry (value: null) as unanswered, not missing", () => {
    // An advisor reading this brief needs "we asked and they wouldn't say"
    // (unanswered) to read differently from "we never got there" (missing).
    const brief = buildCloserBrief({
      tobacco: { value: null, heard: "just do some kind of drinks", transcriptId: 44, turn: 3 },
      coverage_purpose: "final expenses",
    });

    expect(brief.unanswered).toEqual(["Tobacco / nicotine"]);
    expect(brief.missing).not.toContain("Tobacco / nicotine");
    expect(brief.captured.map((f) => f.key)).toEqual(["coverage_purpose"]);
  });
});

describe("ADVISOR_ONLY_STEPS — the regulated half stays with the human", () => {
  it("covers every regulated section of the agency script", () => {
    // Locked by key, not by count: adding a step is fine, silently losing one is the failure mode.
    // Each of these was a section the agency expected the AI to speak.
    expect(ADVISOR_ONLY_STEPS.map((s) => s.key)).toEqual([
      "carrier_program_selection",
      "quote_and_riders",
      "underwriting_health",
      "identity_and_dob",
      "ssn_and_background_authorization",
      "banking_details",
      "effective_date_beneficiary_and_authorization",
    ]);
  });

  it("gives every step a reason the advisor can read", () => {
    // An unexplained control gets escalated as friction and eventually removed. The rationale is
    // load-bearing, so an empty one is a test failure.
    for (const step of ADVISOR_ONLY_STEPS) {
      expect(step.section.length).toBeGreaterThan(0);
      expect(step.action.length).toBeGreaterThan(0);
      expect(step.rationale.length).toBeGreaterThan(20);
    }
  });
});

describe("findProhibitedCapture — a prompt regression must be loud", () => {
  it("flags regulated keys regardless of casing, separators, or prefixes", () => {
    const found = findProhibitedCapture({
      applicant_SSN: "...",
      "bank-routing": "...",
      accountNumber: "...",
      coverage_purpose: "final expenses",
    });

    expect(found.sort()).toEqual(["accountNumber", "applicant_SSN", "bank-routing"]);
    // The legitimate field must not be swept up with them.
    expect(found).not.toContain("coverage_purpose");
  });

  it("finds nothing in a well-behaved capture set", () => {
    expect(
      findProhibitedCapture({
        coverage_purpose: "both",
        income_type: "fixed-income",
        health_flag: "prefers-advisor",
        banking_ready: "yes",
      }),
    ).toEqual([]);
  });

  it("matches every guarded key when it appears alone", () => {
    // Guards the guard: a typo'd entry in PROHIBITED_CAPTURE_KEYS would silently never match.
    for (const banned of PROHIBITED_CAPTURE_KEYS) {
      expect(findProhibitedCapture({ [banned]: "x" })).toEqual([banned]);
    }
  });

  it("does not treat the allowed banking_ready flag as a banking detail", () => {
    // The agent may record *that* someone has an account; the guard must not fire on it, or the
    // compliant path would report itself as an incident on every call.
    expect(findProhibitedCapture({ banking_ready: "yes" })).toEqual([]);
  });
});

describe("formatCloserBriefText", () => {
  it("leads with captured facts and numbers the advisor's steps in script order", () => {
    const text = formatCloserBriefText(buildCloserBrief({ coverage_purpose: "family", tobacco: "no" }));

    expect(text).toContain("Already captured (do not re-ask):");
    expect(text).toContain("- What the coverage is for: family");
    expect(text).toContain("1. [Carrier / Program]");
    expect(text).toContain("7. [Application / Solidification]");
    expect(text.indexOf("Already captured")).toBeLessThan(text.indexOf("Your steps"));
  });

  it("says so plainly when the agent captured nothing", () => {
    expect(formatCloserBriefText(buildCloserBrief({}))).toContain("treat this as a cold start");
  });

  it("raises a compliance alert instead of quietly rendering regulated data", () => {
    const text = formatCloserBriefText(buildCloserBrief({ ssn: "123-45-6789" }));

    expect(text).toContain("COMPLIANCE ALERT");
    expect(text).toContain("ssn");
    expect(text).toContain("do not rely on those values");
  });

  it("omits the alert entirely on a clean brief", () => {
    // The alert must mean something when it appears, so it cannot be boilerplate.
    expect(formatCloserBriefText(buildCloserBrief({ tobacco: "yes" }))).not.toContain("COMPLIANCE ALERT");
  });
});
