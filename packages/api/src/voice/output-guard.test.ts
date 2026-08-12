import { describe, expect, it } from "bun:test";
import { createOutputGuard, scrubSpokenText, speakableSplit } from "./output-guard";

/** Streams `text` through the guard in `size`-character deltas and returns
 * everything the sink was asked to speak, joined — i.e. exactly what TTS
 * would have received. Chunk size is varied across tests on purpose: a
 * streaming filter that only works when a token happens to land inside one
 * delta is not a filter. */
function streamThrough(text: string, size: number): { spoken: string; findings: string[] } {
  let spoken = "";
  const guard = createOutputGuard({ onText: (t) => (spoken += t) });
  for (let i = 0; i < text.length; i += size) guard.push(text.slice(i, i + size));
  guard.flush();
  return { spoken, findings: guard.findings() };
}

describe("scrubSpokenText", () => {
  it("leaves ordinary speech byte-identical", () => {
    const line = "Thanks — I've noted that down. One moment while I check your order.";
    const result = scrubSpokenText(line);
    expect(result.text).toBe(line);
    expect(result.findings).toEqual([]);
  });

  it("strips the exact leak measured from the gateway-served 8B model", () => {
    // Verbatim from the 2026-08-12 probe: the model emitted the tail of its
    // own function-call envelope as assistant text.
    const leaked = `3"}</function>I've saved your order number, ORD-48213.`;
    const result = scrubSpokenText(leaked, { atTurnStart: true });
    expect(result.text).toBe("I've saved your order number, ORD-48213.");
    expect(result.findings).toContain("tool-syntax");
    expect(result.findings).toContain("json-residue");
  });

  it("strips tool-call envelopes across model families", () => {
    for (const syntax of [
      "<function=captureField>",
      "</function>",
      "<tool_call>",
      "</tool_call>",
      "[TOOL_CALLS]",
      "<|python_tag|>",
      "<|eot_id|>",
    ]) {
      const result = scrubSpokenText(`${syntax}Sure, one moment.`);
      expect(result.text).toBe("Sure, one moment.");
      expect(result.findings).toContain("tool-syntax");
    }
  });

  it("strips the bracket placeholders production calls 22 and 24 spoke aloud", () => {
    const result = scrubSpokenText("Hi, is this [Caller Name]? This is [Agent Name] with presistentads.");
    expect(result.text).toBe("Hi, is this? This is with presistentads.");
    expect(result.findings).toEqual(["bracket-placeholder"]);
  });

  it("strips the [Agent_name: ] slot left behind when the merge tag inside it is scrubbed", () => {
    // merge-tags.ts removes {{agent_name}} and leaves the bracket slot — the
    // precise residue shape all six insurance personas open with.
    const result = scrubSpokenText("You are [Agent_name: ], a warm voice.");
    expect(result.text).toBe("You are, a warm voice.");
    expect(result.findings).toEqual(["bracket-placeholder"]);
  });

  it("never touches a tone tag, which is a live protocol and not a placeholder", () => {
    const line = "[[tone:apologetic]] I'm sorry about that.";
    const result = scrubSpokenText(line, { atTurnStart: true });
    expect(result.text).toBe(line);
    expect(result.findings).toEqual([]);
  });

  it("leaves lowercase and long bracketed prose alone", () => {
    for (const line of [
      "The policy number format is [alpha then digits], roughly.",
      "[A very long bracketed aside that is plainly prose rather than a short slot name]",
    ]) {
      expect(scrubSpokenText(line).text).toBe(line);
    }
  });

  it("only treats a quote-brace as JSON residue at the start of a leaked turn", () => {
    // Mid-sentence, the same characters are legitimate speech about data.
    const line = 'The webhook returns "}" as the last character.';
    expect(scrubSpokenText(line, { atTurnStart: true }).text).toBe(line);
  });

  it("does not invent a replacement for what it removes", () => {
    // The whole point of deletion over substitution (see the module header):
    // no placeholder token, no guessed default, nothing speakable added.
    const result = scrubSpokenText("This is [Agent Name] calling.");
    expect(result.text).not.toContain("unknown");
    expect(result.text).not.toContain("[");
  });

  it("repairs the whitespace its own removal creates", () => {
    const result = scrubSpokenText("Hello [Agent Name] , how are you?");
    expect(result.text).not.toContain("  ");
    expect(result.text).not.toContain(" ,");
  });
});

describe("speakableSplit", () => {
  it("emits immediately when nothing could be a partial token", () => {
    expect(speakableSplit("Sure, one moment.")).toEqual({ safe: "Sure, one moment.", hold: "" });
  });

  it("holds back from a dangling opener so a split token is still recognized", () => {
    expect(speakableSplit("Got it.</fun")).toEqual({ safe: "Got it.", hold: "</fun" });
    expect(speakableSplit("Hi, is this [Caller Na")).toEqual({ safe: "Hi, is this ", hold: "[Caller Na" });
  });

  it("releases a bracket too long to be a pattern rather than buffering forever", () => {
    const long = `Note [${"x".repeat(60)}`;
    expect(speakableSplit(long).hold).toBe("");
  });

  it("adds no delay to a closed tone tag", () => {
    expect(speakableSplit("[[tone:calm]] Sure").hold).toBe("");
  });
});

describe("createOutputGuard", () => {
  it("catches a token split across deltas at every chunk size", () => {
    const leaked = `Saved.</function>Anything else?`;
    for (const size of [1, 2, 3, 5, 8, 13, 100]) {
      const { spoken, findings } = streamThrough(leaked, size);
      expect(spoken).toBe("Saved.Anything else?");
      expect(findings).toContain("tool-syntax");
    }
  });

  it("catches a bracket placeholder split across deltas", () => {
    for (const size of [1, 4, 7, 200]) {
      const { spoken } = streamThrough("Hi, is this [Caller Name]?", size);
      expect(spoken).toBe("Hi, is this?");
    }
  });

  it("speaks a short clean turn in full — the ADR-101 defect class", () => {
    // A turn shorter than any buffering window must still reach TTS. This is
    // the regression that muted "OK." in production call 21.
    for (const size of [1, 3, 100]) {
      expect(streamThrough("OK.", size).spoken).toBe("OK.");
    }
  });

  it("speaks a turn that ends on a dangling bracket instead of swallowing it", () => {
    expect(streamThrough("Your reference is [ACME", 4).spoken).toBe("Your reference is [ACME");
  });

  it("passes a whole clean reply through unchanged and reports no findings", () => {
    const reply = "Perfect, that's everything I need. Let me connect you with a licensed advisor now.";
    const { spoken, findings } = streamThrough(reply, 6);
    expect(spoken).toBe(reply);
    expect(findings).toEqual([]);
  });

  it("is safe to flush twice and to flush an empty turn", () => {
    let spoken = "";
    const guard = createOutputGuard({ onText: (t) => (spoken += t) });
    guard.push("Done.");
    guard.flush();
    guard.flush();
    expect(spoken).toBe("Done.");
    const empty = createOutputGuard({ onText: () => expect.unreachable("nothing to speak") });
    empty.flush();
  });

  it("ignores empty deltas", () => {
    let calls = 0;
    const guard = createOutputGuard({ onText: () => calls++ });
    guard.push("");
    guard.flush();
    expect(calls).toBe(0);
  });
});
