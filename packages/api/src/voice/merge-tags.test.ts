import { describe, it, expect, spyOn, afterEach } from "bun:test";
import { stripUnresolvedMergeTags, scrubSystemPrompt } from "./merge-tags";

describe("stripUnresolvedMergeTags — G1.3", () => {
  it("leaves a prompt with no merge tags completely untouched", () => {
    const prompt = "You are a warm, professional voice agent. Keep replies under two sentences.";
    const result = stripUnresolvedMergeTags(prompt);
    expect(result.text).toBe(prompt);
    expect(result.stripped).toEqual([]);
  });

  it("removes a merge tag so the model can never read it back out loud", () => {
    // The exact live-call bug: the cart-recovery persona said this verbatim and
    // nothing rendered it, so the agent could say "{{merchant_name}}" to a customer.
    const result = stripUnresolvedMergeTags("You are calling on behalf of {{merchant_name}}.");
    expect(result.text).not.toContain("{{");
    expect(result.text).not.toContain("merchant_name");
    expect(result.stripped).toEqual(["merchant_name"]);
  });

  it("reports every distinct tag, in first-appearance order, without duplicates", () => {
    const result = stripUnresolvedMergeTags(
      "Hi, this is {{agent_name}} from {{merchant_name}}. {{agent_name}} again about {{cart_items_summary}}.",
    );
    expect(result.stripped).toEqual(["agent_name", "merchant_name", "cart_items_summary"]);
  });

  it("does NOT substitute a placeholder or a guessed default", () => {
    // Deliberate: a placeholder is still speakable, and a guessed default
    // ("our store") is a false statement in the model's most trusted channel.
    const result = stripUnresolvedMergeTags("calling from {{merchant_name}} today");
    expect(result.text.toLowerCase()).not.toContain("unknown");
    expect(result.text.toLowerCase()).not.toContain("placeholder");
    expect(result.text.toLowerCase()).not.toContain("our store");
  });

  it("collapses the doubled spaces removal leaves behind", () => {
    const result = stripUnresolvedMergeTags("calling from {{merchant_name}} today");
    expect(result.text).not.toContain("  ");
    expect(result.text).toBe("calling from today");
  });

  it("pulls the space back off punctuation so the sentence still reads cleanly", () => {
    const result = stripUnresolvedMergeTags("This is {{agent_name}} .");
    expect(result.text).toBe("This is.");
  });

  it("drops a list line that contained nothing but a tag", () => {
    const result = stripUnresolvedMergeTags("Facts:\n- {{cart_total}}\n- Be brief.\n");
    expect(result.text).toBe("Facts:\n- Be brief.\n");
  });

  it("preserves markdown structure on lines that still have content", () => {
    const result = stripUnresolvedMergeTags("## Step 1\n\nMention {{cart_items_summary}} early.\n\n## Step 2\n");
    expect(result.text).toContain("## Step 1");
    expect(result.text).toContain("## Step 2");
    expect(result.text).toContain("Mention early.");
  });

  it("ignores a lone `{{` that is not a well-formed merge tag", () => {
    // Same grammar as renderTemplate's /\{\{(\w+)\}\}/g — anything that renderer
    // would not have substituted is not ours to delete.
    const prompt = "Respond with JSON like {{ not a tag }} and {{multi word}} and {{}}.";
    const result = stripUnresolvedMergeTags(prompt);
    expect(result.text).toBe(prompt);
    expect(result.stripped).toEqual([]);
  });

  it("handles a tag containing digits and underscores", () => {
    const result = stripUnresolvedMergeTags("attempt {{attempt_number_2}}");
    expect(result.stripped).toEqual(["attempt_number_2"]);
  });

  it("is not stateful across calls — a global regex's lastIndex cannot leak", () => {
    const prompt = "{{a}} and {{b}}";
    const first = stripUnresolvedMergeTags(prompt);
    const second = stripUnresolvedMergeTags(prompt);
    expect(second.stripped).toEqual(first.stripped);
    expect(second.text).toBe(first.text);
  });

  it("handles an empty prompt", () => {
    expect(stripUnresolvedMergeTags("")).toEqual({ text: "", stripped: [] });
  });
});

describe("scrubSystemPrompt — observability", () => {
  const spies: { mockRestore: () => void }[] = [];
  afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore();
  });

  it("stays silent on a clean prompt", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    spies.push(warn);
    expect(scrubSystemPrompt("A clean persona with no tags.")).toBe("A clean persona with no tags.");
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns once, naming every stripped tag, so an authoring bug is visible not silently papered over", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    spies.push(warn);
    scrubSystemPrompt("Hi from {{merchant_name}} about {{cart_total}}.");
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]![0]);
    expect(message).toContain("{{merchant_name}}");
    expect(message).toContain("{{cart_total}}");
    expect(message).toContain("2");
  });

  it("includes the caller label when given one", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    spies.push(warn);
    scrubSystemPrompt("{{agent_name}}", "CA-test-sid");
    expect(String(warn.mock.calls[0]![0])).toContain("CA-test-sid");
  });

  it("returns the scrubbed text, not the original", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    spies.push(warn);
    expect(scrubSystemPrompt("from {{merchant_name}} here")).toBe("from here");
  });
});
