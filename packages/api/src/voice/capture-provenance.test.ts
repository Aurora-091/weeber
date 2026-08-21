import { describe, it, expect } from "bun:test";
import { tokenizeSpeech, heardInCallerSpeech } from "./capture-provenance";
import { createCaptureFieldTool } from "./tools/captureField";

/**
 * ADR-120 — a captured field must name the utterance it came from.
 *
 * The case that produced this file is production call 2 (2026-08-20). The agent
 * asked about tobacco use three times (transcripts 40, 42, 44), was never
 * answered — the nearest reply was "just do some kind of drinks" — then said on
 * the recording "for the sake of our records, I'll mark the tobacco use as a no"
 * and called captureField with {"field":"tobacco","value":"no"}. That reached
 * calls.captured_state and the crmSync payload addressed to a licensed
 * insurance advisor.
 *
 * So the first test that matters here is not a tokenizer edge case; it is that
 * exact call. The unit tests below exist to keep the matcher honest enough to
 * decide it correctly for the right reason rather than by accident.
 */

const CALL_2_CALLER_SPEECH = tokenizeSpeech(
  "Hi yes I'm here. I'd like to know about the coverage first. " +
    "Ah, just do some kind of drinks. What would the premium be?",
);

describe("heardInCallerSpeech — the production call-2 fabrication", () => {
  it("refuses a value the caller never said, even though the agent announced it out loud", () => {
    expect(heardInCallerSpeech("no", CALL_2_CALLER_SPEECH)).toBe(false);
  });

  it("refuses the agent's own framing of the same non-answer", () => {
    expect(heardInCallerSpeech("for the sake of our records", CALL_2_CALLER_SPEECH)).toBe(false);
    expect(heardInCallerSpeech("non-smoker", CALL_2_CALLER_SPEECH)).toBe(false);
  });

  it("still accepts the words the caller actually did say", () => {
    expect(heardInCallerSpeech("just do some kind of drinks", CALL_2_CALLER_SPEECH)).toBe(true);
  });
});

describe("heardInCallerSpeech", () => {
  const speech = tokenizeSpeech("My email is jamie@example.com, and I don't know the order number.");

  it("matches a verbatim quote", () => {
    expect(heardInCallerSpeech("my email is jamie@example.com", speech)).toBe(true);
  });

  it("ignores case and punctuation, which are STT artifacts rather than caller intent", () => {
    expect(heardInCallerSpeech("My Email Is Jamie@Example.Com,", speech)).toBe(true);
    expect(heardInCallerSpeech("i dont know", speech)).toBe(true);
  });

  it("matches on token boundaries, so 'no' is not found inside 'know'", () => {
    // The whole reason this is token-sequence containment and not
    // String.includes: "I don't know" contains the substring "no".
    expect(heardInCallerSpeech("no", speech)).toBe(false);
    expect(heardInCallerSpeech("no", tokenizeSpeech("some kind of drinks"))).toBe(false);
    expect(heardInCallerSpeech("no", tokenizeSpeech("No, I don't smoke."))).toBe(true);
  });

  it("requires the quote's words to be contiguous and in order", () => {
    expect(heardInCallerSpeech("email jamie@example.com", speech)).toBe(false);
    expect(heardInCallerSpeech("is email my", speech)).toBe(false);
  });

  it("never matches an empty or whitespace-only quote", () => {
    // An absent provenance claim is the failure this mechanism refuses; it must
    // not fall through to "the empty sequence is contained in everything".
    expect(heardInCallerSpeech("", speech)).toBe(false);
    expect(heardInCallerSpeech("   ", speech)).toBe(false);
    expect(heardInCallerSpeech("...", speech)).toBe(false);
  });

  it("never matches when the caller has said nothing yet", () => {
    expect(heardInCallerSpeech("no", [])).toBe(false);
  });

  it("matches a quote spanning two transcript rows, because STT splits sentences arbitrarily", () => {
    const split = [...tokenizeSpeech("my order number is"), ...tokenizeSpeech("ORD-48213")];
    expect(heardInCallerSpeech("my order number is ORD-48213", split)).toBe(true);
  });
});

describe("tokenizeSpeech", () => {
  it("lowercases, strips punctuation and collapses whitespace", () => {
    expect(tokenizeSpeech("  Hello,   WORLD!  ")).toEqual(["hello", "world"]);
  });

  it("keeps digits as their own tokens", () => {
    expect(tokenizeSpeech("born in 1985")).toEqual(["born", "in", "1985"]);
  });

  it("returns no tokens for punctuation-only or empty input", () => {
    expect(tokenizeSpeech("")).toEqual([]);
    expect(tokenizeSpeech("--- ... ???")).toEqual([]);
  });

  it("keeps non-Latin script, so a Hindi or Marathi call is not silently unverifiable", () => {
    // \p{L} rather than a-z: stripping these to nothing would make every quote
    // on a Hindi call an empty needle, i.e. a blanket refusal.
    expect(tokenizeSpeech("हाँ, मैं हूँ")).toEqual(["हाँ", "मैं", "हूँ"]);
  });
});

describe("captureField with a call-scoped provenance verifier", () => {
  const callerSpeech = CALL_2_CALLER_SPEECH;
  const tool = createCaptureFieldTool((heard) => heardInCallerSpeech(heard, callerSpeech));
  const options = { toolCallId: "t1", messages: [] };

  it("refuses the call-2 write and tells the model why, without confirming a capture", async () => {
    const result = (await tool.execute!(
      { field: "tobacco", value: "no", heard: "no" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      options as any,
    )) as { captured: boolean; reason?: string };

    expect(result.captured).toBe(false);
    // "not-heard" and not an apology: the model has to be able to tell "you may
    // never collect this" (stop asking) from "the caller hasn't said it yet"
    // (ask again, then record the answer).
    expect(result.reason).toBe("not-heard");
  });

  it("captures a field the caller really did say", async () => {
    const result = (await tool.execute!(
      { field: "coverage_purpose", value: "some kind of drinks", heard: "just do some kind of drinks" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      options as any,
    )) as { captured: boolean; value?: string };

    expect(result.captured).toBe(true);
    expect(result.value).toBe("some kind of drinks");
  });

  it("screens a prohibited key before the provenance check, so a refused SSN's digits are never quoted onward", async () => {
    // Ordering matters for what ends up in guardrail detail and tool_calls
    // input: the key screen must win even when the caller genuinely said it.
    const spoken = tokenizeSpeech("my social is 123-45-6789");
    const ssnTool = createCaptureFieldTool((heard) => heardInCallerSpeech(heard, spoken));
    const result = (await ssnTool.execute!(
      { field: "ssn", value: "123-45-6789", heard: "my social is 123-45-6789" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      options as any,
    )) as { captured: boolean; refused?: string; reason?: string };

    expect(result.captured).toBe(false);
    expect(result.refused).toContain("not permitted");
    expect(result.reason).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("123-45-6789");
  });
});
