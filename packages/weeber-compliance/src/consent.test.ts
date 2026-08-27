import { describe, it, expect, afterEach } from "bun:test";
import { resolveDisclosure, getDisclosureLine, isDisclosureEnabled, withDisclosure, DISCLOSURE_VERSION } from "./consent";

describe("resolveDisclosure — Global Compliance Engine Tier 0 (#2/#3)", () => {
  afterEach(() => {
    delete process.env.RECORDING_DISCLOSURE_TEXT;
    delete process.env.RECORDING_DISCLOSURE_ENABLED;
  });

  it("resolves the English default with the real version when no language is given", () => {
    const result = resolveDisclosure({});
    expect(result.text).toContain("recorded");
    expect(result.text).toContain("AI assistant");
    expect(result.version).toBe(DISCLOSURE_VERSION);
  });

  it("resolves a Hindi/Hinglish line for language 'hi'", () => {
    const result = resolveDisclosure({ language: "hi" });
    expect(result.text).toContain("record");
    expect(result.text).toContain("AI assistant");
    expect(result.version).toBe(DISCLOSURE_VERSION);
  });

  it("resolves a distinct romanized Hinglish line for language 'hinglish'", () => {
    const result = resolveDisclosure({ language: "hinglish" });
    expect(result.text).toContain("record");
    expect(result.text).toContain("AI assistant");
    // romanized, not the Devanagari 'hi' line and not the English fallback
    expect(result.text).toContain("Shuru karne se pehle");
    expect(result.text).not.toBe(resolveDisclosure({ language: "hi" }).text);
    expect(result.text).not.toBe(resolveDisclosure({}).text);
    expect(result.version).toBe(DISCLOSURE_VERSION);
  });

  it("normalizes a region-suffixed tag ('hi-IN') to the same 'hi' line", () => {
    const plain = resolveDisclosure({ language: "hi" });
    const regioned = resolveDisclosure({ language: "hi-IN" });
    expect(regioned.text).toBe(plain.text);
    expect(regioned.version).toBe(DISCLOSURE_VERSION);
  });

  it("falls back to English for an unknown language tag", () => {
    const result = resolveDisclosure({ language: "fr" });
    expect(result.text).toContain("recorded");
    expect(result.version).toBe(DISCLOSURE_VERSION);
  });

  it("an explicit disclosureText override wins over the language map and gets version 'custom'", () => {
    const result = resolveDisclosure({ language: "hi", disclosureText: "Custom override line." });
    expect(result.text).toBe("Custom override line.");
    expect(result.version).toBe("custom");
  });

  it("an env var override wins over the language map and gets version 'custom'", () => {
    process.env.RECORDING_DISCLOSURE_TEXT = "Env override line.";
    const result = resolveDisclosure({ language: "hi" });
    expect(result.text).toBe("Env override line.");
    expect(result.version).toBe("custom");
  });

  it("getDisclosureLine returns just the resolved text (back-compat)", () => {
    expect(getDisclosureLine({ language: "hi" })).toBe(resolveDisclosure({ language: "hi" }).text);
  });

  it("withDisclosure embeds the language-matched line when disclosure is enabled", () => {
    const prompt = withDisclosure("Base persona.", { language: "hi" });
    expect(prompt).toContain("Base persona.");
    expect(prompt).toContain("record");
  });

  it("withDisclosure is a no-op when disclosure is disabled", () => {
    expect(withDisclosure("Base persona.", { enabled: false })).toBe("Base persona.");
  });

  it("isDisclosureEnabled defaults to true", () => {
    expect(isDisclosureEnabled({})).toBe(true);
  });

  it("isDisclosureEnabled respects RECORDING_DISCLOSURE_ENABLED=false", () => {
    process.env.RECORDING_DISCLOSURE_ENABLED = "false";
    expect(isDisclosureEnabled({})).toBe(false);
  });
});
