/**
 * Localized, AUDITED greeting lines for the India insurance agents (templates 04–08).
 *
 * Why this file exists: the greeting is the only line spoken *canned* (stream.ts's
 * speakCannedLine, an LLM-free latency shortcut). Every other spoken line is produced by
 * the LLM. For the hybrid compliance model (see docs/insurance-language-variants-task.md):
 *   - GREETING → canned + audited per language (here).
 *   - REFUSALS + CLOSINGS → LLM-delivered, audited by living verbatim in each agent's prompt
 *     .md per language.
 *   - Rest of the conversation → LLM-natural, canonical English source.
 *
 * The English greeting stays the canonical `literalGreetingTemplate` DB column (seed.ts).
 * This map only holds the audited hi / hinglish translations, keyed by template key. Merge
 * tags are identical to the English seed line so renderTemplate + the unresolved-tag guard in
 * stream.ts behave the same across languages.
 *
 * Any language without an audited entry deliberately returns undefined → the caller must NOT
 * speak the English canned line through a non-English voice; it falls back to an LLM-generated
 * greeting in the configured language instead (see resolveLocalizedGreeting).
 *
 * US Final Expense (09) is English-only by design and intentionally absent here.
 */
export const INSURANCE_GREETINGS: Record<string, Record<string, string>> = {
  "insurance-policy-renewal": {
    hi: "नमस्ते, मैं {{merchant_name}} की ओर से {{agent_name}} बात कर रहा हूँ — आपकी policy renewal के बारे में एक छोटी सी reminder call है। क्या आपके पास एक मिनट है?",
    hinglish:
      "Namaste, main {{merchant_name}} ki taraf se {{agent_name}} baat kar raha hoon — aapki policy renewal ke baare mein ek chhoti si reminder call hai. Kya aapke paas ek minute hai?",
  },
  // {{interest_area}} removed (2026-08-17) — mirrors the English seed change in seed.ts.
  "insurance-lead-followup": {
    hi: "नमस्ते, मैं {{merchant_name}} से {{agent_name}} बात कर रहा हूँ — मैं आपसे जल्दी follow-up करना चाहता था। क्या आपके पास दो मिनट हैं?",
    hinglish:
      "Hi, main {{merchant_name}} se {{agent_name}} baat kar raha hoon — main aapse jaldi follow-up karna chahta tha. Kya aapke paas do minute hain?",
  },
  // {{lead_name}} and {{interest_area}} removed (2026-08-17) — mirrors seed.ts.
  "insurance-appointment-setter": {
    hi: "नमस्ते, मैं {{merchant_name}} से {{agent_name}} बात कर रहा हूँ — मैं आपको हमारे एक licensed advisor से connect करना चाहूँगा। क्या अभी सही समय है?",
    hinglish:
      "Hi, main {{merchant_name}} se {{agent_name}} baat kar raha hoon — main aapko hamare ek licensed advisor se connect karna chahunga. Kya abhi sahi time hai?",
  },
  // {{policyholder_name}} removed (2026-08-17) — mirrors seed.ts.
  "insurance-post-sale-welcome": {
    hi: "नमस्ते, मैं {{merchant_name}} की ओर से {{agent_name}} बात कर रहा हूँ — आपकी नई policy शुरू होने पर एक छोटी सी welcome call है। क्या आपके पास एक मिनट है?",
    hinglish:
      "Namaste, main {{merchant_name}} ki taraf se {{agent_name}} baat kar raha hoon — aapki nayi policy shuru hone par ek chhoti si welcome call hai. Kya aapke paas ek minute hai?",
  },
  // {{interaction_type}} removed (2026-08-17) — mirrors seed.ts.
  "insurance-feedback-nps": {
    hi: "नमस्ते, मैं {{merchant_name}} से {{agent_name}} बात कर रहा हूँ। मैं एक recent interaction के बारे में follow-up कर रहा हूँ — क्या आपके पास एक मिनट है यह बताने के लिए कि अनुभव कैसा रहा?",
    hinglish:
      "Hi, main {{merchant_name}} se {{agent_name}} baat kar raha hoon. Main ek recent interaction ke baare mein follow-up kar raha hoon — kya aapke paas ek minute hai yeh batane ke liye ki experience kaisa raha?",
  },
};

/**
 * Resolves the greeting the caller should hear, given the agent's configured language.
 *  - English (or no language) → the canonical English `literalGreetingTemplate` (englishFallback).
 *  - A language with an audited translation (hi / hinglish for insurance) → that translation.
 *  - Any other language (e.g. Marathi, for which no audited insurance greeting exists) →
 *    undefined, so the canned English line is NOT spoken through a non-English voice; the LLM
 *    greets in the configured language instead.
 */
export function resolveLocalizedGreeting(
  templateKey: string | undefined,
  language: string | undefined,
  englishFallback: string | undefined,
): string | undefined {
  const lang = (language ?? "en").toLowerCase();
  if (lang === "en") return englishFallback;
  if (!templateKey) return undefined;
  return INSURANCE_GREETINGS[templateKey]?.[lang];
}
