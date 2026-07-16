/**
 * Recording/AI disclosure — meant to be spoken at the start of every call
 * whenever recording is on (default), satisfying the baseline pattern most
 * jurisdictions require: two-party-consent US states, GDPR Art. 6 lawful
 * basis for processing, and the EU AI Act Art. 50 requirement to disclose
 * that the caller is interacting with an AI system.
 *
 * Enforced by default (opt-out via config, not opt-in) so compliance is the
 * out-of-the-box behavior, not something a developer has to remember to wire
 * in per deployment. Environment-variable driven for zero-config use, but
 * every value can be passed explicitly instead if you don't want this
 * package reading process.env directly (e.g. in a non-Node runtime).
 */
export type ConsentOptions = {
  enabled?: boolean;
  disclosureText?: string;
  /**
   * BCP-47-ish language code for the call (matches the agent frame's
   * `language`, e.g. "en", "hi", "mr", "multi"). Selects a language-matched
   * disclosure line so the AI/recording notice is spoken in the same language
   * the rest of the call will be — a disclosure the caller can't understand
   * doesn't satisfy the "clearly informed" bar most jurisdictions require.
   * Unknown/unsupported codes fall back to English. Ignored when an explicit
   * `disclosureText` (or RECORDING_DISCLOSURE_TEXT) is provided.
   */
  language?: string;
};

/**
 * Per-language disclosure lines. English is the canonical/fallback wording;
 * `hi` (Devanagari Hindi) and `hinglish` (Roman-script Hindi, common in Indian
 * support calls) cover the primary India market. All variants say the same
 * two things — the call may be recorded, and the other party is an AI — so the
 * legal substance is identical regardless of which language is spoken.
 * Add more entries as scripts/markets expand (mr, ta, te, … are English today).
 */
const DEFAULT_DISCLOSURE_TEXT =
  "Quick heads up before we start — this call may be recorded, and you're speaking with an AI assistant.";

const DISCLOSURE_TEXT: Record<string, string> = {
  en: DEFAULT_DISCLOSURE_TEXT,
  hi: "शुरू करने से पहले एक छोटी सी बात — यह कॉल रिकॉर्ड की जा सकती है, और आप एक एआई असिस्टेंट से बात कर रहे हैं।",
  hinglish:
    "Shuru karne se pehle ek chhoti si baat — yeh call record ho sakti hai, aur aap ek AI assistant se baat kar rahe hain.",
};

/** Maps a call `language` code to a disclosure-text key, English otherwise. */
function disclosureKeyForLanguage(language?: string): string {
  if (!language) return "en";
  const normalized = language.trim().toLowerCase();
  if (normalized in DISCLOSURE_TEXT) return normalized;
  // "en-IN", "hi-Latn" etc. → match on the primary subtag.
  const primary = normalized.split(/[-_]/)[0];
  if (primary && primary in DISCLOSURE_TEXT) return primary;
  return "en";
}

export function isDisclosureEnabled(options: ConsentOptions = {}): boolean {
  if (options.enabled !== undefined) return options.enabled;
  if (typeof process !== "undefined" && process.env?.RECORDING_DISCLOSURE_ENABLED === "false") return false;
  return true;
}

export function getDisclosureLine(options: ConsentOptions = {}): string {
  // Explicit overrides win over language selection — a deployment that pins its
  // own wording (or an org with a custom line) shouldn't be silently swapped.
  if (options.disclosureText) return options.disclosureText;
  if (typeof process !== "undefined" && process.env?.RECORDING_DISCLOSURE_TEXT) {
    return process.env.RECORDING_DISCLOSURE_TEXT;
  }
  return DISCLOSURE_TEXT[disclosureKeyForLanguage(options.language)] ?? DEFAULT_DISCLOSURE_TEXT;
}

/**
 * A short, stable tag for WHICH disclosure wording a call used, meant to be
 * stored per call (calls.disclosure_version) alongside the spoken text so an
 * audit can group/verify by variant. Returns the language key ("en"/"hi"/
 * "hinglish") for a built-in line, or "custom" when an explicit override
 * (options.disclosureText or RECORDING_DISCLOSURE_TEXT) is in force — in that
 * case the language key wouldn't describe the actual words spoken.
 */
export function getDisclosureVersion(options: ConsentOptions = {}): string {
  if (options.disclosureText) return "custom";
  if (typeof process !== "undefined" && process.env?.RECORDING_DISCLOSURE_TEXT) {
    return "custom";
  }
  return disclosureKeyForLanguage(options.language);
}

/** Prepends the disclosure instruction to a persona/system prompt string. */
export function withDisclosure(personaInstructions: string, options: ConsentOptions = {}): string {
  if (!isDisclosureEnabled(options)) return personaInstructions;
  return `${personaInstructions}\n\nAt the very start of the call, before anything else, say this near-verbatim: "${getDisclosureLine(options)}"`;
}
