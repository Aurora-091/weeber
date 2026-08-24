import { describe, it, expect } from "bun:test";
import { tokenizeSpeech, heardInCallerSpeech } from "./capture-provenance";
import { detectUnsourcedPriceClaims } from "./unsourced-claim-guard";

/**
 * B3 (phase-b-measurement.md) — "prove guardrail_events is non-vacuous."
 *
 * Deviation from the plan's suggested method (replay both production calls
 * through the AI-to-AI synthetic harness): this replays the actual recorded
 * transcripts and tool_calls instead, pulled directly from the production
 * database via the Supabase MCP on 2026-08-24
 * (docs/audits/2026-08-21-first-two-production-calls.md is the same
 * incident, transcribed by hand; these are the literal rows). A synthetic
 * harness re-runs a *new*, scripted conversation against the current
 * persona — useful for regression-testing behaviour going forward, but it
 * cannot prove anything about the two calls that actually happened, because
 * it never says what they said. This does: the caller-role transcript text
 * below is copy-pasted verbatim from `transcripts`, and the `heard` values
 * are what a model would have to claim to justify each real `tool_calls`
 * row (the pre-A1 rows have no `heard` column — captured before ADR-120
 * existed — so this reconstructs the claim the same way the audit did:
 * from what the tool call recorded against what the transcript shows).
 *
 * Two calls, two different outcomes, matching audit findings 1 and 8:
 * call 1's tobacco capture was honest and must still pass; call 2's was
 * fabricated and must still fail; call 2's cremation-cost line must still
 * flag as an unsourced claim.
 */

const CALL_2_CALLER_TRANSCRIPT = [
  "Yes. I have.",
  "right now.",
  "mainly to cover my final financial expenses.",
  "So as for now, I'm thinking about the cremations only.",
  "first of the month.",
  "$5,000 a month in the starting of the month.",
  "so so much about these things, so you have to guide me.",
  "and nicotine product, but, yeah, I I drink sometimes.",
  "I don't understand. Can you please repeat?",
  "just do some kind of drinks.",
  "yeah,",
  "Yeah. So, actually, I have some kind of",
  "You can connect with me, and you can send me their number.",
  "Thank you.",
];

const CALL_1_CALLER_TRANSCRIPT = [
  "Yes. I have couple of mails.",
  "Hoping to lose something behind for my family.",
  "My children's.",
  "I wanna fix income.",
  "$200 will be fine.",
  "No. I don't use any tobacco nicotine products.",
  "Yes. Yes. I'm here. Can you ask the question again?",
  "Yes. Yes.",
  "I would prefer to discuss this detail with adviser committee.",
  "In call.",
];

describe("B3 — replaying production call 2 (2026-08-20 17:34 UTC) against the A1 provenance guard", () => {
  const callerTokens = CALL_2_CALLER_TRANSCRIPT.flatMap((line) => tokenizeSpeech(line));

  it("refuses the tobacco capture — this is audit finding 1, the fabrication itself", () => {
    // The real tool_calls row: captureField({ field: "tobacco", value: "no" }).
    // Pre-A1, so it carries no `heard` — this is the claim the agent's own
    // spoken line makes ("I'll mark the tobacco use as a no") reduced to
    // what A1 actually checks: did the caller say "no".
    expect(heardInCallerSpeech("no", callerTokens)).toBe(false);
  });

  it("would also refuse the agent's own framing of the non-answer", () => {
    expect(heardInCallerSpeech("for the sake of our records", callerTokens)).toBe(false);
  });

  it("confirms the caller's actual words were an evasion, not a tobacco answer at all", () => {
    expect(heardInCallerSpeech("just do some kind of drinks", callerTokens)).toBe(true);
  });

  it("accepts the honestly-sourced captures from the same call — service_preference and benefit_timing", () => {
    expect(heardInCallerSpeech("thinking about the cremations only", callerTokens)).toBe(true);
    expect(heardInCallerSpeech("first of the month", callerTokens)).toBe(true);
  });
});

describe("B3 — replaying production call 1 (2026-08-20 11:52 UTC), the honest-capture control", () => {
  const callerTokens = CALL_1_CALLER_TRANSCRIPT.flatMap((line) => tokenizeSpeech(line));

  it("accepts the tobacco capture — the caller said it plainly, unlike call 2", () => {
    // The real tool_calls row: captureField({ field: "tobacco", value: "no" }).
    expect(heardInCallerSpeech("no i dont use any tobacco nicotine products", callerTokens)).toBe(true);
  });

  it("accepts the budget_comfort capture", () => {
    // The real tool_calls row: captureField({ field: "budget_comfort", value: "200 dollars" }).
    expect(heardInCallerSpeech("200 will be fine", callerTokens)).toBe(true);
  });

  it("accepts the beneficiary_relationship capture", () => {
    expect(heardInCallerSpeech("my childrens", callerTokens)).toBe(true);
  });
});

describe("B3 — replaying production call 2's spoken cost figure against the A5 unsourced-claim detector", () => {
  it("flags the literal sentence the agent spoke, word for word from the transcript", () => {
    const spoken =
      "That is a helpful detail to have. Just as some context, while a licensed advisor will provide the exact " +
      "figures for your situation, cremation services typically run between five thousand and eight thousand dollars. \n\n" +
      "To help me understand your needs better, could you tell me a little bit about your income—for example, are " +
      "you currently working, or are you on a fixed income like a pension or social security?";
    const claims = detectUnsourcedPriceClaims(spoken);
    expect(claims).toHaveLength(1);
    expect(claims[0].sentence).toContain("five thousand and eight thousand dollars");
  });

  it("does not flag call 1's cost-related line — the caller stated the figure, and the agent's rider names the advisor as the source of real numbers", () => {
    const spoken =
      "I appreciate you sharing that with me. I have noted that two hundred dollars would be a comfortable " +
      "monthly amount for you, and the advisor will walk you through your real options for that. To help the " +
      "advisor further, could you tell me if you use any tobacco or nicotine products?";
    expect(detectUnsourcedPriceClaims(spoken)).toEqual([]);
  });
});
