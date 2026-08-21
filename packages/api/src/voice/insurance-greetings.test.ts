import { describe, it, expect } from "bun:test";
import { INSURANCE_GREETINGS, resolveLocalizedGreeting } from "./insurance-greetings";

/**
 * Config-driven per-language insurance greetings (2026-07-19,
 * docs/archive/insurance-language-variants-task.md). The greeting is the only line
 * spoken *canned* (LLM-free), so the non-English variants must come from the
 * audited map here — never the English DB line rendered through a non-English
 * voice. A language with no audited entry must resolve to undefined so the LLM
 * greets in the configured language instead.
 */
describe("resolveLocalizedGreeting", () => {
  const englishFallback = "Hello, this is the English canned greeting.";

  it("returns the English fallback for English", () => {
    expect(resolveLocalizedGreeting("insurance-policy-renewal", "en", englishFallback)).toBe(englishFallback);
  });

  it("returns the English fallback when no language is set", () => {
    expect(resolveLocalizedGreeting("insurance-policy-renewal", undefined, englishFallback)).toBe(englishFallback);
  });

  it("is case-insensitive about the language code", () => {
    expect(resolveLocalizedGreeting("insurance-policy-renewal", "EN", englishFallback)).toBe(englishFallback);
  });

  it("returns the audited Hindi greeting for hi", () => {
    const g = resolveLocalizedGreeting("insurance-policy-renewal", "hi", englishFallback);
    expect(g).toBe(INSURANCE_GREETINGS["insurance-policy-renewal"]!.hi!);
    expect(g).not.toBe(englishFallback);
  });

  it("returns the audited Hinglish greeting for hinglish", () => {
    const g = resolveLocalizedGreeting("insurance-post-sale-welcome", "hinglish", englishFallback);
    expect(g).toBe(INSURANCE_GREETINGS["insurance-post-sale-welcome"]!.hinglish!);
    expect(g).not.toBe(englishFallback);
  });

  it("returns undefined for a language with no audited translation (e.g. Marathi) — LLM greets instead", () => {
    expect(resolveLocalizedGreeting("insurance-policy-renewal", "mr", englishFallback)).toBeUndefined();
  });

  it("returns undefined when the template key is unknown / not an insurance template", () => {
    expect(resolveLocalizedGreeting("shopify-cart-recovery", "hi", englishFallback)).toBeUndefined();
  });

  it("returns undefined when there is no template key", () => {
    expect(resolveLocalizedGreeting(undefined, "hi", englishFallback)).toBeUndefined();
  });

  it("covers all five India insurance templates (04–08) with both hi and hinglish", () => {
    const keys = [
      "insurance-policy-renewal",
      "insurance-lead-followup",
      "insurance-appointment-setter",
      "insurance-post-sale-welcome",
      "insurance-feedback-nps",
    ];
    for (const key of keys) {
      expect(INSURANCE_GREETINGS[key]?.hi).toBeString();
      expect(INSURANCE_GREETINGS[key]?.hinglish).toBeString();
    }
  });

  it("localized greetings use only guaranteed-resolvable tags (agent_name, merchant_name) — no lead-row deps (2026-08-17, tag standardized 2026-08-20)", () => {
    // All localized variants must resolve with only the context stream.ts always
    // provides. Lead-dependent tags (policyholder_name, lead_name, interest_area,
    // interaction_type) were removed because getLeadGreetingContext returns {} when
    // the lead is absent, which was causing 11/11 production calls to fall back to
    // the LLM greeting instead of using the fast path.
    const UNRESOLVED_TAG = /\{\{\w+\}\}/;
    const GUARANTEED_CONTEXT = { agent_name: "Alex", merchant_name: "Acme Co" };

    for (const [templateKey, langs] of Object.entries(INSURANCE_GREETINGS)) {
      for (const [lang, template] of Object.entries(langs)) {
        const rendered = template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
          const v = GUARANTEED_CONTEXT[key as keyof typeof GUARANTEED_CONTEXT];
          return v !== undefined ? v : match;
        });
        expect(
          UNRESOLVED_TAG.test(rendered),
          `${templateKey}/${lang} still has unresolved tags after guaranteed context: "${rendered}"`,
        ).toBe(false);
      }
    }

    // Spot-check: the guaranteed tags are actually present in the strings.
    expect(INSURANCE_GREETINGS["insurance-policy-renewal"]!.hi).toContain("{{merchant_name}}");
    expect(INSURANCE_GREETINGS["insurance-policy-renewal"]!.hi).toContain("{{agent_name}}");
  });

  // Regression guard mirroring seed.test.ts's: {{company_name}} still
  // resolves today (stream.ts sets it alongside merchant_name), so it would
  // silently pass the test above — this catches a localized string drifting
  // back onto the non-canonical alias.
  it("no localized greeting uses the {{company_name}} alias — {{merchant_name}} is the one canonical tag", () => {
    const usingAlias: string[] = [];
    for (const [templateKey, langs] of Object.entries(INSURANCE_GREETINGS)) {
      for (const [lang, template] of Object.entries(langs)) {
        if (template.includes("{{company_name}}")) usingAlias.push(`${templateKey}/${lang}`);
      }
    }
    expect(usingAlias).toEqual([]);
  });
});
